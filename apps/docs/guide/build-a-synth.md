<script setup>
const tryItCode0 = `import {
  defineProcessor, audioOutput, param, state, forSample, num, select,
} from "@unworklet/core";

// Two detuned saws stacked and summed. The "fat lead" starting point.
export const dualSaw = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  const freq = param({
    name: "freq", default: 110, min: 55, max: 880, automationRate: "k-rate",
  });
  const detuneCents = param({
    name: "detune", default: 7, min: 0, max: 50, automationRate: "k-rate",
  });

  const phaseA = state.f32(0, { name: "phaseA" });
  const phaseB = state.f32(0.5, { name: "phaseB" });   // start out of phase

  return {
    process: () => {
      // detune in cents → frequency ratio: 2^(cents/1200)
      const ratio = detuneCents.at(0).mul(Math.LN2 / 1200).exp();
      const fA = freq.at(0);
      const fB = fA.mul(ratio);
      const incA = fA.div(ctx.sampleRate);  // phase in [0, 1) for saw
      const incB = fB.div(ctx.sampleRate);

      forSample((i) => {
        // Advance phases, wrap to [0, 1).
        const pA = phaseA.load().add(incA);
        phaseA.store(select(pA.gte(1), pA.sub(1), pA));
        const pB = phaseB.load().add(incB);
        phaseB.store(select(pB.gte(1), pB.sub(1), pB));

        // Saw = 2 × phase - 1, so it ramps from -1 → +1.
        const sawA = pA.mul(2).sub(1);
        const sawB = pB.mul(2).sub(1);
        out.set(0, i, sawA.add(sawB).mul(0.25));
      });
    },
  };
});
`;
const tryItCode1 = `import {
  defineProcessor, audioOutput, param, state, forSample, num, select, flushDenormals,
} from "@unworklet/core";

// Same two saws + an ADSR triggered by a "gate" parameter.
// gate ≥ 0.5 → attack/decay/sustain.  gate < 0.5 → release.
export const dualSawADSR = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  const freq = param({ name: "freq", default: 110, min: 55, max: 880, automationRate: "k-rate" });
  const detuneCents = param({ name: "detune", default: 7, min: 0, max: 50, automationRate: "k-rate" });
  const gate = param({ name: "gate", default: 1, min: 0, max: 1, automationRate: "k-rate" });
  const attackMs = param({ name: "attackMs", default: 20, min: 1, max: 1000, automationRate: "k-rate" });
  const decayMs = param({ name: "decayMs", default: 200, min: 1, max: 2000, automationRate: "k-rate" });
  const sustainLvl = param({ name: "sustain", default: 0.6, min: 0, max: 1, automationRate: "k-rate" });
  const releaseMs = param({ name: "releaseMs", default: 300, min: 1, max: 4000, automationRate: "k-rate" });

  const phaseA = state.f32(0, { name: "phaseA" });
  const phaseB = state.f32(0.5, { name: "phaseB" });
  const env = state.f32(0, { name: "env" });
  // Track ADSR stage: 0 = released, 1 = attack, 2 = decay/sustain.
  const stage = state.i32(0, { name: "stage" });

  return {
    process: () => {
      const ratio = detuneCents.at(0).mul(Math.LN2 / 1200).exp();
      const incA = freq.at(0).div(ctx.sampleRate);
      const incB = freq.at(0).mul(ratio).div(ctx.sampleRate);

      // Convert ms → one-pole coefficient: coef = 1 - exp(-1 / (ms × sr / 1000))
      const aCoef = num(1).sub(num(-1).div(attackMs.at(0).mul(ctx.sampleRate / 1000)).exp());
      const dCoef = num(1).sub(num(-1).div(decayMs.at(0).mul(ctx.sampleRate / 1000)).exp());
      const rCoef = num(1).sub(num(-1).div(releaseMs.at(0).mul(ctx.sampleRate / 1000)).exp());

      // Block-rate stage transition driven by the gate parameter.
      // Logical AND between two bool nodes = select(a, b, false).
      const gateOn = gate.at(0).gte(0.5);
      const gateOff = gate.at(0).lt(0.5);
      const wasReleased = stage.load().eq(0);
      const trigger = select(gateOn, wasReleased, false); // gateOn && wasReleased
      // Update stage: trigger → 1 (attack); gateOff → 0 (released); otherwise hold.
      stage.store(select(trigger, 1, select(gateOff, 0, stage.load())));

      forSample((i) => {
        // Advance oscillator phases.
        const pA = phaseA.load().add(incA);
        phaseA.store(select(pA.gte(1), pA.sub(1), pA));
        const pB = phaseB.load().add(incB);
        phaseB.store(select(pB.gte(1), pB.sub(1), pB));

        // ADSR: target and coefficient depend on the stage, picked branchlessly.
        const e = env.load();
        const inAttack = stage.load().eq(1);
        const isReleased = stage.load().eq(0);
        const target = select(isReleased, 0, select(inAttack, 1, sustainLvl.at(0)));
        const coef = select(isReleased, rCoef, select(inAttack, aCoef, dCoef));
        const newE = flushDenormals(e.add(coef.mul(target.sub(e))));
        env.store(newE);
        // When env reaches 0.99 during attack, advance to decay/sustain.
        const advance = select(inAttack, newE.gte(0.99), false);
        stage.store(select(advance, 2, stage.load()));

        const sawA = pA.mul(2).sub(1);
        const sawB = pB.mul(2).sub(1);
        out.set(0, i, sawA.add(sawB).mul(0.25).mul(newE));
      });
    },
  };
});
`;
const tryItCode2 = `import {
  defineProcessor, audioOutput, param, state, forSample, num, select, flushDenormals,
} from "@unworklet/core";

// Final voice: detuned saws → resonant low-pass with envelope-controlled cutoff.
export const fullSynth = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  const freq = param({ name: "freq", default: 110, min: 55, max: 880, automationRate: "k-rate" });
  const detuneCents = param({ name: "detune", default: 9, min: 0, max: 50, automationRate: "k-rate" });
  const gate = param({ name: "gate", default: 1, min: 0, max: 1, automationRate: "k-rate" });
  const attackMs = param({ name: "attackMs", default: 5, min: 1, max: 500, automationRate: "k-rate" });
  const decayMs = param({ name: "decayMs", default: 250, min: 1, max: 2000, automationRate: "k-rate" });
  const sustainLvl = param({ name: "sustain", default: 0.0, min: 0, max: 1, automationRate: "k-rate" });
  const releaseMs = param({ name: "releaseMs", default: 200, min: 1, max: 4000, automationRate: "k-rate" });
  const cutoffHz = param({ name: "cutoff", default: 800, min: 50, max: 12000, automationRate: "k-rate" });
  const envMod = param({ name: "envMod", default: 3000, min: 0, max: 8000, automationRate: "k-rate" });
  const resonance = param({ name: "resonance", default: 0.7, min: 0, max: 0.95, automationRate: "k-rate" });

  const phaseA = state.f32(0, { name: "phaseA" });
  const phaseB = state.f32(0.5, { name: "phaseB" });
  const env = state.f32(0, { name: "env" });
  const stage = state.i32(0, { name: "stage" });
  // Two cascaded one-poles + a feedback path = the classic "Moog ladder" lite.
  const lp1 = state.f32(0, { name: "lp1" });
  const lp2 = state.f32(0, { name: "lp2" });

  return {
    process: () => {
      const ratio = detuneCents.at(0).mul(Math.LN2 / 1200).exp();
      const incA = freq.at(0).div(ctx.sampleRate);
      const incB = freq.at(0).mul(ratio).div(ctx.sampleRate);
      const aCoef = num(1).sub(num(-1).div(attackMs.at(0).mul(ctx.sampleRate / 1000)).exp());
      const dCoef = num(1).sub(num(-1).div(decayMs.at(0).mul(ctx.sampleRate / 1000)).exp());
      const rCoef = num(1).sub(num(-1).div(releaseMs.at(0).mul(ctx.sampleRate / 1000)).exp());
      const res = resonance.at(0);

      const gateOn = gate.at(0).gte(0.5);
      const gateOff = gate.at(0).lt(0.5);
      const wasReleased = stage.load().eq(0);
      const trigger = select(gateOn, wasReleased, false);
      stage.store(select(trigger, 1, select(gateOff, 0, stage.load())));

      forSample((i) => {
        const pA = phaseA.load().add(incA);
        phaseA.store(select(pA.gte(1), pA.sub(1), pA));
        const pB = phaseB.load().add(incB);
        phaseB.store(select(pB.gte(1), pB.sub(1), pB));

        const e = env.load();
        const inAttack = stage.load().eq(1);
        const isReleased = stage.load().eq(0);
        const target = select(isReleased, 0, select(inAttack, 1, sustainLvl.at(0)));
        const coef = select(isReleased, rCoef, select(inAttack, aCoef, dCoef));
        const newE = flushDenormals(e.add(coef.mul(target.sub(e))));
        env.store(newE);
        const advance = select(inAttack, newE.gte(0.99), false);
        stage.store(select(advance, 2, stage.load()));

        const sawA = pA.mul(2).sub(1);
        const sawB = pB.mul(2).sub(1);
        const dry = sawA.add(sawB).mul(0.25);

        // Filter cutoff = base + envMod × env.  Convert Hz → one-pole coefficient.
        const fc = cutoffHz.at(0).add(envMod.at(0).mul(newE));
        const k = num(1).sub(fc.mul(-2 * Math.PI / ctx.sampleRate).exp());

        // Two-pole with feedback resonance:
        //   x' = x - res × lp2          (subtract feedback)
        //   lp1 += k × (x' - lp1)
        //   lp2 += k × (lp1 - lp2)
        const fed = dry.sub(res.mul(lp2.load()));
        const lp1New = flushDenormals(lp1.load().add(k.mul(fed.sub(lp1.load()))));
        lp1.store(lp1New);
        const lp2New = flushDenormals(lp2.load().add(k.mul(lp1New.sub(lp2.load()))));
        lp2.store(lp2New);

        out.set(0, i, lp2New.mul(newE));
      });
    },
  };
});
`;
</script>

