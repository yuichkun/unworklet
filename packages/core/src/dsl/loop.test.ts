/**
 * `forSample` / `forSample.byN` stub behavior (= `01-dsl.md` §10).
 * Phase 3 fills the per-sample loop AST node in Step 3.3; until then
 * both shapes throw `not implemented`.
 */

import { expect, test } from "vite-plus/test";

import { forSample } from "./loop.ts";

test("`forSample(cb)` stub throws", () => {
  expect(() => forSample(() => {})).toThrow(/not implemented/);
});

test("`forSample.byN(stride, cb)` stub throws", () => {
  expect(() => forSample.byN(4, () => {})).toThrow(/not implemented/);
});
