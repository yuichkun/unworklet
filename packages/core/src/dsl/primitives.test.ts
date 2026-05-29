/**
 * Primitive operator behavior (= `01-dsl.md` §2.1, `decisions-log.md`
 * Q77). Step 3.3 = `mul` fill (= free function + `Node<T>.mul` method
 * form + literal lift)、 残 り primitive は throw stub 維 持。
 */

import { expect, test } from "vite-plus/test";

import { unwrapAst, wrapAst } from "../compile/capture.ts";

import * as P from "./primitives.ts";
import { abs, max, mul } from "./primitives.ts";

// 未 実 装 (= 多 項 式 近 似 設 計 待 ち、 Q17) の math primitive だ け が stub list に 残 る。
const unary = ["tanh", "log"] as const;

test.each(unary)("`%s(x)` stub throws", (name) => {
  const fn = (P as unknown as Record<string, (x: number) => unknown>)[name];
  expect(() => fn(0)).toThrow(/not implemented/);
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

// ─────────────────────────────────────────────────────────────────────────
// abs / max = sub-phase 7.8a fill (canonical Ex 1 meter で 必 須)
// ─────────────────────────────────────────────────────────────────────────

test("`abs(node)` returns a `Node` carrying an `abs` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: -1.5 });
  expect(unwrapAst(abs(a))).toEqual({
    kind: "abs",
    type: "f32",
    value: { kind: "literal", type: "f32", value: -1.5 },
  });
});

test("`abs(number)` lifts the literal to `f32`", () => {
  expect(unwrapAst(abs(-0.5))).toEqual({
    kind: "abs",
    type: "f32",
    value: { kind: "literal", type: "f32", value: -0.5 },
  });
});

test("`Node<T>.abs()` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: -2 });
  expect(unwrapAst(a.abs())).toEqual(unwrapAst(abs(a)));
});

test("`max(node, node)` returns a `Node` carrying a `max` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 0.5 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 0.7 });
  expect(unwrapAst(max(a, b))).toEqual({
    kind: "max",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 0.5 },
    rhs: { kind: "literal", type: "f32", value: 0.7 },
  });
});

test("`Node<T>.max(other)` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 0.5 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 0.7 });
  expect(unwrapAst(a.max(b))).toEqual(unwrapAst(max(a, b)));
});

test("`max(number, number)` lifts both literals", () => {
  expect(unwrapAst(max(0.3, 0.8))).toEqual({
    kind: "max",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 0.3 },
    rhs: { kind: "literal", type: "f32", value: 0.8 },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// add (native f32.add)
// ─────────────────────────────────────────────────────────────────────────

test("`add(node, node)` returns a `Node` carrying an `add` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 2 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  expect(unwrapAst(P.add(a, b))).toEqual({
    kind: "add",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 2 },
    rhs: { kind: "literal", type: "f32", value: 3 },
  });
});

test("`add(node, number)` lifts the number literal (= f32 default)", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 2 });
  expect(unwrapAst(P.add(a, 0.5))).toEqual({
    kind: "add",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 2 },
    rhs: { kind: "literal", type: "f32", value: 0.5 },
  });
});

test("`add(number, number)` lifts both operands", () => {
  expect(unwrapAst(P.add(2, 3))).toEqual({
    kind: "add",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 2 },
    rhs: { kind: "literal", type: "f32", value: 3 },
  });
});

test("`Node<T>.add(other)` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 2 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  expect(unwrapAst(a.add(b))).toEqual(unwrapAst(P.add(a, b)));
});

// ─────────────────────────────────────────────────────────────────────────
// sub (native f32.sub)
// ─────────────────────────────────────────────────────────────────────────

test("`sub(node, node)` returns a `Node` carrying a `sub` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  expect(unwrapAst(P.sub(a, b))).toEqual({
    kind: "sub",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 5 },
    rhs: { kind: "literal", type: "f32", value: 3 },
  });
});

