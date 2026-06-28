/**
 * The set of core files reachable from `worklet-entry.ts` via static imports —
 * i.e. the sources bundled into the worklet and evaluated inside
 * AudioWorkletGlobalScope.
 *
 * This single source of truth is referenced in two places:
 *   - `lint.overrides` in the root `vite.config.ts` — applies
 *     `no-restricted-globals` to exactly this set, so CI fails on any use of
 *     main-thread / Node web APIs absent from AudioWorkletGlobalScope
 *     (`TextEncoder`, `fetch`, `setTimeout`, `document`, etc.).
 *   - `worklet-realm-files.test.ts` — walks the actual import graph from
 *     `worklet-entry.ts` and verifies it matches this list. This prevents the
 *     case where a new file enters the worklet bundle but slips through the lint
 *     coverage (i.e. it detects drift between the glob and the import graph).
 *
 * Paths are relative to packages/core. Order is irrelevant (compared as a set).
 */
export const WORKLET_REALM_FILES = [
  "src/worklet-entry.ts",
  "src/worklet.ts",
  "src/snapshot.ts",
  "src/types.ts",
  "src/compile/ast.ts",
  "src/compile/layout.ts",
  "src/dsl/constants.ts",
  "src/ringIndex.ts",
  "src/selfcheck.ts",
] as const;
