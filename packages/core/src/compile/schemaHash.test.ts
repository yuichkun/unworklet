/**
 * Behavior of the schema-hash stage (= `01-dsl.md` §8.3 migration anchor、
 * plan Q-D stage 別 internal module の 1 つ)。
 *
 * Phase 3 で hash 形 を fix (= `JSON.stringify(graph)` + SHA-256 hex) =
 * 後 続 phase で 形 を 変 え た 瞬 間 inline snapshot fail で 検 知 + 既
 * snapshot blob 互 換 を 別 path で 意 図 的 migrate す る path に zip。
 */

import { expect, test } from "vite-plus/test";

import type { CapturedGraph } from "./ast.ts";
import { schemaHash } from "./schemaHash.ts";

const stereoGain: CapturedGraph = {
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

const swappedOrder: CapturedGraph = {
  declarations: [
    stereoGain.declarations[1]!,
    stereoGain.declarations[0]!,
    stereoGain.declarations[2]!,
  ],
  statements: stereoGain.statements,
};

const alteredBody: CapturedGraph = {
  declarations: stereoGain.declarations,
  statements: [{ kind: "forSample", stride: 1, body: [{ kind: "loopCounter" }] }],
};

const emptyGraph: CapturedGraph = { declarations: [], statements: [] };

test("`schemaHash(stereoGain)` = fixed hex (= inline snapshot)", () => {
  expect(schemaHash(stereoGain)).toMatchInlineSnapshot(`"5262505d98866efd9e3fa9d5f9b2cca0"`);
});

test("`schemaHash(swappedOrder)` = fixed hex 別 値 (= structural over declaration order)", () => {
  expect(schemaHash(swappedOrder)).toMatchInlineSnapshot(`"e1b1643ea5cc41e3f598c65b8ffa5ffe"`);
});

test("`schemaHash(alteredBody)` = `schemaHash(stereoGain)` (= body は anchor に 影 響 し ない)", () => {
  // Declarations identical, only the process body differs → same migration
  // anchor (a preset blob survives logic tweaks; `01-dsl.md` §8.3).
  expect(schemaHash(alteredBody)).toBe(schemaHash(stereoGain));
});

test("`schemaHash(emptyGraph)` = fixed hex (= 空 graph で も 有 効 hex)", () => {
  expect(schemaHash(emptyGraph)).toMatchInlineSnapshot(`"09612b07b5ecb5a5b61565cb8f28b3e4"`);
});

test("`schemaHash` is deterministic = 同 graph で 二 度 呼 ぶ と 同 hex", () => {
  expect(schemaHash(stereoGain)).toBe(schemaHash(stereoGain));
});

test("declaration が 異 な る fixture は 異 な る hex を 生 む (= structural 担 保)", () => {
  // alteredBody は declarations が stereoGain と 同 一 = 同 hash (= 別 test で 担 保)。
  const hashes = [schemaHash(stereoGain), schemaHash(swappedOrder), schemaHash(emptyGraph)];
  expect(new Set(hashes).size).toBe(hashes.length);
});

test("hex shape = 32-char lowercase (= 2-lane FNV-1a 128-bit hex 形 担 保)", () => {
  expect(schemaHash(stereoGain)).toMatch(/^[0-9a-f]{32}$/);
});
