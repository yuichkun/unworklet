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
  expect(schemaHash(stereoGain)).toMatchInlineSnapshot(
    `"4cf8091eb794660f1944dd8c12a78ed870952ac3c37aa22452274ab6e53deac2"`,
  );
});

test("`schemaHash(swappedOrder)` = fixed hex 別 値 (= structural over declaration order)", () => {
  expect(schemaHash(swappedOrder)).toMatchInlineSnapshot(
    `"781e7fbacce3bd25c5cfeb4ce72728cb4d94f7e65e349bee03d3d011ebafcf61"`,
  );
});

test("`schemaHash(alteredBody)` = fixed hex 別 値 (= structural over statement body)", () => {
  expect(schemaHash(alteredBody)).toMatchInlineSnapshot(
    `"ffca41e37c6229e27349250533043f362e813a782d811676eeddcb77e8e9ce02"`,
  );
});

test("`schemaHash(emptyGraph)` = fixed hex (= 空 graph で も 有 効 hex)", () => {
  expect(schemaHash(emptyGraph)).toMatchInlineSnapshot(
    `"da91ea218a71ca99e5de67f0d461af6da40b4f3c937d27a32689f2fa232ee05b"`,
  );
});

test("`schemaHash` is deterministic = 同 graph で 二 度 呼 ぶ と 同 hex", () => {
  expect(schemaHash(stereoGain)).toBe(schemaHash(stereoGain));
});

test("各 fixture が 全 て 異 な る hex を 生 む (= structural 担 保)", () => {
  const hashes = [
    schemaHash(stereoGain),
    schemaHash(swappedOrder),
    schemaHash(alteredBody),
    schemaHash(emptyGraph),
  ];
  expect(new Set(hashes).size).toBe(hashes.length);
});

test("hex shape = 64-char lowercase (= SHA-256 hex 形 担 保)", () => {
  expect(schemaHash(stereoGain)).toMatch(/^[0-9a-f]{64}$/);
});
