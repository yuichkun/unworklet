/**
 * Plugin test fixture = same export identifier (`stereoGain`) as
 * `01-stereo-gain.processor.ts` but at a distinct absolute path. Used to
 * assert that the plugin derives a per-source-path `processorName` so two
 * unrelated processors that happen to share an export name do not collide
 * inside `registerProcessor(...)`.
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
