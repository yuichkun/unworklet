<script setup>
const tryItCode0 = `import {
  defineProcessor, audioOutput, state, forSample,
} from "@unworklet/core";

// Make a 220Hz sine wave from nothing.
export const myFirstSound = defineProcessor((ctx) => {
  // 1. Declare an output port. (No input — we're synthesising sound.)
  const out = audioOutput({ channels: 1, name: "main" });

  // 2. State for the oscillator phase. Persists across blocks.
  const phase = state.f32(0, { name: "phase" });

  // 3. Phase increment per sample to hit 220 Hz at this sample rate:
  //    inc = 2π × frequency / sampleRate
  const inc = 2 * Math.PI * 220 / ctx.sampleRate;
  const TWO_PI = 2 * Math.PI;

  return {
    process: () => {
      forSample((i) => {
        // Advance phase, wrap at 2π via modulo so it doesn't drift to
        // infinity. .mod(b) reads as "this modulo b" — DSP-flow order.
        const next = phase.load().add(inc).mod(TWO_PI);
        phase.store(next);

        // Output sin(phase) at half amplitude so it doesn't clip.
        out.set(0, i, next.sin().mul(0.5));
      });
    },
  };
});
`;
const tryItCode1 = `import {
  defineProcessor, audioOutput, param, state, forSample, num, select,
} from "@unworklet/core";

export const tunableSine = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  const freq = param({
    name: "freq", default: 220, min: 55, max: 1760, automationRate: "k-rate",
  });
  const phase = state.f32(0, { name: "phase" });
  const TWO_PI = 2 * Math.PI;

  return {
    process: () => {
      // freq.at(0) is the current k-rate value. Scale to phase increment.
      const inc = freq.at(0).mul(TWO_PI / ctx.sampleRate);
      forSample((i) => {
        const next = phase.load().add(inc);
        phase.store(select(next.gte(TWO_PI), next.sub(TWO_PI), next));
        out.set(0, i, phase.load().sin().mul(0.5));
      });
    },
  };
});
`;
const tryItCode2 = `import {
  defineProcessor, audioOutput, param, state, forSample, num, select,
} from "@unworklet/core";

// Sine voice with a tremolo (LFO-modulated amplitude).
export const tremoloSine = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  const freq = param({
    name: "freq", default: 220, min: 55, max: 1760, automationRate: "k-rate",
  });
  const tremRateHz = param({
    name: "tremRate", default: 5, min: 0.1, max: 20, automationRate: "k-rate",
  });
  const tremDepth = param({
    name: "tremDepth", default: 0.6, min: 0, max: 1, automationRate: "k-rate",
  });

  // Two oscillator phases — one for the carrier (the audible tone), one
  // for the LFO (slow, sub-audio rate).
  const phase = state.f32(0, { name: "phase" });
  const lfoPhase = state.f32(0, { name: "lfoPhase" });
  const TWO_PI = 2 * Math.PI;

  return {
    process: () => {
      const inc = freq.at(0).mul(TWO_PI / ctx.sampleRate);
      const lfoInc = tremRateHz.at(0).mul(TWO_PI / ctx.sampleRate);
      const depth = tremDepth.at(0);

      forSample((i) => {
        // Advance both phases.
        const p = phase.load().add(inc);
        phase.store(select(p.gte(TWO_PI), p.sub(TWO_PI), p));
        const lp = lfoPhase.load().add(lfoInc);
        lfoPhase.store(select(lp.gte(TWO_PI), lp.sub(TWO_PI), lp));

        // tremolo gain = 1 - depth × (1 - sin(lfo))/2  → ranges (1-depth) … 1
        const tremGain = num(1).sub(depth.mul(num(1).sub(lp.sin()).mul(0.5)));
        out.set(0, i, p.sin().mul(0.5).mul(tremGain));
      });
    },
  };
});
`;
const tryItCode3 = `import {
  defineProcessor, audioOutput, param, state, forSample, num, select, flushDenormals,
} from "@unworklet/core";

// Sine + tremolo + one-pole low-pass for tone control.
export const fullSynthVoice = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  const freq = param({
    name: "freq", default: 220, min: 55, max: 1760, automationRate: "k-rate",
  });
  const tremRateHz = param({
    name: "tremRate", default: 4, min: 0.1, max: 20, automationRate: "k-rate",
  });
  const tremDepth = param({
    name: "tremDepth", default: 0.5, min: 0, max: 1, automationRate: "k-rate",
  });
  const cutoff = param({
    name: "cutoff", default: 0.5, min: 0.01, max: 0.999, automationRate: "k-rate",
  });

  const phase = state.f32(0, { name: "phase" });
  const lfoPhase = state.f32(0, { name: "lfoPhase" });
  const lp = state.f32(0, { name: "lp" });
  const TWO_PI = 2 * Math.PI;

  return {
    process: () => {
      const inc = freq.at(0).mul(TWO_PI / ctx.sampleRate);
      const lfoInc = tremRateHz.at(0).mul(TWO_PI / ctx.sampleRate);
      const depth = tremDepth.at(0);
      const k = cutoff.at(0);

      forSample((i) => {
        const p = phase.load().add(inc);
        phase.store(select(p.gte(TWO_PI), p.sub(TWO_PI), p));
        const lpP = lfoPhase.load().add(lfoInc);
        lfoPhase.store(select(lpP.gte(TWO_PI), lpP.sub(TWO_PI), lpP));

        // Carrier × tremolo
        const dry = p.sin().mul(0.5);
        const tremGain = num(1).sub(depth.mul(num(1).sub(lpP.sin()).mul(0.5)));
        const wet = dry.mul(tremGain);

        // One-pole LP:  y = y₋₁ + k × (x - y₋₁)
        const filtered = flushDenormals(lp.load().add(k.mul(wet.sub(lp.load()))));
        lp.store(filtered);

        out.set(0, i, filtered);
      });
    },
  };
});
`;
</script>

