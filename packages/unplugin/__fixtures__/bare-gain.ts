/**
 * Plugin test fixture for a source file whose name does NOT contain the
 * `.processor.` middle segment. Exercises the branch of
 * `assetNameFromSourcePath` that leaves the base name unchanged instead of
 * stripping the `.processor` suffix.
 *
 * The DSP graph matches canonical Example 1 without the meter node, covering
 * only the surface area filled by Phase 3 (no stub paths hit).
 */

import { audioInput, audioOutput, defineProcessor, forSample, param } from "@unworklet/core";

export const bareGain = defineProcessor(() => {
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
