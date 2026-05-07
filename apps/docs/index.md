---
layout: home

hero:
  name: unworklet
  text: TypeScript-first DSL for Audio Worklets
  tagline: Write declarative DSP in pure TS. Compile to WASM with SIMD. No glue code, no AudioWorkletProcessor boilerplate, no postMessage marshalling.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: First processor (5 min)
      link: /guide/your-first-processor
    - theme: alt
      text: Why unworklet
      link: /guide/why

features:
  - title: Real WASM, not a JS interpreter
    details: Your processor is captured at compile time, lowered through binaryen.js to a real WebAssembly module with f32x4 SIMD on hot paths, and run inside a real AudioWorkletProcessor. No per-block JS execution.
  - title: Realtime-safe by construction
    details: No allocation in the audio thread. No GC pauses. Static analysis catches denormal-prone filters, unbounded loops, unwritten outputs, and out-of-block timestamps before you ever boot the processor.
  - title: SAB + Atomics transport
    details: Messages, events, and state.publish slots are wired through SharedArrayBuffer ringbuffers with Atomics. Per-slot version counters; lockless single-producer / single-consumer.
  - title: One DSL, two backends
    details: The same code runs in WASM (production audio) and a JS interpreter (Node tests, offline rendering, host-side migrations). Bit-equivalent within FP tolerance.
  - title: Snapshot, restore, migrate
    details: Block-atomic Uint8Array snapshots. Schema-hash gated restores. Declarative migration chain handles version upgrades on stale blobs without losing user state.
  - title: Built for tooling
    details: First-party CLI (render / build / analyze / bench / inspect / dev), Vite plugin, hot reload over SSE, golden WAV regression, source maps, structured Layer-2/3 errors with refactor hints.
---

<script setup>
const helloCode = `import {
  defineProcessor, audioInput, audioOutput, param, forSample, mul,
} from "@unworklet/core";

export const helloGain = defineProcessor(() => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const gain = param({ name: "gain", default: 0.5, min: 0, max: 1, automationRate: "a-rate" });

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
</script>

## Hello, processor

Real, live, in-browser. Hit Run.

<TryIt label="hello" :code="helloCode" />

The code above is captured by the compiler, lowered to a real WASM binary, and instantiated inside a real AudioWorkletNode. Hit **Run** to hear it. Drag the **gain** slider while it plays. The slider is wired to a real `AudioParam` — same as Web Audio's built-in nodes.