test("`sub(node, number)` lifts the number literal", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  expect(unwrapAst(P.sub(a, 0.5))).toEqual({
    kind: "sub",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 5 },
    rhs: { kind: "literal", type: "f32", value: 0.5 },
  });
});

test("`Node<T>.sub(other)` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  expect(unwrapAst(a.sub(b))).toEqual(unwrapAst(P.sub(a, b)));
});

// ─────────────────────────────────────────────────────────────────────────
// div (native f32.div)
// ─────────────────────────────────────────────────────────────────────────

test("`div(node, node)` returns a `Node` carrying a `div` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 10 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 2 });
  expect(unwrapAst(P.div(a, b))).toEqual({
    kind: "div",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 10 },
    rhs: { kind: "literal", type: "f32", value: 2 },
  });
});

test("`div(node, number)` lifts the number literal", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 10 });
  expect(unwrapAst(P.div(a, 4))).toEqual({
    kind: "div",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 10 },
    rhs: { kind: "literal", type: "f32", value: 4 },
  });
});

test("`Node<T>.div(other)` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 10 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 2 });
  expect(unwrapAst(a.div(b))).toEqual(unwrapAst(P.div(a, b)));
});

// ─────────────────────────────────────────────────────────────────────────
// min (native f32.min)
// ─────────────────────────────────────────────────────────────────────────

test("`min(node, node)` returns a `Node` carrying a `min` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  expect(unwrapAst(P.min(a, b))).toEqual({
    kind: "min",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 3 },
    rhs: { kind: "literal", type: "f32", value: 5 },
  });
});

test("`min(number, number)` lifts both operands", () => {
  expect(unwrapAst(P.min(0.3, 0.8))).toEqual({
    kind: "min",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 0.3 },
    rhs: { kind: "literal", type: "f32", value: 0.8 },
  });
});

test("`Node<T>.min(other)` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  expect(unwrapAst(a.min(b))).toEqual(unwrapAst(P.min(a, b)));
});

// ─────────────────────────────────────────────────────────────────────────
// neg (native f32.neg)
// ─────────────────────────────────────────────────────────────────────────

test("`neg(node)` returns a `Node` carrying a `neg` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  expect(unwrapAst(P.neg(a))).toEqual({
    kind: "neg",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 5 },
  });
});

test("`neg(number)` lifts the literal", () => {
  expect(unwrapAst(P.neg(0.5))).toEqual({
    kind: "neg",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 0.5 },
  });
});

test("`Node<T>.neg()` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  expect(unwrapAst(a.neg())).toEqual(unwrapAst(P.neg(a)));
});

// ─────────────────────────────────────────────────────────────────────────
// sqrt (native f32.sqrt)
// ─────────────────────────────────────────────────────────────────────────

test("`sqrt(node)` returns a `Node` carrying a `sqrt` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 4 });
  expect(unwrapAst(P.sqrt(a))).toEqual({
    kind: "sqrt",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 4 },
  });
});

test("`sqrt(number)` lifts the literal", () => {
  expect(unwrapAst(P.sqrt(2))).toEqual({
    kind: "sqrt",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 2 },
  });
});

test("`Node<T>.sqrt()` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 4 });
  expect(unwrapAst(a.sqrt())).toEqual(unwrapAst(P.sqrt(a)));
});

// ─────────────────────────────────────────────────────────────────────────
// floor (native f32.floor)
// ─────────────────────────────────────────────────────────────────────────

test("`floor(node)` returns a `Node` carrying a `floor` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 1.7 });
  expect(unwrapAst(P.floor(a))).toEqual({
    kind: "floor",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 1.7 },
  });
});

test("`floor(number)` lifts the literal", () => {
  expect(unwrapAst(P.floor(1.7))).toEqual({
    kind: "floor",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 1.7 },
  });
});

test("`Node<T>.floor()` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 1.7 });
  expect(unwrapAst(a.floor())).toEqual(unwrapAst(P.floor(a)));
});

