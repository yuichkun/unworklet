/**
 * Every complete `.uwk.ts` example in the shipped guide lowers and compiles.
 *
 * `README.md` says `skills/unworklet/` "is verified against the implementation,
 * and its examples compile in CI". Only the raw `defineProcessor` blocks were
 * covered (by `packages/offline/src/docs-examples.test.ts`, over four other
 * files) — and `.uwk.ts` is the primary authoring form, so the examples a reader
 * is most likely to copy were exactly the ones nothing compiled. A change to the
 * sugar could break every sample in `dsl.md` with CI green.
 *
 * A complete example is a block with a top-level `process(() => …)`. Fragments
 * showing one expression are not compilable alone and are skipped.
 *
 * Found by the pre-release audit of #43.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { compile } from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { lowerToProcessor } from "./eval-lowered.ts";

const GUIDE = path.resolve(import.meta.dirname, "../../../skills/unworklet");

/** Pull every fenced ```ts block out of a markdown string. */
function tsBlocks(md: string): string[] {
  return [...md.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

const examples = readdirSync(GUIDE)
  .filter((f) => f.endsWith(".md"))
  .flatMap((name) =>
    tsBlocks(readFileSync(path.join(GUIDE, name), "utf8"))
      .filter((b) => /^process\(\s*\(\s*\)\s*=>/m.test(b))
      // A sibling `.uwk.ts` import only resolves through the bundler, so those
      // examples belong to the loader tests (`materialize-lowered.test.ts`)
      // rather than to this in-memory path, which refuses them by design.
      .filter((b) => !/from\s+"\.[^"]*\.uwk\.ts"/.test(b))
      .map((block, i) => ({ id: `${name}#${i}`, block })),
  );

test("every complete .uwk.ts example in the shipped guide lowers and compiles", async () => {
  // A floor, so removing examples cannot quietly shrink what this holds.
  expect(examples.length, "guide .uwk.ts examples found").toBeGreaterThanOrEqual(5);
  for (const { id, block } of examples) {
    const proc = lowerToProcessor(block);
    const compiled = await compile(proc);
    expect(compiled.wasm.length, `${id} compiles to WASM`).toBeGreaterThan(0);
  }
});
