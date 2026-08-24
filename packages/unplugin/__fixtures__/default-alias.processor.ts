/**
 * Plugin test fixture: ONE processor value exported under two bindings — the
 * named export tests import for renderOffline, the default export feeds the
 * `?worklet` default-import convention. Both point at the same object, so the
 * load hook must accept it as a single processor (issue #42), keyed by the
 * named binding.
 */

import { audioInput, audioOutput, defineProcessor, forSample, param } from "@unworklet/core";

export const wave = defineProcessor(() => {
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

export default wave;