# Your first processor — make a sine wave

This walkthrough builds a synth voice from nothing — first a pure sine wave, then frequency control, then tremolo, then a tone-shaping filter. By the end you'll have a four-knob instrument you can play with the sliders.

Every block below is a real processor: hit **Run**, hear sound, drag the sliders, watch the meter, edit the code, hit **Run** again. Real WASM, real `AudioWorkletProcessor`, no faking.

## 1. Hello, sine wave

The simplest way to make a sound is to advance a phase, take its sine, and push the result to the output. That's it — three operations per sample.

<TryIt label="step 1: 220 Hz sine" size="tall" :code="tryItCode0" source="silent" />

Hit Run. You should hear a clean 220 Hz tone (an A3, just below middle C). Walk through the body line by line:

- **`audioOutput({ channels: 1, name: "main" })`** — declares one mono output port. `name: "main"` is the key the host uses (`node.outputs.main`); a synth voice typically only has outputs.
- **`state.f32(0, { name: "phase" })`** — a single 32-bit float in linear memory, initialised to zero. State persists across `process()` calls — that's how the oscillator remembers where it was.
- **`forSample((i) => …)`** — runs the body once for each sample in the render block (128 by default). The `i` is the per-sample index, a graph node, not a JS integer.
- **`phase.load().add(inc)`** — chain methods read in the order operations happen: load the current phase, add the per-sample increment, get the new phase.
- **`select(next.gte(TWO_PI), next.sub(TWO_PI), next)`** — branchless ternary. JS `?:` can't operate on graph nodes; `select` lowers to a single WASM `select` instruction.
- **`phase.load().sin().mul(0.5)`** — read the (just-stored) phase, take sine, halve the amplitude so the output stays in `[-0.5, 0.5]` and doesn't clip.

::: tip Why the `select` instead of `if`?
Inside a captured `forSample` body, every value is a graph node — JS branching never sees the runtime values, and `next > TWO_PI` would always evaluate truthy at capture time (graph nodes are objects). `select(cond, a, b)` is the unworklet equivalent of a branchless ternary; the WASM compiler emits a single `select` instruction.

The framework throws a clear error with a refactor hint if you forget — try replacing the `select` line with a JS `?:` and hit Run.
:::

## 2. Add a frequency knob

The 220 Hz constant is built into the code. Let's expose it as an `AudioParam` so the host can drag it.

<TryIt label="step 2: tunable sine" size="tall" :code="tryItCode1" source="silent" />

Hit Run, then drag the **freq** slider. The pitch slides smoothly because `param` is a real `AudioParam` — the host's automation lane handles the smoothing for free. Try `setValueAtTime` from the main thread, connect an `OscillatorNode` to it as an LFO, hook it up to a knob in your UI: it all just works because `node.params.freq` is the same `AudioParam` you'd get from `OscillatorNode.frequency`.