# Build a synth

You've made [a single sine voice](./your-first-processor) and learned how state, parameters, and `forSample` fit together. Time to build something you'd actually use in a track: a fat detuned-saw lead with an envelope and a resonant filter.

## 1. Two detuned saws

A single saw is a buzzy single tone. Two saws slightly detuned beat against each other and produce that thick "supersaw" sound — every classic 90s lead patch. We need:

- Two phase accumulators (two oscillators)
- A way to turn cents-of-detune into a frequency ratio: `ratio = 2^(cents / 1200)` since 1200 cents = 1 octave.
- A saw waveshape: phase ramps from 0 to 1, the audio output ramps from -1 to +1 → just `2 × phase - 1`.

<TryIt label="step 1: dual saw" size="tall" :code="tryItCode0" source="silent" />

Hit Run, drag **detune** between 0 and 50 cents:
- 0 cents → both saws are identical, you hear a single saw.
- 7-15 cents → classic supersaw chorus.
- 30+ cents → starts to sound out of tune (intentionally so).

::: tip Why amplitude 0.25?
Two summed saws each at amplitude 1 would sum to 2.0 at peaks — that clips. We mix at 0.5 each and apply an extra 0.5 headroom for safety, so output stays in `[-0.5, 0.5]`.
:::

## 2. Add an ADSR envelope