// ─────────────────────────────────────────────────────────────────────────
// ceil (native f32.ceil)
// ─────────────────────────────────────────────────────────────────────────

test("`ceil(node)` returns a `Node` carrying a `ceil` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 1.2 });
  expect(unwrapAst(P.ceil(a))).toEqual({
    kind: "ceil",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 1.2 },
  });
});

test("`ceil(number)` lifts the literal", () => {
  expect(unwrapAst(P.ceil(1.2))).toEqual({
    kind: "ceil",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 1.2 },
  });
});

test("`Node<T>.ceil()` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 1.2 });
  expect(unwrapAst(a.ceil())).toEqual(unwrapAst(P.ceil(a)));
});

// ─────────────────────────────────────────────────────────────────────────
// eq (= f32.eq、結果 Node<'bool'>)
// ─────────────────────────────────────────────────────────────────────────

test("`eq(node, node)` returns a `Node` carrying an `eq` AST (operand type f32)", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  expect(unwrapAst(P.eq(a, b))).toEqual({
    kind: "eq",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 3 },
    rhs: { kind: "literal", type: "f32", value: 3 },
  });
});

test("`eq(node, number)` lifts the number literal", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  expect(unwrapAst(P.eq(a, 3))).toEqual({
    kind: "eq",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 3 },
    rhs: { kind: "literal", type: "f32", value: 3 },
  });
});

test("`Node<T>.eq(other)` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  expect(unwrapAst(a.eq(b))).toEqual(unwrapAst(P.eq(a, b)));
});

// ─────────────────────────────────────────────────────────────────────────
// lt (= f32.lt、結果 Node<'bool'>)
// ─────────────────────────────────────────────────────────────────────────

test("`lt(node, node)` returns a `Node` carrying an `lt` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  expect(unwrapAst(P.lt(a, b))).toEqual({
    kind: "lt",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 3 },
    rhs: { kind: "literal", type: "f32", value: 5 },
  });
});

test("`lt(node, number)` lifts the number literal", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  expect(unwrapAst(P.lt(a, 5))).toEqual({
    kind: "lt",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 3 },
    rhs: { kind: "literal", type: "f32", value: 5 },
  });
});

test("`Node<T>.lt(other)` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  expect(unwrapAst(a.lt(b))).toEqual(unwrapAst(P.lt(a, b)));
});

// ─────────────────────────────────────────────────────────────────────────
// gt (= f32.gt、結果 Node<'bool'>)
// ─────────────────────────────────────────────────────────────────────────

test("`gt(node, node)` returns a `Node` carrying a `gt` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  expect(unwrapAst(P.gt(a, b))).toEqual({
    kind: "gt",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 5 },
    rhs: { kind: "literal", type: "f32", value: 3 },
  });
});

test("`gt(node, number)` lifts the number literal", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  expect(unwrapAst(P.gt(a, 3))).toEqual({
    kind: "gt",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 5 },
    rhs: { kind: "literal", type: "f32", value: 3 },
  });
});

test("`Node<T>.gt(other)` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  expect(unwrapAst(a.gt(b))).toEqual(unwrapAst(P.gt(a, b)));
});

// ─────────────────────────────────────────────────────────────────────────
// lte (= f32.le、結果 Node<'bool'>)
// ─────────────────────────────────────────────────────────────────────────

test("`lte(node, node)` returns a `Node` carrying an `lte` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  expect(unwrapAst(P.lte(a, b))).toEqual({
    kind: "lte",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 3 },
    rhs: { kind: "literal", type: "f32", value: 5 },
  });
});

test("`lte(node, number)` lifts the number literal", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  expect(unwrapAst(P.lte(a, 5))).toEqual({
    kind: "lte",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 3 },
    rhs: { kind: "literal", type: "f32", value: 5 },
  });
});

