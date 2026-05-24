/**
 * `@unworklet/core/simd` stub behavior (= `01-dsl.md` §7,
 * `09-repo-structure.md` §2.2). Phase 10 fills the SIMD subpath; Phase 3
 * = every primitive throws `not implemented`.
 */

import { expect, test } from "vite-plus/test";

import { addVec, divVec, mulVec, splat, subVec, sumLanes, vec4 } from "./simd.ts";

test("`vec4(a, b, c, d)` stub throws", () => {
  expect(() => vec4(0, 0, 0, 0)).toThrow(/not implemented/);
});

test("`splat(x)` stub throws", () => {
  expect(() => splat(0)).toThrow(/not implemented/);
});

test("`addVec(a, b)` stub throws", () => {
  expect(() => addVec({} as never, {} as never)).toThrow(/not implemented/);
});

test("`subVec(a, b)` stub throws", () => {
  expect(() => subVec({} as never, {} as never)).toThrow(/not implemented/);
});

test("`mulVec(a, b)` stub throws", () => {
  expect(() => mulVec({} as never, {} as never)).toThrow(/not implemented/);
});

test("`divVec(a, b)` stub throws", () => {
  expect(() => divVec({} as never, {} as never)).toThrow(/not implemented/);
});

test("`sumLanes(v)` stub throws", () => {
  expect(() => sumLanes({} as never)).toThrow(/not implemented/);
});
