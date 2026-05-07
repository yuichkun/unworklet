<script setup>
const tryItCode0 = `import {
  defineProcessor, audioOutput, param, state, forSample, num, select, flushDenormals,
} from "@unworklet/core";

// Kick = sine carrier whose pitch and amplitude both decay exponentially.
//
// trigger = a transient parameter: ≥ 0.5 retriggers the kick.  Drop it
// below 0.5, then drag back up to fire another kick.
export const kickDrum = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  const trigger = param({
    name: "trigger", default: 1, min: 0, max: 1, automationRate: "k-rate",
  });
  const startHz = param({
    name: "startHz", default: 150, min: 60, max: 400, automationRate: "k-rate",
  });
  const endHz = param({
    name: "endHz", default: 50, min: 20, max: 120, automationRate: "k-rate",
  });
  const pitchDecayMs = param({
    name: "pitchDecayMs", default: 60, min: 5, max: 500, automationRate: "k-rate",
  });
  const ampDecayMs = param({
    name: "ampDecayMs", default: 200, min: 30, max: 1000, automationRate: "k-rate",
  });

  const phase = state.f32(0, { name: "phase" });
  // Both envelopes decay from 1 → 0 each trigger. We store them as
  // f32 so the WASM exp() output flows naturally.
  const pitchEnv = state.f32(1, { name: "pitchEnv" });
  const ampEnv = state.f32(1, { name: "ampEnv" });
  const wasArmed = state.bool(false, { name: "wasArmed" });

  return {
    process: () => {
      // Detect rising edge of trigger ≥ 0.5
      const armed = trigger.at(0).gte(0.5);
      const fire = select(armed, wasArmed.load().eq(false), false); // armed && !wasArmed
      // On fire: reset phase + envelopes to 1.0
      pitchEnv.store(select(fire, 1, pitchEnv.load()));
      ampEnv.store(select(fire, 1, ampEnv.load()));
      phase.store(select(fire, 0, phase.load()));
      wasArmed.store(armed);

      // Decay coefficients: e^(-1/ms·sr/1000) per sample → multiplicative decay
      const pitchKeep = num(-1).div(pitchDecayMs.at(0).mul(ctx.sampleRate / 1000)).exp();
      const ampKeep = num(-1).div(ampDecayMs.at(0).mul(ctx.sampleRate / 1000)).exp();

      const TWO_PI = 2 * Math.PI;
      const fEnd = endHz.at(0);
      const fSpan = startHz.at(0).sub(fEnd);

      forSample((i) => {
        // Pitch envelope: starts 1, decays toward 0.
        const pe = flushDenormals(pitchEnv.load().mul(pitchKeep));
        pitchEnv.store(pe);
        // Current frequency = endHz + pitchEnv × (startHz - endHz)
        const fHz = fEnd.add(pe.mul(fSpan));
        // Advance phase
        const next = phase.load().add(fHz.mul(TWO_PI / ctx.sampleRate)).mod(TWO_PI);
        phase.store(next);

        // Amp envelope: starts 1, decays toward 0.
        const ae = flushDenormals(ampEnv.load().mul(ampKeep));
        ampEnv.store(ae);

        out.set(0, i, next.sin().mul(ae).mul(0.7));
      });
    },
  };
});
`;
const tryItCode1 = `import {
  defineProcessor, audioOutput, param, state, forSample, num, select, flushDenormals,
} from "@unworklet/core";

// Hi-hat = bandpassed white noise with a fast amp envelope.
export const hiHat = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  const trigger = param({
    name: "trigger", default: 1, min: 0, max: 1, automationRate: "k-rate",
  });
  const decayMs = param({
    name: "decayMs", default: 80, min: 10, max: 500, automationRate: "k-rate",
  });
  const tone = param({
    name: "tone", default: 0.5, min: 0, max: 1, automationRate: "k-rate",
  });

  // Linear-congruential PRNG state — cheap, deterministic, no allocations.
  const rngState = state.i32(0xCAFEF00D | 0, { name: "rng" });
  const ampEnv = state.f32(0, { name: "ampEnv" });
  const wasArmed = state.bool(false, { name: "wasArmed" });

  // Two cascaded one-pole HPFs to make a "metallic" hi-hat-ish noise.
  const hp1 = state.f32(0, { name: "hp1" });
  const hp2 = state.f32(0, { name: "hp2" });
  const lp1 = state.f32(0, { name: "lp1" });

  return {
    process: () => {
      const armed = trigger.at(0).gte(0.5);
      const fire = select(armed, wasArmed.load().eq(false), false);
      ampEnv.store(select(fire, 1, ampEnv.load()));
      wasArmed.store(armed);

      // Multiplicative decay
      const ampKeep = num(-1).div(decayMs.at(0).mul(ctx.sampleRate / 1000)).exp();
      // tone 0..1 → cutoff 800..8000 Hz
      const cutHz = tone.at(0).mul(7200).add(800);
      // One-pole coefficient k = 1 - exp(-2π fc / sr)
      const k = num(1).sub(cutHz.mul(-2 * Math.PI / ctx.sampleRate).exp());

      forSample((i) => {
        // PRNG: Lehmer LCG (multiply, shift, mask). Output as f32 in [-1,1].
        const r = rngState.load().mul(1103515245).add(12345);
        rngState.store(r);
        // 32-bit int → roughly uniform float in [-1, 1)
        const noise = r.toF32().mul(1 / 2147483648);

        // High-pass twice (subtract LP component) → bright, edgy noise.
        const lp1New = flushDenormals(lp1.load().add(k.mul(noise.sub(lp1.load()))));
        lp1.store(lp1New);
        const hp = noise.sub(lp1New);
        // Second-order shape: cascade another HPF on hp
        const hp1New = flushDenormals(hp1.load().add(k.mul(hp.sub(hp1.load()))));
        hp1.store(hp1New);
        const hp2New = hp.sub(hp1New);
        hp2.store(hp2New);

        // Decay the env, multiply against shaped noise.
        const ae = flushDenormals(ampEnv.load().mul(ampKeep));
        ampEnv.store(ae);

        out.set(0, i, hp2New.mul(ae).mul(0.5));
      });
    },
  };
});
`;
const tryItCode2 = `import {
  defineProcessor, audioOutput, param, state, forSample, num, select, flushDenormals,
} from "@unworklet/core";

// Self-driving 4-on-the-floor: kick on every beat, hat on every off-beat.
//
// 16 steps per bar × user-tunable tempo.  Each step holds a kick-flag and
// a hat-flag; on beat boundaries we zero & retrigger the corresponding
// envelopes, so the whole thing plays itself.
export const drumMachine = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  const bpm = param({
    name: "bpm", default: 120, min: 40, max: 200, automationRate: "k-rate",
  });
  const kickGain = param({
    name: "kickGain", default: 1, min: 0, max: 1.5, automationRate: "k-rate",
  });
  const hatGain = param({
    name: "hatGain", default: 0.5, min: 0, max: 1.5, automationRate: "k-rate",
  });

  // 16 steps × (kick, hat) — encoded as parameters so the user can
  // toggle them live.  Pattern is fixed for clarity here; in a real
  // app you'd send them via message<{ steps: Int32Array }>().
  // Default: kick on 1,5,9,13;  hat on 3,7,11,15.
  const KICK_STEPS = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const HAT_STEPS  = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0];

  const stepIdx = state.i32(0, { name: "stepIdx" });
  const sampleAccum = state.i32(0, { name: "sampleAccum" });
  const kickPhase = state.f32(0, { name: "kickPhase" });
  const kickPitchEnv = state.f32(0, { name: "kickPitchEnv" });
  const kickAmpEnv = state.f32(0, { name: "kickAmpEnv" });
  const hatRng = state.i32(0xDEADBEEF | 0, { name: "hatRng" });
  const hatLp = state.f32(0, { name: "hatLp" });
  const hatHp = state.f32(0, { name: "hatHp" });
  const hatEnv = state.f32(0, { name: "hatEnv" });

  return {
    process: () => {
      // Each 16th-note step = sr × 60 / bpm / 4 samples.
      const stepSamples = num(60).div(bpm.at(0)).mul(ctx.sampleRate / 4).toI32();
      const TWO_PI = 2 * Math.PI;
      const kickStartHz = num(150);
      const kickEndHz = num(50);
      const kickPitchDecaySamples = num(0.06).mul(ctx.sampleRate); // 60ms
      const kickAmpDecaySamples = num(0.2).mul(ctx.sampleRate);    // 200ms
      const hatDecaySamples = num(0.08).mul(ctx.sampleRate);       // 80ms
      const kickPitchKeep = num(-1).div(kickPitchDecaySamples).exp();
      const kickAmpKeep = num(-1).div(kickAmpDecaySamples).exp();
      const hatAmpKeep = num(-1).div(hatDecaySamples).exp();
      // Hat noise filter (~6 kHz HP)
      const k = num(1).sub(num(-2 * Math.PI * 6000).div(ctx.sampleRate).exp());

      forSample((i) => {
        // Beat tick: when sampleAccum reaches stepSamples, advance step
        // and (optionally) retrigger drums.
        const acc = sampleAccum.load().add(1);
        const tick = acc.gte(stepSamples);
        sampleAccum.store(select(tick, 0, acc));

        // Compute next step index branchlessly.
        const nextStep = stepIdx.load().add(1).mod(16);
        stepIdx.store(select(tick, nextStep, stepIdx.load()));

        // Build a "kick fires this step" flag from the static pattern,
        // gated by the tick.  Static loop = compile-time fan-out.
        let kickFire = num(false);
        let hatFire = num(false);
        for (let s = 0; s < 16; s++) {
          const isThisStep = nextStep.eq(s);
          if (KICK_STEPS[s]) kickFire = select(isThisStep, true, kickFire);
          if (HAT_STEPS[s])  hatFire  = select(isThisStep, true, hatFire);
        }
        kickFire = select(tick, kickFire, false);
        hatFire = select(tick, hatFire, false);

        // Retrigger envelopes on fire.
        kickPhase.store(select(kickFire, 0, kickPhase.load()));
        kickPitchEnv.store(select(kickFire, 1, kickPitchEnv.load()));
        kickAmpEnv.store(select(kickFire, 1, kickAmpEnv.load()));
        hatEnv.store(select(hatFire, 1, hatEnv.load()));

        // === Kick voice ===
        const pe = flushDenormals(kickPitchEnv.load().mul(kickPitchKeep));
        kickPitchEnv.store(pe);
        const fHz = kickEndHz.add(pe.mul(kickStartHz.sub(kickEndHz)));
        const kp = kickPhase.load().add(fHz.mul(TWO_PI / ctx.sampleRate)).mod(TWO_PI);
        kickPhase.store(kp);
        const kAmp = flushDenormals(kickAmpEnv.load().mul(kickAmpKeep));
        kickAmpEnv.store(kAmp);
        const kickSig = kp.sin().mul(kAmp).mul(kickGain.at(0)).mul(0.6);

        // === Hat voice ===
        const r = hatRng.load().mul(1103515245).add(12345);
        hatRng.store(r);
        const noise = r.toF32().mul(1 / 2147483648);
        const lpNew = flushDenormals(hatLp.load().add(k.mul(noise.sub(hatLp.load()))));
        hatLp.store(lpNew);
        const hp = noise.sub(lpNew);
        const hpAcc = flushDenormals(hatHp.load().add(k.mul(hp.sub(hatHp.load()))));
        hatHp.store(hpAcc);
        const hShaped = hp.sub(hpAcc);
        const hAmp = flushDenormals(hatEnv.load().mul(hatAmpKeep));
        hatEnv.store(hAmp);
        const hatSig = hShaped.mul(hAmp).mul(hatGain.at(0)).mul(0.5);

        out.set(0, i, kickSig.add(hatSig));
      });
    },
  };
});
`;
</script>

