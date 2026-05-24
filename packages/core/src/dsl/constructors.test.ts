/**
 * Scalar constructor stub behavior (= `01-dsl.md` §2.2, `decisions-log.md`
 * Q33 + Q77). Phase 3 = stubs throw `not implemented`; runtime AST capture
 * lands later (= Phase 8 Q-A in the plan).
 */

import { expect, test } from "vite-plus/test";

import { bool, f32, f64, i32, i64, num } from "./constructors.ts";

test("`f32(v)` stub throws", () => {
  expect(() => f32(0)).toThrow(/not implemented/);
});

test("`f64(v)` stub throws", () => {
  expect(() => f64(0)).toThrow(/not implemented/);
});

test("`i32(v)` stub throws", () => {
  expect(() => i32(0)).toThrow(/not implemented/);
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
