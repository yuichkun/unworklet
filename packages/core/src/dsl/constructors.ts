/**
 * Scalar constructors (`01-dsl.md` §2.2 + `decisions-log.md` Q33 + Q77).
 *
 * Used wherever the implicit literal lift does not apply — declarations,
 * ambiguous-call disambiguation, i64 construction (BigInt-required),
 * cross-precision conversion, and method-chain starting points (`num(v)`).
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

/**
 * Method-chain starting helper (Q77). `T` is inferred from the surrounding
 * context (= the type of the value passed to the next method in the chain);
 * falls back to `'f32'` when no context constrains it. A boolean argument
 * fixes `T = 'bool'` unambiguously.
 *
 * A numeric `num` captures a **loose** literal: it carries the JS value with a
 * fallback `'f32'` type and defers to the chain's first concretely-typed
 * sibling (so `num(1).sub(mix)` follows `mix`'s type). With no typed sibling it
 * stays `'f32'`.
 */
export function num(v: boolean): Node<"bool">;
export function num<T extends ScalarType = "f32">(v: number): Node<T>;
export function num<T extends ScalarType = "f32">(v: number | boolean): Node<T> {
  if (typeof v === "boolean") {
    return wrapAst<T>({ kind: "literal", type: "bool", value: v ? 1 : 0 });
  }
  return wrapAst<T>({ kind: "literal", type: "f32", value: v, loose: true });
}