::: tip a-rate vs k-rate
`automationRate: "k-rate"` means the param is a single value per render block (128 samples). For a frequency that changes maybe a few times a second, that's fine. For a vibrato target or a per-sample envelope, use `"a-rate"` and read with `freq.at(i)` instead of `freq.at(0)`. See [Parameters](./parameters).
:::

## 3. Add tremolo (an LFO)

A pure sine is mathematically perfect and musically boring. Let's modulate its amplitude with a slower sine — a low-frequency oscillator. Two phase accumulators, one fast (the carrier), one slow (the LFO).

<TryIt label="step 3: tremolo" size="tall" :code="tryItCode2" source="silent" />

The new bits:

- A second `state.f32` for the LFO phase, advancing at sub-audio rates (default 5 Hz).
- The amplitude is multiplied by `1 - depth × (1 - sin(lfo))/2`, which oscillates between `1 - depth` and `1`. At `depth = 0` the modulation is zero (constant amplitude); at `depth = 1` the amplitude swings all the way to silence on each LFO peak.

Drag **tremRate** and **tremDepth** while it plays. Crank tremRate to ~15 Hz for a "vintage tremolo pedal" effect; bring it below 1 Hz for a slow swell.

::: tip This is how every classic effect is built
LFO-modulated amplitude → tremolo. LFO-modulated pitch → vibrato. LFO-modulated delay-time → chorus / flanger. LFO-modulated filter cutoff → wah / auto-filter. The pattern is identical — only the *target* changes.
:::

## 4. Add a tone control (one-pole LP)

The sine has only one frequency component, but tremolo introduces small amplitude transients that benefit from a soft low-pass. More importantly, this is the simplest filter you'll ever build, and you'll use it everywhere.

The math:

```
y[n] = y[n-1] + k × (x[n] - y[n-1])
```

`k ∈ (0, 1)`. Smaller k → slower response, more low-pass cut. Larger k → closer to passthrough.

<TryIt label="step 4: full voice" size="tall" :code="tryItCode3" source="silent" />

You now have a four-knob synth voice:
- **freq** — pitch
- **tremRate** — modulation speed
- **tremDepth** — modulation amount
- **cutoff** — tone (close it for "warm", open it for "bright")

Drag them while it plays. Try freq = 110 + cutoff = 0.05 + tremRate = 2 + tremDepth = 0.7 — that's a slow ambient drone.

The new line worth noting:

```ts
const filtered = flushDenormals(lp.load().add(k.mul(wet.sub(lp.load()))));
```

`flushDenormals(x)` zeros out values smaller than 1e-30. When the input goes silent, the filter state would otherwise decay through subnormal floats, and on x86 CPUs without FTZ enabled by default, subnormal arithmetic is *catastrophically* slow — slow enough to cause audio glitches. See [Denormals](./denormals) for the gritty detail.

## What you've learned

- `defineProcessor` is the entry point.
- Sound comes out of `audioOutput`. (No input needed for synthesis.)
- `state.<type>` is your persistent memory — oscillator phases, filter state, envelope levels.
- `param` exposes a real Web Audio `AudioParam`. Drag it from the host, connect LFOs to it, schedule automation curves on it.
- `forSample((i) => …)` is the per-sample loop, captured into a tight WASM block.
- Chain methods (`.add`, `.mul`, `.sin`, …) read in DSP-flow order. Free functions (`add`, `mul`, …) are equivalent.
- `select(cond, a, b)` is branchless ternary on graph nodes.
- `flushDenormals(x)` keeps feedback paths alive on x86 CPUs.

## Next

You've built a synth voice. Now make it polyphonic and sequenced:

- [Build a synth](./build-a-synth) — ADSR envelope, resonant filter, MIDI input. ~50 lines for a real instrument.
- [Build a drum machine](./build-a-drum) — kick from a sine, hi-hat from filtered noise, 16-step sequencer.
- [Audio I/O](./audio-io) — how to take audio *in* (effects processors).
- [State + buffers](./state-and-buffers) — bigger memory: delay lines, sample buffers, IRs.
- [Subgraphs](./subgraphs) — factor out reusable DSP pieces and let the framework give each instance its own state.
