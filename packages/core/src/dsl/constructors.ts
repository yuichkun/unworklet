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

const notImplemented = (): never => {
  throw new Error("not implemented");
};

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

export function f64(_v: number | Node<ScalarType>): Node<"f64"> {
  return notImplemented();
}

export function i32(v: number | Node<ScalarType>): Node<"i32"> {
  // `v | 0` = ToInt32 (truncate toward zero + 32-bit wrap = WASM i32 literal semantics).
  if (typeof v === "number") return wrapAst<"i32">({ kind: "literal", type: "i32", value: v | 0 });
  return convertTo("i32", v);
}

export function i64(_v: bigint): Node<"i64"> {
  return notImplemented();
}

export function bool(_v: boolean | Node<"bool">): Node<"bool"> {
  return notImplemented();
}

/**
 * Method-chain starting helper (Q77). `T` is inferred from the surrounding
 * context (= the type of the value passed to the next method in the chain);
 * falls back to `'f32'` when no context constrains it.
 */
export function num<T extends ScalarType = "f32">(_v: number | boolean): Node<T> {
  return notImplemented();
}
