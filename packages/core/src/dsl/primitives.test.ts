/**
 * Primitive operator stub behavior (= `01-dsl.md` §2.1, `decisions-log.md`
 * Q77). Free-function stubs throw `not implemented` until Step 3.3 (= `mul`
 * first) and later phases fill them. Table-driven so adding a primitive
 * here forces both the export and the test surface to stay in sync.
 */

import { expect, test } from "vite-plus/test";

import * as P from "./primitives.ts";

const unary = [
  "neg",
  "sin",
  "cos",
  "tan",
  "tanh",
  "exp",
  "log",
  "sqrt",
  "abs",
  "floor",
  "ceil",
  "frac",
] as const;

const binary = [
  "add",
  "sub",
  "mul",
  "div",
  "mod",
  "eq",
  "lt",
  "gt",
  "lte",
  "gte",
  "min",
  "max",
] as const;

const ternary = ["clamp", "select"] as const;

test.each(unary)("`%s(x)` stub throws", (name) => {
  const fn = (P as unknown as Record<string, (x: number) => unknown>)[name];
  expect(() => fn(0)).toThrow(/not implemented/);
});

test.each(binary)("`%s(a, b)` stub throws", (name) => {
  const fn = (P as unknown as Record<string, (a: number, b: number) => unknown>)[name];
  expect(() => fn(0, 0)).toThrow(/not implemented/);
});

test.each(ternary)("`%s(a, b, c)` stub throws", (name) => {
  const fn = (P as unknown as Record<string, (a: number, b: number, c: number) => unknown>)[name];
  expect(() => fn(0, 0, 0)).toThrow(/not implemented/);
});