The dual saw plays continuously the moment the processor starts. To make it *playable* — to make individual notes — we wrap the amplitude in an Attack-Decay-Sustain-Release envelope, triggered by a gate parameter.

The trick: treat each `gate ≥ 0.5` rising edge as a note-on, each `gate < 0.5` as a note-off. The envelope walks toward different targets depending on what stage it's in.

<TryIt label="step 2: ADSR" size="tall" :code="tryItCode1" source="silent" />

The **gate** slider starts at 1 (note held) so you hear the attack ramp up to sustain immediately. Drag it down to 0 → release; back up → re-trigger. Tune attack/decay/sustain/release while playing — you'll feel the difference instantly.

The envelope state machine is small: three integer stages (released, attack, decay/sustain). Each sample, the envelope walks toward its target with a one-pole step:

```ts
e[n+1] = e[n] + coef × (target - e[n])
```

`target` and `coef` both depend on the stage, picked branchlessly with `select`.

::: tip In a real app you'd drive `gate` from MIDI
A keyboard's noteOn → `node.params.gate.setValueAtTime(1, atTime)` ; noteOff → `setValueAtTime(0, ...)`. The envelope shape doesn't change — only how the gate is driven. See [MIDI](./midi) for the full pattern.
:::

## 3. Add a resonant filter

The saw itself is bright and fixed. Real synth leads breathe — the filter cutoff opens with the envelope, then closes again on release. The classic Moog "vowel" sweep.

We cascade two one-poles plus a feedback path. The math is short:

```
x' = x - resonance × y2     // subtract feedback from the second pole's output
y1 += k × (x' - y1)          // pole 1
y2 += k × (y1 - y2)          // pole 2
```

When `resonance` is small, this is just a 12 dB/oct LP. When resonance gets close to 1, the filter starts to self-oscillate around its cutoff — that screaming acid-bass quality.

<TryIt label="step 3: full synth" size="tall" :code="tryItCode2" source="silent" />

The synth starts with **gate=1** (note held) so you hear it immediately. Then while it plays:

- **cutoff** — base filter frequency (closed: warm and dull; open: bright)
- **envMod** — how far the filter opens at envelope peak
- **resonance** — emphasis around the cutoff (0.85+ for screaming acid)

A classic "techno bass" patch: freq=55, attack=2, decay=300, sustain=0, release=100, cutoff=200, envMod=4000, resonance=0.85. Toggle the gate and dance.

## What you've learned

- **Multi-oscillator design**: two phases summed for thickness; detune ratio via `2^(cents/1200)`.
- **ADSR envelopes**: a state machine over `stage`, walking the env toward stage-dependent targets with `select`-picked coefficients. No real branches in the captured code.
- **Resonant filter**: cascading one-poles + feedback. `flushDenormals` on every state write to keep x86 happy.
- **Envelope-modulated cutoff**: the same envelope that controls amp also opens and closes the filter — that's where most of the "synth" character lives.

## Next

- Make it polyphonic with [subgraphs](./subgraphs) — each call site of a `defineSubgraph(...)` gets its own state, so you can `voiceSynth(noteHz, gate, ...)` in a loop and have N independent voices.
- Drive it from MIDI: [MIDI](./midi).
- Build a [drum machine](./build-a-drum) — kick, hat, sequencer.