test("`Node<T>.lte(other)` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  expect(unwrapAst(a.lte(b))).toEqual(unwrapAst(P.lte(a, b)));
});

// ─────────────────────────────────────────────────────────────────────────
// gte (= f32.ge、結果 Node<'bool'>)
// ─────────────────────────────────────────────────────────────────────────

test("`gte(node, node)` returns a `Node` carrying a `gte` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  expect(unwrapAst(P.gte(a, b))).toEqual({
    kind: "gte",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 5 },
    rhs: { kind: "literal", type: "f32", value: 3 },
  });
});

test("`gte(node, number)` lifts the number literal", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  expect(unwrapAst(P.gte(a, 3))).toEqual({
    kind: "gte",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 5 },
    rhs: { kind: "literal", type: "f32", value: 3 },
  });
});

test("`Node<T>.gte(other)` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  expect(unwrapAst(a.gte(b))).toEqual(unwrapAst(P.gte(a, b)));
});

// ─────────────────────────────────────────────────────────────────────────
// clamp (= min(max(x, lo), hi))
// ─────────────────────────────────────────────────────────────────────────

test("`clamp(node, lo, hi)` returns a `Node` carrying a `clamp` AST", () => {
  const x = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  expect(unwrapAst(P.clamp(x, 0, 1))).toEqual({
    kind: "clamp",
    type: "f32",
    x: { kind: "literal", type: "f32", value: 5 },
    lo: { kind: "literal", type: "f32", value: 0 },
    hi: { kind: "literal", type: "f32", value: 1 },
  });
});

test("`clamp(number, number, number)` lifts all operands", () => {
  expect(unwrapAst(P.clamp(0.5, 0, 1))).toEqual({
    kind: "clamp",
    type: "f32",
    x: { kind: "literal", type: "f32", value: 0.5 },
    lo: { kind: "literal", type: "f32", value: 0 },
    hi: { kind: "literal", type: "f32", value: 1 },
  });
});

test("`Node<T>.clamp(lo, hi)` method form = free function 同 AST", () => {
  const x = wrapAst<"f32">({ kind: "literal", type: "f32", value: 5 });
  expect(unwrapAst(x.clamp(0, 1))).toEqual(unwrapAst(P.clamp(x, 0, 1)));
});

// ─────────────────────────────────────────────────────────────────────────
// select (= WASM select 命令、free function のみ)
// ─────────────────────────────────────────────────────────────────────────

test("`select(condNode, then, else)` returns a `Node` carrying a `select` AST", () => {
  const cond = wrapAst<"bool">({
    kind: "gt",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 5 },
    rhs: { kind: "literal", type: "f32", value: 3 },
  });
  expect(unwrapAst(P.select(cond, 10, 20))).toEqual({
    kind: "select",
    type: "f32",
    cond: {
      kind: "gt",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: 5 },
      rhs: { kind: "literal", type: "f32", value: 3 },
    },
    then: { kind: "literal", type: "f32", value: 10 },
    else: { kind: "literal", type: "f32", value: 20 },
  });
});

test("`select(true, then, else)` lifts the boolean literal cond to a `bool` literal node", () => {
  expect(unwrapAst(P.select(true, 1, 0))).toEqual({
    kind: "select",
    type: "f32",
    cond: { kind: "literal", type: "bool", value: 1 },
    then: { kind: "literal", type: "f32", value: 1 },
    else: { kind: "literal", type: "f32", value: 0 },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// frac (= x - floor(x))
// ─────────────────────────────────────────────────────────────────────────

test("`frac(node)` returns a `Node` carrying a `frac` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 1.25 });
  expect(unwrapAst(P.frac(a))).toEqual({
    kind: "frac",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 1.25 },
  });
});

test("`frac(number)` lifts the literal", () => {
  expect(unwrapAst(P.frac(1.25))).toEqual({
    kind: "frac",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 1.25 },
  });
});

test("`Node<T>.frac()` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 1.25 });
  expect(unwrapAst(a.frac())).toEqual(unwrapAst(P.frac(a)));
});

