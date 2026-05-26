/**
 * Plugin test fixture = source file が `defineProcessor()` 戻 り 値 を
 * 2 個 以 上 named export し て い る ケ ー ス。 plugin の load hook が
 * `pickCompiledProcessor` の 「多 重 export」 error path に 落 ち る こ と
 * を 担 保 (= v1.0.0 convention = 1 file 1 processor)。
 *
 * 中 身 は Phase 3 で fill 済 の surface 限 定 (= canonical Ex 1 と 同 形)、
 * stub surface (= `out.ch(...).at(...).write(...)` 等) を 叩 か な い 構 造。
 */

import { audioInput, audioOutput, defineProcessor, forSample, param } from "@unworklet/core";

const buildGainProcessor = () =>
  defineProcessor(() => {
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

export const firstProcessor = buildGainProcessor();
export const secondProcessor = buildGainProcessor();
