/**
 * `pipe(x, ...fns)` free function + `Node<T>.pipe(fn)` method (RFC-001 S10).
 *
 * Pure left-to-right composition: `pipe(x, f, g)` is exactly `g(f(x))`, and
 * `x.pipe(f)` is `f(x)`. It has no graph node of its own — it just threads a
 * value through a sequence of transforms, so the captured graph (and the emitted
 * WASM) is byte-identical to the hand-composed chain. Improves readability when
 * user-defined L1 helpers interleave with primitive operations.
 */

import { registerNodeMethod } from "../compile/capture.ts";
import type { Node, ScalarType } from "../types.ts";

// The `Node<T>.pipe(fn)` method is declared on the `Node` interface in
// `../types.ts` (co-located with `Node` so it survives dts bundling); this file
// owns the runtime impl (free function + `registerNodeMethod`).

export function pipe<A>(x: A): A;
export function pipe<A, B>(x: A, f1: (x: A) => B): B;
export function pipe<A, B, C>(x: A, f1: (x: A) => B, f2: (x: B) => C): C;
export function pipe<A, B, C, D>(x: A, f1: (x: A) => B, f2: (x: B) => C, f3: (x: C) => D): D;
export function pipe<A, B, C, D, E>(
  x: A,
  f1: (x: A) => B,
  f2: (x: B) => C,
  f3: (x: C) => D,
  f4: (x: D) => E,
): E;
export function pipe<A, B, C, D, E, F>(
  x: A,
  f1: (x: A) => B,
  f2: (x: B) => C,
  f3: (x: C) => D,
  f4: (x: D) => E,
  f5: (x: E) => F,
): F;
export function pipe<A, B, C, D, E, F, G>(
  x: A,
  f1: (x: A) => B,
  f2: (x: B) => C,
  f3: (x: C) => D,
  f4: (x: D) => E,
  f5: (x: E) => F,
  f6: (x: F) => G,
): G;
export function pipe<A, B, C, D, E, F, G, H>(
  x: A,
  f1: (x: A) => B,
  f2: (x: B) => C,
  f3: (x: C) => D,
  f4: (x: D) => E,
  f5: (x: E) => F,
  f6: (x: F) => G,
  f7: (x: G) => H,
): H;
export function pipe(x: unknown, ...fns: Array<(v: unknown) => unknown>): unknown {
  return fns.reduce((acc, fn) => fn(acc), x);
}

registerNodeMethod("pipe", function (this: Node<ScalarType>, fn: (x: Node<ScalarType>) => unknown) {
  return fn(this);
});
