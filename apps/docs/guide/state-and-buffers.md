<script setup>
const tryItCode0 = `import { defineProcessor, audioInput, audioOutput, state, forSample, add } from "@unworklet/core";

export const counter = defineProcessor(() => {
  const main = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });
  // A single i32 slot. We bump it every sample.
  const n = state.i32(0, { name: "n", publish: { rateFps: 30 } });
  return {
    process: () => {
      forSample((i) => {
        n.store(add(n.load(), 1));
        out.set(0, i, main.at(0, i));
      });
    },
  };
});
`;
const tryItCode1 = `import {
  defineProcessor, audioInput, audioOutput, param, state, buffer,
  forSample, add, sub, mul, mod, i32, flushDenormals,
} from "@unworklet/core";

export const simpleDelay = defineProcessor((ctx) => {
  // ctx.samples(ms) → integer sample count at ctx.sampleRate.
  const MAX_DELAY = ctx.samples(2000);   // 2s of headroom
  const main = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });
  const delayMs = param({ name: "delayMs", default: 350, min: 1, max: 1500, automationRate: "k-rate" });
  const feedback = param({ name: "feedback", default: 0.4, min: 0, max: 0.95, automationRate: "k-rate" });
  const wet = param({ name: "wet", default: 0.5, min: 0, max: 1, automationRate: "k-rate" });

  const line = buffer.f32({ size: MAX_DELAY, name: "line" });
  const head = state.i32(0, { name: "head" });

  return {
    process: () => {
      const dSamples = i32(mul(delayMs.at(0), ctx.sampleRate / 1000));
      const fb = feedback.at(0);
      const w = wet.at(0);
      const block = head.load();

      forSample((i) => {
        const wIdx = mod(add(block, i), MAX_DELAY);
        const rIdx = mod(add(sub(wIdx, dSamples), MAX_DELAY), MAX_DELAY);

        const dry = main.at(0, i);
        const tap = line.read(rIdx);
        // Feedback path: write input + delayed-tap × feedback gain.
        const newSample = flushDenormals(add(dry, mul(tap, fb)));
        line.write(wIdx, newSample);
        // Output: dry + wet × tap.
        out.set(0, i, add(dry, mul(tap, w)));
      });
      head.store(mod(add(block, 128), MAX_DELAY));
    },
  };
});
`;
</script>

# State + buffers

## state — single scalars

`state.<type>(initial, options?)` declares a single slot in linear memory:

```ts
const env = state.f32(0);             // Float32, initial 0
const noteOn = state.bool(false);     // Boolean (1 bit, padded to 4)
const phase = state.f32(0, { name: "phase" });   // named (visible in inspect)
const counter = state.i32(0, { snapshot: "transient" });  // not saved on snapshot
```

`.load()` reads, `.store(v)` writes. State persists across `process()` calls, across saves (when `snapshot: "persistent"`, the default), and across schema-compatible migrations.

<TryIt label="state: counter" :code="tryItCode0" />

The `publish: { rateFps: 30 }` option makes `n` visible to main-side `node.state.n.subscribe(...)` at 30 fps. The audio thread bumps a per-slot version counter via Atomics; the host reads it lockless.

## buffer — fixed-size arrays

`buffer.<type>({ size, name, snapshot? })` declares a fixed-size array. Indexed reads + writes, plus interpolated read for sub-sample positions:

```ts
// ctx.samples(ms) gives a sample-rate-correct integer.
const delay = buffer.f32({ size: ctx.samples(2000), name: "delayLine" });  // 2s
const ir = buffer.f32({ size: 4096, name: "ir", snapshot: "persistent" });

// Inside forSample:
delay.write(idx, sample);
const tap = delay.read(idx);
const interp = delay.readInterpolated(floatPos);  // linear interp between idx0 and idx0+1
```

Buffers stay in linear memory, so reads and writes are bounded loads/stores — no GC, no allocation.

<TryIt label="buffer: 1-tap delay" size="tall" :code="tryItCode1" />

The `flushDenormals` call on the feedback path zeros out values smaller than 1e-30. Without it, decaying tails on x86 CPUs can stall the audio thread on subnormal float arithmetic. See [Denormals](./denormals).

## buffer.publish

Same as `state.publish` but for the whole buffer. The audio thread copies the buffer into the shared region every `1/rateFps` seconds; main-side `subscribe(handler)` receives a `Float32Array` view.

```ts
const waveform = buffer.f32({
  size: 1024,
  name: "waveform",
  publish: { rateFps: 30 },
});

// Audio side: write each block's signal into the buffer.
forSample((i) => {
  const wp = mod(add(wpStart, i), 1024);
  waveform.write(wp, signal);
});
```

```ts
// Main side: render an oscilloscope.
node.state.waveform.subscribe((view) => {
  drawScope(view);  // Float32Array, 1024 elements
});
```

## Snapshot policies

Each declaration accepts a `snapshot` option:

- `"persistent"` (default for `state`, `param`, `buffer({ snapshot: "persistent" })`) — saved on `node.snapshot()`, restored on `node.restore(blob)`.
- `"transient"` (default for un-flagged buffers) — kept on the audio thread but not serialized. Good for delay lines, oscillator phases, anything that can re-warm in a few blocks.

The framework filters by policy on snapshot and skips transient slots on restore — your delay line doesn't get crushed when you load a preset.

## SIMD-friendly buffers

`buffer.f32` exposes SIMD primitives: `loadVec(offset)` reads 4 lanes, `storeVec(offset, vec)` writes 4 lanes. See [SIMD](./simd).
