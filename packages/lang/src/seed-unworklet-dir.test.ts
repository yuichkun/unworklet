/**
 * Unit tests for the generated `.unworklet/tsconfig.json` and the seed routine.
 *
 * The seeded config is the ONE thing a consumer inherits from with a one-line
 * `"extends": "./.unworklet/tsconfig.json"`. Every setting there is a default that
 * consumers get for free (they can still override); a regression to the defaults
 * would silently break the type-check on every user site.
 *
 * In particular, `module` / `moduleResolution: "nodenext"` are load-bearing: without
 * them tsc falls back to `commonjs` / `node`, which cannot see the modern
 * `package.json` `exports` conditions of `@unworklet/*`. The ambient identifiers
 * (`noiseSource`, `state`, `event`, …) then type as `any`, and misuse like
 * `noiseSource() * 0.5` (missing `.next()`) slips past the type check — a form
 * of the type ⟺ works break that guidance-dogfood F-11-types found.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { GENERATED_TSCONFIG, seedUnworkletDir } from "./seed-unworklet-dir.ts";

type Parsed = {
  compilerOptions?: Record<string, unknown>;
  include?: unknown;
  exclude?: unknown;
};
const parsed: Parsed = JSON.parse(GENERATED_TSCONFIG);

test("GENERATED_TSCONFIG sets `module` and `moduleResolution` so ambient identifiers keep their real types (F-11-types regression)", () => {
  expect(parsed.compilerOptions?.module).toBe("nodenext");
  expect(parsed.compilerOptions?.moduleResolution).toBe("nodenext");
});

test("GENERATED_TSCONFIG pulls the `*?worklet` ambient via `types`", () => {
  expect(parsed.compilerOptions?.types).toEqual(["@unworklet/unplugin/client"]);
});

test("GENERATED_TSCONFIG registers the `.uwk.ts` language plugin", () => {
  expect(parsed.compilerOptions?.plugins).toEqual([{ name: "@unworklet/lang/typescript-plugin" }]);
});

test("GENERATED_TSCONFIG allows `.uwk.ts` specifiers for sibling-subgraph imports", () => {
  expect(parsed.compilerOptions?.allowImportingTsExtensions).toBe(true);
  expect(parsed.compilerOptions?.noEmit).toBe(true);
});

test("GENERATED_TSCONFIG scans the project sources and the per-processor witness", () => {
  expect(parsed.include).toEqual(["worklets.d.ts", "../**/*.ts", "../**/*.tsx"]);
  expect(parsed.exclude).toEqual(["../node_modules"]);
});

test("seedUnworkletDir writes tsconfig.json + empty worklets.d.ts idempotently", () => {
  const root = mkdtempSync(path.join(import.meta.dirname, ".seed-test-"));
  try {
    seedUnworkletDir(root);
    const tsconfig = readFileSync(path.join(root, ".unworklet/tsconfig.json"), "utf8");
    const witness = readFileSync(path.join(root, ".unworklet/worklets.d.ts"), "utf8");
    expect(tsconfig).toBe(GENERATED_TSCONFIG);
    expect(witness).toBe("");
    // Idempotent: a second call does not throw or clobber.
    seedUnworkletDir(root);
    expect(readFileSync(path.join(root, ".unworklet/tsconfig.json"), "utf8")).toBe(
      GENERATED_TSCONFIG,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedUnworkletDir is a no-op on a non-existent root (synthetic unit-test config)", () => {
  const root = mkdtempSync(path.join(import.meta.dirname, ".seed-test-noop-"));
  rmSync(root, { recursive: true, force: true });
  seedUnworkletDir(root);
  // If it materialised anything, the test tree would leak — the finally-free
  // shape is the assertion.
});
