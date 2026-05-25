/**
 * Behavior of the static-analysis stage (= `03-compiler.md` §3、
 * plan Q-D stage 別 internal module の 1 つ目)。
 *
 * Phase 3 = noop = `[]` 返 す だ け (= layered error model の Layer 3
 * check は 後 続 phase で fill、 plan「analyze は Phase 3 = noop」 規 定)。
 */

import { expect, test } from "vite-plus/test";

import { analyze } from "./analyze.ts";
import type { CapturedGraph } from "./ast.ts";

const emptyGraph: CapturedGraph = { declarations: [], statements: [] };

const populatedGraph: CapturedGraph = {
  declarations: [
    { kind: "audioInput", name: "main", channels: 2 },
    { kind: "audioOutput", name: "main", channels: 2 },
    {
      kind: "param",
      name: "gain",
      type: "f32",
      default: 1,
      min: 0,
      max: 4,
      automationRate: "a-rate",
    },
  ],
  statements: [{ kind: "forSample", stride: 1, body: [] }],
};

test("`analyze(emptyGraph)` returns an empty diagnostics array", () => {
  expect(analyze(emptyGraph)).toEqual([]);
});

test("`analyze(populatedGraph)` returns an empty diagnostics array (= Phase 3 noop)", () => {
  expect(analyze(populatedGraph)).toEqual([]);
});
