/**
 * `materializeLowered` writes the temp modules that `loadUwkProcessor` (and the
 * Vite plugin's dev path) hand to a dynamic `import()`. Those temps must be
 * loadable by plain Node across the range `packages/lang/package.json` declares
 * it supports — `"node": ">=20"`.
 *
 * That is not a given: the lowered output is TypeScript, and Node only learned to
 * strip types natively in 22.18 / 23.6. On Node 20 an `import()` of a `.ts` file
 * throws `ERR_UNKNOWN_FILE_EXTENSION` before the processor is ever evaluated.
 * Nothing in CI catches it — every job pins Node 24 — so the regression is
 * pinned here instead, by running the produced temp in a child process with
 * native stripping switched off. That is precisely what Node 20 offers: no
 * stripping at all.
 *
 * Reported by @codex on #43.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, test } from "vite-plus/test";

import { materializeLowered } from "./materialize-lowered.ts";

// The fixtures live inside this package so the lowered temps resolve
// `@unworklet/core` by walking up to `packages/lang/node_modules`, exactly as a
// consumer's temps resolve it from their own project.
const LANG = path.resolve(import.meta.dirname, "..");

let dir: string;
const cleanup: string[] = [];

afterEach(() => {
  for (const f of cleanup.splice(0)) rmSync(f, { force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Import `temp` in a child Node with native type-stripping disabled. */
function importWithoutTypeStripping(temp: string): { code: number; output: string } {
  const r = spawnSync(
    "node",
    [
      "--no-experimental-strip-types",
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(temp).href)});`,
    ],
    { encoding: "utf8" },
  );
  return { code: r.status ?? -1, output: `${r.stdout}${r.stderr}` };
}

test("a single-file processor's temp loads on a Node without native type-stripping (= Node 20)", async () => {
  dir = mkdtempSync(path.join(LANG, ".mat-single-"));
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = 0.5;
  });
});`,
  );

  const temp = await materializeLowered(src, new Map(), new Set(), cleanup);
  const { code, output } = importWithoutTypeStripping(temp);
  expect(output).not.toMatch(/ERR_UNKNOWN_FILE_EXTENSION/);
  expect(code, output).toBe(0);
});

test("a processor importing a sibling subgraph loads without native type-stripping — the rewritten specifiers point at loadable temps too", async () => {
  dir = mkdtempSync(path.join(LANG, ".mat-multi-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "voice.uwk.ts"),
    `export const voice = defineSubgraph(() => {
  const phase = state.f32(0).named("phase");
  return {
    tick: (hz: Node<"f32">) => {
      phase.write((phase + hz / 48000) % 1);
      return phase;
    },
  };
});`,
  );
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { voice } from "./voice.uwk.ts";

const out = audioOutput({ channels: 1, name: "main" });
const v = instantiate(voice, { name: "v" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = v.tick(f32(220));
  });
});`,
  );

  const temp = await materializeLowered(src, new Map(), new Set(), cleanup);
  const { code, output } = importWithoutTypeStripping(temp);
  expect(output).not.toMatch(/ERR_UNKNOWN_FILE_EXTENSION/);
  expect(code, output).toBe(0);
});
