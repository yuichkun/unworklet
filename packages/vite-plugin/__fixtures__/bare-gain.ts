/**
 * Plugin test fixture = source file name に `.processor.` 中 間 を 持 た な い
 * ケ ー ス。 plugin の `assetNameFromSourcePath` が `.processor` suffix を 削
 * る branch の 「削 ら な い 側」 (= base name そ の ま ま) を 担 保 す る。
 *
 * 中 身 は canonical Ex 1 minus meter と 同 形 (= Phase 3 で fill 済 surface
 * 限 定、 stub に hit し な い)。
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