# Build a drum machine

Now for percussion. Drums in DSP are *short envelopes around something noisy or impulsive*. We'll build:

1. A **kick** — a sine wave whose pitch and amplitude both fall away in the first 200 ms.
2. A **hi-hat** — bandpassed white noise with a fast envelope.
3. A **drum machine** — both voices on a 16-step pattern that plays itself.

By the end you'll have a self-driving "120 BPM" four-on-the-floor that runs in real WASM in your browser.

## 1. Kick from a sine

A real kick drum's most prominent feature, audibly, is the *pitch envelope*: it starts around 150 Hz and drops to maybe 50 Hz in ~60 ms. That falling pitch is what makes "boom" rather than "beep". Combined with an exponential amplitude decay, you get a recognisable thump.

We need:

- A sine oscillator (you've already built this).
- Two state slots for the *envelopes* — the pitch envelope and the amp envelope, each starting at 1 and exponentially decaying to 0.
- A trigger mechanism — drag the `trigger` slider above 0.5 to fire a hit.

<TryIt label="step 1: kick" size="tall" :code="tryItCode0" source="silent" />

You should hear a kick drum on Run, then again every time you drop the trigger slider to 0 and bring it back to 1.

::: tip Exponential decay = multiply by a constant
A one-pole release envelope is the same one-pole filter you've been using, but with no input.  `e[n+1] = e[n] × keep` where `keep = exp(-1 / decaySamples)` is just under 1. The math is identical to "every sample, multiply by 0.9999". After 200 ms × 48 kHz samples, the value is essentially zero.

`flushDenormals` matters a lot here — without it, the env decays through subnormal floats and the audio thread chokes once the kick has "ended".
:::

Try:
- `startHz=200, endHz=40, pitchDecay=80, ampDecay=300` — long, deep boom.
- `startHz=400, endHz=100, pitchDecay=20, ampDecay=80` — punchy snare-ish click.
- `startHz=80, endHz=80, pitchDecay=20, ampDecay=600` — sustained sub-bass tone (because pitch isn't moving).

## 2. Hat from noise

A hi-hat is the opposite of a kick: no pitch, all noise, very fast decay, harsh top end. Recipe:

- A pseudorandom-noise generator (LCG — multiply, add, store).
- A high-pass to keep only the bright frequencies.
- A short amp envelope.

<TryIt label="step 2: hi-hat" size="tall" :code="tryItCode1" source="silent" />

The PRNG is just three operations per sample — multiply, add, store. The result is a 32-bit int we cast to f32 and divide by 2³¹ to get noise in `[-1, 1)`. Two cascaded high-pass filters (subtract the low-pass component twice) give that "metallic, edgy" character you want for a hat or shaker.

Drag **tone** to slide the high-pass cutoff: low values are darker (closer to brown noise), high values are airy and thin.

::: tip Why a manual PRNG instead of `Math.random`?
The audio thread can't call `Math.random` cheaply (and definitely not in WASM where there's no JS/host bridge per call). A linear-congruential generator is three integer ops, deterministic, and bit-perfectly reproducible across runs. Real synthesisers do this. The constants `1103515245` / `12345` come straight from the C standard library.
:::

## 3. Self-playing drum machine

Now combine kick + hat into a 16-step sequencer. We don't need MIDI for this — we'll just count samples and tick a step counter.

- 16th-note duration = `60 / bpm / 4 × sampleRate` samples.
- A `sampleAccum` counter wraps every step duration; the wrap is a "tick" event.
- Each step has a static kick-flag and hat-flag (kick on 1, 5, 9, 13; hat on 3, 7, 11, 15 — classic four-on-the-floor with off-beat hat).
- On a tick, we use a JS `for` loop over the 16 steps to fan out the pattern at compile time. That's it — the framework unrolls the loop into the captured graph.

<TryIt label="step 3: drum machine" size="tall" :code="tryItCode2" source="silent" />

Hit Run and you should hear a steady kick-hat-kick-hat-kick-hat-kick-hat at 120 BPM. Drag the **bpm** slider to change tempo while it plays. Adjust kick / hat gain to mix them.

This is real, captured, compiled WASM — no JS scheduler involved. The "sequencer" is just integer arithmetic in the per-sample loop.

::: tip Where to take it next
- **Live patterns**: replace the static `KICK_STEPS` / `HAT_STEPS` arrays with `message<{ steps: Int32Array }>()` so the host can ship updated patterns to the audio thread. See [Messages + events](./messages-events).
- **Velocity**: store one f32 per step instead of one bool — read the velocity from the step at trigger time, scale the env target.
- **More voices**: add a snare (sine + filtered noise + short env) and a clap (multiple staggered noise bursts) using the same pattern.
- **Swing**: vary `stepSamples` per step in a 16-step pattern — odd steps slightly delayed.
:::

## What you've learned

- **Drum synthesis = envelopes around something simple**: a sine with a pitch decay = kick; HP-filtered noise with a fast decay = hat.
- **Trigger detection**: state-machine pattern (`wasArmed` flag + rising-edge check via `select(armed, !wasArmed, false)`) is how a single boolean parameter becomes a discrete event.
- **PRNG on the audio thread**: a Lehmer LCG is three ops, deterministic, allocation-free.
- **Compile-time fan-out**: a JS `for (let s = 0; s < 16; s++)` loop inside `forSample` is unrolled by the capture machinery into 16 explicit graph statements. The runtime sees a single tight WASM loop, no dynamic indexing.
- **Self-driving rhythm**: a sample counter + step index + static pattern = a complete sequencer in 30 lines.

## Next

- [Subgraphs](./subgraphs) — wrap each drum voice in a `defineSubgraph` so you can have multiple kicks at different pitches without copy-pasting state.
- [MIDI](./midi) — drive the drum machine from a hardware controller's pads.
- [Snapshot + restore](./snapshots) — save your pattern as a preset.
