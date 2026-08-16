/**
 * Round 4 dogfood gap 4 regression. When a consumer forgets to sample a Param
 * (writing `mul(rawNoise, noiseMix)` instead of `mul(rawNoise, noiseMix[i])`),
 * the TS overload resolution falls through to the last numeric overload (i64)
 * and reports `Argument of type ... is not assignable to parameter of type
 * 'number | Node<"i64">'` — the "i64" mention is a red herring (nothing in the
 * user's expression is i64). At capture time, the runtime `lift` catches the
 * Param handle and throws a friendly error naming Param + the `param[i]` fix.
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts";
import { audioOutput, param } from "../../dsl/declarations.ts";
import { mul } from "../../index.ts";
import { forSample } from "../../dsl/loop.ts";
import { defineProcessor } from "../../processor.ts";

test("mul(node, paramHandle) throws a Param-aware error at graph capture", () => {
  // `defineProcessor(...)` runs the body synchronously to capture the graph,
  // so a `mul(x, param)` inside the process body throws during construction
  // — before render(). Wrap the construction in a thunk to catch it.
  expect(() =>
    defineProcessor(() => {
      const p = param.f32({ default: 0.5, min: 0, max: 1, automationRate: "a-rate" }).named("mix");
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          forSample((i) => {
            // BAD: passing the Param handle directly instead of `p[i]` / `p.at(i)`.
            // `as unknown as never` bypasses the TS overload rejection so the
            // capture-time runtime check can be exercised.
            const bad = mul(1 as unknown as never, p as unknown as never);
            out
              .ch(0)
              .at(i)
              .write(bad as unknown as import("../../index.ts").Node<"f32">);
          });
        },
      };
    }),
  ).toThrow(/Param.*param\[i\].*Node<"f32">/s);
});
