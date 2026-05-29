/**
 * Scalar constructor behavior (= `01-dsl.md` §2.2, `decisions-log.md`
 * Q33 + Q77). `f32` / `i32` are implemented (literal lift + cross-precision
 * convert); their black-box behavior lives in
 * `../__tests__/behavior/multitype.test.ts`. `f64` / `i64` / `bool` / `num`
 * still throw until their stages land.
 */

import { expect, test } from "vite-plus/test";

import { bool, f64, i64, num } from "./constructors.ts";

test("`f64(v)` stub throws", () => {
  expect(() => f64(0)).toThrow(/not implemented/);
});

test("`i64(bigint)` stub throws", () => {
  expect(() => i64(0n)).toThrow(/not implemented/);
});

test("`bool(v)` stub throws", () => {
  expect(() => bool(false)).toThrow(/not implemented/);
});

test("`num(v)` chain-start helper stub throws", () => {
  expect(() => num(0)).toThrow(/not implemented/);
});
