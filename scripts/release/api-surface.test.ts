import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { apiVerdict, compareApiSurfaces, readApiSurface } from "./api-surface.ts";

function fixturePackage(files: Record<string, string>, exports: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "uwk-api-"));
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "@unworklet/core", version: "0.3.0", exports }),
  );
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

test("the API surface is every export of every entry with a type, as declared", () => {
  const dir = fixturePackage(
    {
      "dist/index.d.mts": [
        'import { Shared } from "./chunk.mjs";',
        "/** Docs are not part of the shape. */",
        "declare function createNode(ctx: AudioContext,  processor: unknown): Promise<unknown>;",
        "type Options = { rate: number };",
        "export { Options, Shared as Renamed, createNode };",
      ].join("\n"),
      "dist/chunk.d.mts": "type Shared = { id: string };\nexport { Shared };\n",
      "dist/simd.d.mts": "declare const lanes: 4;\nexport { lanes };\n",
    },
    {
      ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
      "./simd": { types: "./dist/simd.d.mts", import: "./dist/simd.mjs" },
      "./package.json": "./package.json",
    },
  );

  expect(readApiSurface(dir)).toEqual({
    "@unworklet/core#Options": "type Options = { rate: number };",
    "@unworklet/core#Renamed": "type Shared = { id: string };",
    "@unworklet/core#createNode":
      "declare function createNode(ctx: AudioContext, processor: unknown): Promise<unknown>;",
    "@unworklet/core/simd#lanes": "declare const lanes: 4;",
  });
});

test("comparing two surfaces lists what was removed, changed and added", () => {
  const before = { "a#kept": "type K = 1;", "a#gone": "type G = 1;", "a#moved": "type M = 1;" };
  const after = { "a#kept": "type K = 1;", "a#moved": "type M = 2;", "a#fresh": "type F = 1;" };

  expect(compareApiSurfaces(before, after)).toEqual({
    removed: ["a#gone"],
    changed: ["a#moved"],
    added: ["a#fresh"],
  });
});

test("a removed export fails unless the release is allowed to break", () => {
  const diff = { removed: ["@unworklet/core#createNode"], changed: [], added: [] };

  expect(apiVerdict(diff, { allowBreaking: false })).toEqual({
    ok: false,
    message:
      "Removing a public export breaks code that uses it (@unworklet/core#createNode). " +
      "Release it with a minor changeset.",
  });
  expect(apiVerdict(diff, { allowBreaking: true }).ok).toBe(true);
});

test("changed exports pass, and are left for review", () => {
  expect(
    apiVerdict(
      { removed: [], changed: ["@unworklet/core#createNode"], added: [] },
      { allowBreaking: false },
    ),
  ).toEqual({ ok: true });
});
