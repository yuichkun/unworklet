/**
 * Primitive operator behavior (= `01-dsl.md` §2.1, `decisions-log.md`
 * Q77). Step 3.3 = `mul` fill (= free function + `Node<T>.mul` method
 * form + literal lift)、 残 り primitive は throw stub 維 持。
 */

import { expect, test } from "vite-plus/test";

import { unwrapAst, wrapAst } from "../compile/capture.ts";

import * as P from "./primitives.ts";
import { mul } from "./primitives.ts";

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

// `mul` は Step 3.3 で fill = binary stub list か ら 除 外。
const binary = ["add", "sub", "div", "mod", "eq", "lt", "gt", "lte", "gte", "min", "max"] as const;

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

// ─────────────────────────────────────────────────────────────────────────
// mul = Step 3.3 fill
// ─────────────────────────────────────────────────────────────────────────

test("`mul(node, node)` returns a `Node` carrying a `mul` AST with both operand ASTs", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 2 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  expect(unwrapAst(mul(a, b))).toEqual({
    kind: "mul",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 2 },
    rhs: { kind: "literal", type: "f32", value: 3 },
  });
});

test("`mul(node, number)` lifts the number literal to a `literal` AST (= f32 default)", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 2 });
  expect(unwrapAst(mul(a, 0.5))).toEqual({
    kind: "mul",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 2 },
    rhs: { kind: "literal", type: "f32", value: 0.5 },
  });
});

test("`mul(number, number)` lifts both operands to `literal` AST", () => {
  expect(unwrapAst(mul(2, 3))).toEqual({
    kind: "mul",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 2 },
    rhs: { kind: "literal", type: "f32", value: 3 },
  });
});

test("`Node<T>.mul(other)` method form compiles to the same AST as `mul(a, other)`", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 2 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  const free = unwrapAst(mul(a, b));
  const method = unwrapAst(a.mul(b));
  expect(method).toEqual(free);
});

test("`Node<T>.mul(number)` method form accepts JS literals (= Q33 literal lift)", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 2 });
  expect(unwrapAst(a.mul(0.5))).toEqual({
    kind: "mul",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 2 },
    rhs: { kind: "literal", type: "f32", value: 0.5 },
  });
});
