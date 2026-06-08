/**
 * Vite plugin test fixture — canonical Ex 1 without the meter
 * (mirrors `examples/01-stereo-gain/src/processor.ts`).
 * End-to-end verification input: checks that the `?worklet` import path
 * triggers `compile()`, emits WASM, and writes the artifact to dist.
 * Keeping this in sync with the examples/ copy guarantees that a single
 * processor produces an identical WASM artifact whether built via the
 * plugin or via the offline path (see `13-offline-render.md` §4).
 */

import { audioInput, audioOutput, defineProcessor, forSample, param } from "@unworklet/core";

export const stereoGain = defineProcessor(() => {
  const input = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const gain = param
    .f32({ default: 1.0, min: 0.0, max: 4.0, automationRate: "a-rate" })
    .named("gain");

  return {
    process: () => {
      forSample((i) => {
        out.left.at(i).write(input.left.at(i).mul(gain.at(i)));
        out.right.at(i).write(input.right.at(i).mul(gain.at(i)));
      });
    },
  };
});
