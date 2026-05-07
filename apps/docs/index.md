---
layout: home

hero:
  name: unworklet
  text: TypeScript-first DSL for Audio Worklets
  tagline: Write declarative DSP in pure TS. Compile to WASM with SIMD. No glue code, no AudioWorkletProcessor boilerplate, no postMessage marshalling.
  actions:
    - theme: brand
      text: Make your first sound
      link: /guide/your-first-processor
    - theme: alt
      text: Build a synth
      link: /guide/build-a-synth
    - theme: alt
      text: Build a drum machine
      link: /guide/build-a-drum
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
  defineProcessor, audioOutput, param, state, forSample,
} from "@unworklet/core";

// A 220Hz sine wave with a tunable frequency knob.
// 4 lines of DSP, real WASM, real AudioWorkletNode.
export const hello = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  const freq = param({ name: "freq", default: 220, min: 55, max: 1760, automationRate: "k-rate" });
  const phase = state.f32(0, { name: "phase" });
  const TWO_PI = 2 * Math.PI;

  return {
    process: () => {
      const inc = freq.at(0).mul(TWO_PI / ctx.sampleRate);
      forSample((i) => {
        const next = phase.load().add(inc).mod(TWO_PI);
        phase.store(next);
        out.set(0, i, next.sin().mul(0.5));
      });
    },
  };
});
`;
</script>

## Hello, sine wave

Real, live, in-browser. Hit Run, drag the slider.

<TryIt label="hello" :code="helloCode" source="silent" />

That's a complete synthesiser: an oscillator with a frequency knob, real `AudioWorkletNode`, real WASM. The compiler captures the body, lowers it through binaryen.js to a WASM module with f32x4 SIMD where it helps, and instantiates it on the audio thread. The slider is a real `AudioParam` — drag it, draw automation curves on it, connect oscillators to it as an LFO, just like every built-in Web Audio node.

Ready to build something? **Make your first sound** walks through this from scratch (~10 minutes) and gets you to a four-knob synth voice. From there, **Build a synth** adds ADSR + resonant filter; **Build a drum machine** layers a kick, a hat, and a 16-step sequencer.
