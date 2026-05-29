/**
 * Scalar constructor behavior (= `01-dsl.md` §2.2, `decisions-log.md`
 * Q33 + Q77). `f32` / `f64` / `i32` / `i64` are implemented (literal lift +
 * cross-precision convert); their black-box behavior lives in
 * `../__tests__/behavior/multitype.test.ts`. `bool` / `num` still throw until
 * their stage lands.
 */

import { expect, test } from "vite-plus/test";

import { bool, num } from "./constructors.ts";

test("`bool(v)` stub throws", () => {
  expect(() => bool(false)).toThrow(/not implemented/);
});

test("`num(v)` chain-start helper stub throws", () => {
  expect(() => num(0)).toThrow(/not implemented/);
});
