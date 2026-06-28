/**
 * Scalar constructors (`01-dsl.md` §2.2 + `decisions-log.md` Q33).
 *
 * Used wherever the implicit literal lift does not apply — declarations,
 * ambiguous-call disambiguation, i64 construction (BigInt-required), and
 * cross-precision conversion.
 *
 * A JS `number` lifts to a literal of the constructor's type; a `Node<T>`
 * lifts to a cross-precision `convert` node (or passes through unchanged when
 * the source type already matches the target).
 */

import { inferAstType } from "../compile/ast.ts";
import { unwrapAst, wrapAst } from "../compile/capture.ts";
import type { Node, ScalarType } from "../types.ts";

function convertTo<T extends ScalarType>(target: T, node: Node<ScalarType>): Node<T> {
  const value = unwrapAst(node);
  const from = inferAstType(value);
  if (from === target) return wrapAst<T>(value);
  return wrapAst<T>({ kind: "convert", type: target, from, value });
}

export function f32(v: number | Node<ScalarType>): Node<"f32"> {
  if (typeof v === "number") return wrapAst<"f32">({ kind: "literal", type: "f32", value: v });
  return convertTo("f32", v);
}

export function f64(v: number | Node<ScalarType>): Node<"f64"> {
  if (typeof v === "number") return wrapAst<"f64">({ kind: "literal", type: "f64", value: v });
  return convertTo("f64", v);
}

export function i32(v: number | Node<ScalarType>): Node<"i32"> {
  // `v | 0` = ToInt32 (truncate toward zero + 32-bit wrap = WASM i32 literal semantics).
  if (typeof v === "number") return wrapAst<"i32">({ kind: "literal", type: "i32", value: v | 0 });
  return convertTo("i32", v);
}

export function i64(v: bigint): Node<"i64"> {
  // No implicit number lift (Q33-c): BigInt is the only accepted input, so an
  // i64 literal always carries a `bigint` value.
  return wrapAst<"i64">({ kind: "literal", type: "i64", value: v });
}

export function bool(v: boolean): Node<"bool">;
export function bool(v: Node<ScalarType>): Node<"bool">;
export function bool(v: boolean | Node<ScalarType>): Node<"bool"> {
  // bool is represented internally as i32 (0/1). A boolean literal maps directly,
  // while a numeric Node is converted explicitly via `x != 0` (see `01-dsl.md`
  // §4 "Integer and boolean conversions").
  if (typeof v === "boolean") {
    return wrapAst<"bool">({ kind: "literal", type: "bool", value: v ? 1 : 0 });
  }
  return convertTo("bool", v);
}
