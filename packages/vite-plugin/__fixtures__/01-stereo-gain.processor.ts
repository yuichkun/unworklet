/**
 * Vite plugin test fixture = canonical Ex 1 minus meter (= `examples/01-stereo-gain/src/processor.ts`
 * を そ の ま ま 流 用)。 plugin の `?worklet` import path で 評 価 +
 * `compile()` 経 由 で WASM emit + dist asset として 出 力 されるか の
 * end-to-end 検 証 input。 内容 を examples 側 と zip し て お く こ と で、
 * 単 一 processor が plugin / offline 経 由 で 同 一 byte の WASM artifact
 * を 生 む 担 保 (= `13-offline-render.md` §4)。
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