// ─────────────────────────────────────────────────────────────────────────
// mod (= a - trunc(a/b)*b、JS `%` 準拠)
// ─────────────────────────────────────────────────────────────────────────

test("`mod(node, node)` returns a `Node` carrying a `mod` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 7 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  expect(unwrapAst(P.mod(a, b))).toEqual({
    kind: "mod",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 7 },
    rhs: { kind: "literal", type: "f32", value: 3 },
  });
});

test("`mod(node, number)` lifts the number literal", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 7 });
  expect(unwrapAst(P.mod(a, 3))).toEqual({
    kind: "mod",
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: 7 },
    rhs: { kind: "literal", type: "f32", value: 3 },
  });
});

test("`Node<T>.mod(other)` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 7 });
  const b = wrapAst<"f32">({ kind: "literal", type: "f32", value: 3 });
  expect(unwrapAst(a.mod(b))).toEqual(unwrapAst(P.mod(a, b)));
});

// ─────────────────────────────────────────────────────────────────────────
// sin (= 多項式近似、共有 WASM 関数)
// ─────────────────────────────────────────────────────────────────────────

test("`sin(node)` returns a `Node` carrying a `sin` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 1 });
  expect(unwrapAst(P.sin(a))).toEqual({
    kind: "sin",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 1 },
  });
});

test("`sin(number)` lifts the literal", () => {
  expect(unwrapAst(P.sin(1))).toEqual({
    kind: "sin",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 1 },
  });
});

test("`Node<T>.sin()` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 1 });
  expect(unwrapAst(a.sin())).toEqual(unwrapAst(P.sin(a)));
});

// ─────────────────────────────────────────────────────────────────────────
// cos (= sin(x + π/2)、共有 WASM 関数)
// ─────────────────────────────────────────────────────────────────────────

test("`cos(node)` returns a `Node` carrying a `cos` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 1 });
  expect(unwrapAst(P.cos(a))).toEqual({
    kind: "cos",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 1 },
  });
});

test("`cos(number)` lifts the literal", () => {
  expect(unwrapAst(P.cos(1))).toEqual({
    kind: "cos",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 1 },
  });
});

test("`Node<T>.cos()` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 1 });
  expect(unwrapAst(a.cos())).toEqual(unwrapAst(P.cos(a)));
});

// ─────────────────────────────────────────────────────────────────────────
// tan (= sin(x)/cos(x)、共有 WASM 関数)
// ─────────────────────────────────────────────────────────────────────────

test("`tan(node)` returns a `Node` carrying a `tan` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 1 });
  expect(unwrapAst(P.tan(a))).toEqual({
    kind: "tan",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 1 },
  });
});

test("`tan(number)` lifts the literal", () => {
  expect(unwrapAst(P.tan(1))).toEqual({
    kind: "tan",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 1 },
  });
});

test("`Node<T>.tan()` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 1 });
  expect(unwrapAst(a.tan())).toEqual(unwrapAst(P.tan(a)));
});

// ─────────────────────────────────────────────────────────────────────────
// exp (= 2^k·exp(r) 分解、共有 WASM 関数)
// ─────────────────────────────────────────────────────────────────────────

test("`exp(node)` returns a `Node` carrying an `exp` AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 1 });
  expect(unwrapAst(P.exp(a))).toEqual({
    kind: "exp",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 1 },
  });
});

test("`exp(number)` lifts the literal", () => {
  expect(unwrapAst(P.exp(1))).toEqual({
    kind: "exp",
    type: "f32",
    value: { kind: "literal", type: "f32", value: 1 },
  });
});

test("`Node<T>.exp()` method form = free function 同 AST", () => {
  const a = wrapAst<"f32">({ kind: "literal", type: "f32", value: 1 });
  expect(unwrapAst(a.exp())).toEqual(unwrapAst(P.exp(a)));
});
