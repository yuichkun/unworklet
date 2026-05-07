# Why unworklet

If you've written an `AudioWorkletProcessor` by hand you know the pain:

- Every `process()` call goes through a JS function call boundary, bringing GC and JIT deopt risk into the audio thread.
- Sharing state with the main thread means hand-rolling `MessageChannel` or `SharedArrayBuffer` ringbuffers, with all the Atomics ordering you can fit in a doc string.
- You write the same processor twice — once for the worklet, once for offline rendering / Node testing.
- Snapshot / restore / migrations are entirely your problem.
- Adding SIMD requires a separate WASM build pipeline.

unworklet replaces all of that with a single declarative DSL that compiles to WASM at build time. You write one `defineProcessor` body. The framework gives you:

- A real WASM module with `f32x4` SIMD on hot paths, instantiated inside a real `AudioWorkletProcessor`. No per-block JS overhead.
- A JS interpreter with the same surface for Node tests + offline rendering. Bit-equivalent within FP tolerance.
- SAB + Atomics ringbuffers for messages / events / `state.publish`. Per-slot version counters. Drop-oldest on overflow with surfaced `diagnostics.overflowCount()`.
- Structured Layer-2 / Layer-3 errors with refactor hints (file:line:col when source maps are in scope).
- Static analysis that fires before you boot: unwritten outputs, denormal-prone coefficients, out-of-block `atSample`, allocation hazards, loop-bound checks, parameter reachability.
- Declarative migrations on schema upgrade — your saved presets survive across versions.
- First-party `unworklet dev` (hot reload), `@unworklet/vite-plugin` (`?unworklet` import suffix), CLI (render / build / analyze / bench / inspect).

## What you don't write

- `class extends AudioWorkletProcessor`
- `process(inputs, outputs, parameters)` channel-iteration boilerplate
- `port.postMessage` / `MessageChannel` plumbing
- `Atomics.load` / `Atomics.store` ring-buffer protocols
- Cross-thread state coherence
- A separate JS-interpreter implementation for tests
- WASM compilation glue
- Snapshot byte format negotiation

## What you do write

```ts
defineProcessor(() => {
  const inp = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const cutoff = param({ name: "cutoff", default: 0.3, min: 0, max: 1, automationRate: "k-rate" });
  const lp = state.f32(0);
  return {
    process: () => {
      const k = cutoff.at(0);
      forSample((i) => {
        const y = add(lp.load(), mul(k, sub(inp.at(0, i), lp.load())));
        lp.store(y);
        out.set(0, i, y);
        out.set(1, i, y);
      });
    },
  };
});
```

That's the entire processor. The framework handles the rest.
