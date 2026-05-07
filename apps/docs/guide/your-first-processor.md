<script setup>
const tryItCode0 = `import { defineProcessor, audioInput, audioOutput, forSample } from "@unworklet/core";

export const myFirstProcessor = defineProcessor(() => {
  // 1. Declare what flows in and out.
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });

  return {
    // 2. The process phase: runs once per render block (128 samples).
    process: () => {
      // 3. Per-sample loop: runs 128 times per block, captured as a tight WASM loop.
      forSample((i) => {
        // .left / .right are stereo shorthand for .at(0, i) / .at(1, i).
        // Available whenever channels === 2.
        out.left.set(i,  main.left.at(i));
        out.right.set(i, main.right.at(i));
      });
    },
  };
});
`;
const tryItCode1 = `import { defineProcessor, audioInput, audioOutput, param, forSample, mul } from "@unworklet/core";

export const myFirstProcessor = defineProcessor(() => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const gain = param({
    name: "gain",
    default: 0.5,
    min: 0,
    max: 2,
    automationRate: "a-rate",
  });

  return {
    process: () => {
      forSample((i) => {
        const g = gain.at(i);
        out.left.set(i,  mul(main.left.at(i),  g));
        out.right.set(i, mul(main.right.at(i), g));
      });
    },
  };
});
`;
const tryItCode2 = `import { defineProcessor, audioInput, audioOutput, param, state, forSample, mul, max, abs } from "@unworklet/core";

export const myFirstProcessor = defineProcessor(() => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const gain = param({ name: "gain", default: 0.5, min: 0, max: 2, automationRate: "a-rate" });

  const peak = state.f32(0, { name: "peak", publish: { rateFps: 30 } });

  return {
    process: () => {
      forSample((i) => {
        const g = gain.at(i);
        const lOut = mul(main.left.at(i),  g);
        const rOut = mul(main.right.at(i), g);
        out.left.set(i,  lOut);
        out.right.set(i, rOut);
        // Track peak across the block. The publish: { rateFps: 30 }
        // option means main-thread subscribers see this slot at 30 fps.
        peak.store(max(peak.load(), max(abs(lOut), abs(rOut))));
      });
      // Decay the meter so it falls back to 0 between hits.
      // Runs at block boundary, not per sample.
    },
  };
});
`;
const tryItCode3 = `import {
  defineProcessor, defineSubgraph, audioInput, audioOutput, param, state,
  forSample, add, sub, mul, max, abs,
} from "@unworklet/core";

// L1 / L2 split: pure helpers compose; subgraphs own state + per-instance memory.
const oneChannel = defineSubgraph((x, gain, alpha) => {
  const env = state.f32(0);
  const e = add(env.load(), mul(alpha, sub(abs(x), env.load())));
  env.store(e);
  return mul(x, gain);
});

export const stereoGainPlusEnv = defineProcessor(() => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const gain = param({ name: "gain", default: 0.7, min: 0, max: 2, automationRate: "a-rate" });

  return {
    process: () => {
      forSample((i) => {
        const g = gain.at(i);
        out.left.set(i,  oneChannel(main.left.at(i),  g, 0.05));
        out.right.set(i, oneChannel(main.right.at(i), g, 0.05));
      });
    },
  };
});
`;
</script>

# Your first processor

This walkthrough builds a stereo gain + meter — small enough to read in five minutes, real enough to ship.

## 1. The body

A processor is a single `defineProcessor` call. Its body is **captured** once at compile time: every primitive call records an AST node, and the framework lowers that AST to WASM.

<TryIt label="step 1: skeleton" size="tall" :code="tryItCode0" />

Pass-through. The `forSample` callback runs at WASM speed — there is no JS function-call overhead per sample. The capture machinery records what you wrote in the body and emits it as a single WASM loop.

## 2. Add a parameter

`param({ ... })` returns a handle whose `.at(i)` reads the current value at sample `i`. `automationRate: "a-rate"` means the param can change every sample (Web Audio AudioParam scheduling). `"k-rate"` is per-block.

<TryIt label="step 2: gain" size="tall" :code="tryItCode1" />

The Run button gives you a slider for **gain**. It's a real `AudioParam` — connect oscillators or LFOs to it and they'll drive it sample-accurately.

::: warning JS operators on graph nodes
Inside the captured body, `main.left.at(i)` and `gain.at(i)` are graph nodes (AST handles), not numbers. Use the named helpers — `mul(a, b)`, `add(a, b)`, `sub(a, b)`, `div(a, b)` — instead of `*`, `+`, `-`, `/`. The framework throws a clear error if you forget; it doesn't silently produce NaN.

```ts
mul(main.left.at(i), gain.at(i)) // ✓
main.left.at(i) * gain.at(i)    // ✗ throws
```
:::

## 3. Add state

`state.f32(initial)` declares a single 32-bit float slot in linear memory. `.load()` reads it, `.store(v)` writes it. State persists across `process()` calls — the foundation of every IIR filter, envelope, oscillator phase, etc.

This adds a peak meter:

<TryIt label="step 3: state + max" size="tall" :code="tryItCode2" />

In a real app you'd subscribe to the meter:

```ts
const node = await createWasmNode(ctx, myFirstProcessor, "myFirstProcessor");
node.state.peak.subscribe((v) => {
  meterEl.style.width = `${Math.min(100, v * 100)}%`;
});
```

The framework drains the slot on the audio thread, bumps a per-slot version counter via `Atomics.add`, and the host observes via `Atomics.load`. No `postMessage` per sample.

## 4. Two-channel decoupling with subgraphs

When the same DSP applies to both channels, factor it into a [`defineSubgraph`](./subgraphs):

<TryIt label="step 4: subgraph" size="tall" :code="tryItCode3" />

Each call site of `oneChannel` gets its own `env` state slot — the framework allocates per-instance, so the L and R channels keep independent envelopes.

## What you've learned

- `defineProcessor` is the entry point.
- Audio I/O comes through `audioInput`/`audioOutput`.
- Per-sample work goes inside `forSample`.
- `state.<type>` declares persistent slots.
- `param` exposes a Web Audio `AudioParam`.
- `state.publish` makes a slot visible to the main thread at a rate-limited tick.
- `defineSubgraph` factors reusable DSP — each call site gets independent state.

## Next

- [Audio I/O + forSample](./audio-io) — channel up/down-mixing, sample-position semantics.
- [State + buffers](./state-and-buffers) — multi-byte slots, fixed-size arrays.
- [Parameters](./parameters) — a-rate vs k-rate, automation lanes.
