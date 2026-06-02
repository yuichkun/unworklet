/**
 * Behavior of the schema-hash stage (= `01-dsl.md` §8.3 migration anchor,
 * one of the internal modules in the Q-D stage pipeline).
 *
 * The hash format is fixed as `JSON.stringify(graph)` + SHA-256 hex.
 * Any future change to the format is caught immediately by inline snapshot
 * failures, and existing snapshot blob compatibility is handled via an
 * explicit migration path.
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

test("`schemaHash(swappedOrder)` = distinct fixed hex (= hash is sensitive to declaration order)", () => {
  expect(schemaHash(swappedOrder)).toMatchInlineSnapshot(`"e1b1643ea5cc41e3f598c65b8ffa5ffe"`);
});

test("`schemaHash(alteredBody)` = `schemaHash(stereoGain)` (= process body does not affect the migration anchor)", () => {
  // Declarations identical, only the process body differs → same migration
  // anchor (a preset blob survives logic tweaks; `01-dsl.md` §8.3).
  expect(schemaHash(alteredBody)).toBe(schemaHash(stereoGain));
});

test("`schemaHash(emptyGraph)` = fixed hex (= produces a valid hex even for an empty graph)", () => {
  expect(schemaHash(emptyGraph)).toMatchInlineSnapshot(`"09612b07b5ecb5a5b61565cb8f28b3e4"`);
});

test("`schemaHash` is deterministic = calling twice with the same graph yields the same hex", () => {
  expect(schemaHash(stereoGain)).toBe(schemaHash(stereoGain));
});

test("fixtures with different declarations produce distinct hashes (= structural integrity guarantee)", () => {
  // alteredBody shares identical declarations with stereoGain, so they hash the same (covered by a separate test).
  const hashes = [schemaHash(stereoGain), schemaHash(swappedOrder), schemaHash(emptyGraph)];
  expect(new Set(hashes).size).toBe(hashes.length);
});

test("hex shape = 32-char lowercase (= validates 2-lane FNV-1a 128-bit hex format)", () => {
  expect(schemaHash(stereoGain)).toMatch(/^[0-9a-f]{32}$/);
});
