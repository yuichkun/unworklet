/**
 * Scalar constructors (`01-dsl.md` §2.2 + `decisions-log.md` Q33 + Q77).
 *
 * Used wherever the implicit literal lift does not apply — declarations,
 * ambiguous-call disambiguation, i64 construction (BigInt-required),
 * cross-precision conversion, and method-chain starting points (`num(v)`).
 */

import type { Node, ScalarType } from "../types.ts";

const notImplemented = (): never => {
  throw new Error("not implemented");
};

export function f32(_v: number | Node<ScalarType>): Node<"f32"> {
  return notImplemented();
}

export function f64(_v: number | Node<ScalarType>): Node<"f64"> {
  return notImplemented();
}

export function i32(_v: number | Node<ScalarType>): Node<"i32"> {
  return notImplemented();
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
