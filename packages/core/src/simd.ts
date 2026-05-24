/**
 * `@unworklet/core/simd` — opt-in SIMD surface (`01-dsl.md` §7).
 *
 * Scalar-only authors never import this path; importing it brings the
 * vec primitives + the `Node<'f32x4'>` lane access method + the
 * `Buffer<'f32'>` SIMD load/store methods into scope via declaration
 * merging into `./types.ts`.
 *
 * v1.0.0 surface (= MVP):
 * - Construction: `vec4`, `splat`
 * - Arithmetic: `addVec`, `subVec`, `mulVec`, `divVec`
 * - Horizontal reduction: `sumLanes`
 * - Vec4 method form (Q77): `add` / `sub` / `mul` / `div` (already on the
 *   base `Node<T>` interface — works at `T = 'f32x4'` directly), plus
 *   `lane(i: 0|1|2|3)` extracted here.
 * - Buffer SIMD I/O: `loadVec` / `storeVec` extended onto `Buffer<'f32'>`.
 */

import type { Node } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────
// Declaration merging — Node<'f32x4'> lane + Buffer<'f32'> SIMD methods
// ─────────────────────────────────────────────────────────────────────────

declare module "./types.ts" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Node<
    T extends import("./types.ts").ScalarType | "f32x4" = import("./types.ts").ScalarType,
  > {
    /** SIMD lane access — only resolves to a real value type when `T = 'f32x4'`. */
    lane(i: 0 | 1 | 2 | 3): T extends "f32x4" ? Node<"f32"> : never;
  }

  interface Buffer<T extends import("./types.ts").BufferElementType> {
    /** Load four contiguous f32 lanes from a buffer (element-units offset). */
    loadVec(offset: Node<"i32">): T extends "f32" ? Node<"f32x4"> : never;
    /** Store four contiguous f32 lanes into a buffer. */
    storeVec(offset: Node<"i32">, value: Node<"f32x4">): T extends "f32" ? void : never;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Free function form
// ─────────────────────────────────────────────────────────────────────────

const notImplemented = (): never => {
  throw new Error("not implemented");
};

/** Pack 4 scalars into a `Node<'f32x4'>`. */
export function vec4(
  _a: Node<"f32"> | number,
  _b: Node<"f32"> | number,
  _c: Node<"f32"> | number,
  _d: Node<"f32"> | number,
): Node<"f32x4"> {
  return notImplemented();
}

/** Broadcast a scalar to all four lanes. */
export function splat(_x: Node<"f32"> | number): Node<"f32x4"> {
  return notImplemented();
}

export function addVec(_a: Node<"f32x4">, _b: Node<"f32x4">): Node<"f32x4"> {
  return notImplemented();
}

export function subVec(_a: Node<"f32x4">, _b: Node<"f32x4">): Node<"f32x4"> {
  return notImplemented();
}

export function mulVec(_a: Node<"f32x4">, _b: Node<"f32x4">): Node<"f32x4"> {
  return notImplemented();
}

export function divVec(_a: Node<"f32x4">, _b: Node<"f32x4">): Node<"f32x4"> {
  return notImplemented();
}

/**
 * Collapse a 4-lane vec to a scalar by summing all lanes (Q59).
 * Equivalent to `add(add(v.lane(0), v.lane(1)), add(v.lane(2), v.lane(3)))`
 * but compiled as a single shuffle + add sequence.
 */
export function sumLanes(_v: Node<"f32x4">): Node<"f32"> {
  return notImplemented();
}
