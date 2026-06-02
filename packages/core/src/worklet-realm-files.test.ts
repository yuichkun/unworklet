/**
 * Ensures the declared scope of the worklet realm safety guard stays in sync
 * with the actual worklet bundle graph.
 *
 * `vite.config.ts` `lint.overrides` applies `no-restricted-globals`
 * (which bans main-thread APIs absent from AudioWorkletGlobalScope) exclusively
 * to `WORKLET_REALM_FILES`. If that glob drifts from the set of files that
 * actually land in the worklet bundle, newly added worklet-graph files escape
 * the banned-API check — the sole structural weakness of the denylist/glob approach.
 *
 * This test traces static imports/exports from `worklet-entry.ts` to compute the
 * real graph, then asserts exact equality with `WORKLET_REALM_FILES`. Any mismatch
 * is a test failure, structurally guaranteeing that the lint target set always
 * matches the worklet graph (i.e., the bundle contents).
 */

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { WORKLET_REALM_FILES } from "./worklet-realm-files.ts";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = dirname(SRC_DIR);

/**
 * Starting from `entryRel` (relative to packages/core), traces static
 * `from "./…"` / `import "./…"` edges and returns the set of reachable
 * in-package files as paths relative to packages/core.
 * Type-only imports (`import type … from "./…"`) are included — as a
 * lint superset this is safe, since type files never reference banned
 * globals as values, and the conservative over-approximation is preferable.
 */
function traceWorkletGraph(entryRel: string): Set<string> {
  const seen = new Set<string>();
  const importRe = /(?:from|import)\s+"(\.[^"]+)"/g;
  const visit = (absPath: string): void => {
    const rel = relative(PKG_DIR, absPath);
    if (seen.has(rel)) return;
    seen.add(rel);
    let src: string;
    try {
      src = readFileSync(absPath, "utf8");
    } catch {
      return;
    }
    const dir = dirname(absPath);
    for (const m of src.matchAll(importRe)) {
      visit(resolve(dir, m[1]!));
    }
  };
  visit(resolve(PKG_DIR, entryRel));
  return seen;
}

test("worklet realm import graph matches WORKLET_REALM_FILES exactly (prevents lint guard gaps)", () => {
  const graph = traceWorkletGraph("src/worklet-entry.ts");
  const declared = new Set<string>(WORKLET_REALM_FILES);

  const missing = [...graph].filter((f) => !declared.has(f)).sort();
  const stale = [...declared].filter((f) => !graph.has(f)).sort();

  expect(
    missing,
    "File is reachable from worklet-entry.ts (i.e., lands in the worklet bundle) but is absent from WORKLET_REALM_FILES." +
      " It escapes the no-restricted-globals check. Either add it to worklet-realm-files.ts or remove the worklet dependency.",
  ).toEqual([]);
  expect(
    stale,
    "File is listed in WORKLET_REALM_FILES but is not reachable from worklet-entry.ts. Remove it from worklet-realm-files.ts.",
  ).toEqual([]);
});
