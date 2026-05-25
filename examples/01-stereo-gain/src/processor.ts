/**
 * Canonical Ex 1 minus meter (= `docs/12-canonical-examples.md` §1 から
 * `state.expose + publish` を 抜 い た shape)。 Phase 3 vertical slice の
 * end-to-end smoke target = `renderOffline` 越 し に input × gain が output
 * へ bit-exact 反 映 さ れ る こ と を 担 保。
 *
 * meter (= `state.f32(0).expose(...)`) は Phase 7 messaging で 拡 張 し て
 * canonical Ex 1 full に 育 て る path。
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
