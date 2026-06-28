/**
 * Plugin test fixture: a source file that named-exports two or more
 * `defineProcessor()` return values. Verifies that the plugin's load hook
 * falls into the "multiple export" error path of `pickCompiledProcessor`
 * (v1.0.0 convention: one file, one processor).
 *
 * The body uses only the surface filled in Phase 3 (same shape as canonical
 * Ex 1) and does not exercise stub surface such as
 * `out.ch(...).at(...).write(...)`.
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
