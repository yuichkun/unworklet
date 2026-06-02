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

import type { AstNode } from "./compile/ast.ts";
import { isWrappedNode, registerNodeMethod, unwrapAst, wrapAst } from "./compile/capture.ts";
import type { Node } from "./types.ts";

/** Lift a scalar (f32) argument into an AST node (number → f32 literal, Node → unwrap). */
const liftLane = (v: Node<"f32"> | number): AstNode =>
  isWrappedNode(v) ? unwrapAst(v) : { kind: "literal", type: "f32", value: v };

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
    loadVec(offset: Node<"i32"> | number): T extends "f32" ? Node<"f32x4"> : never;
    /** Store four contiguous f32 lanes into a buffer. */
    storeVec(offset: Node<"i32"> | number, value: Node<"f32x4">): T extends "f32" ? void : never;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Free function form
// ─────────────────────────────────────────────────────────────────────────

/** Pack 4 scalars into a `Node<'f32x4'>`. */
export function vec4(
  a: Node<"f32"> | number,
  b: Node<"f32"> | number,
  c: Node<"f32"> | number,
  d: Node<"f32"> | number,
): Node<"f32x4"> {
  return wrapAst<"f32x4">({
    kind: "vecConst",
    lanes: [liftLane(a), liftLane(b), liftLane(c), liftLane(d)],
  });
}

/** Broadcast a scalar to all four lanes. */
export function splat(x: Node<"f32"> | number): Node<"f32x4"> {
  return wrapAst<"f32x4">({ kind: "vecSplat", value: liftLane(x) });
}

export function addVec(a: Node<"f32x4">, b: Node<"f32x4">): Node<"f32x4"> {
  return wrapAst<"f32x4">({ kind: "vecAdd", lhs: unwrapAst(a), rhs: unwrapAst(b) });
}

export function subVec(a: Node<"f32x4">, b: Node<"f32x4">): Node<"f32x4"> {
  return wrapAst<"f32x4">({ kind: "vecSub", lhs: unwrapAst(a), rhs: unwrapAst(b) });
}

export function mulVec(a: Node<"f32x4">, b: Node<"f32x4">): Node<"f32x4"> {
  return wrapAst<"f32x4">({ kind: "vecMul", lhs: unwrapAst(a), rhs: unwrapAst(b) });
}

export function divVec(a: Node<"f32x4">, b: Node<"f32x4">): Node<"f32x4"> {
  return wrapAst<"f32x4">({ kind: "vecDiv", lhs: unwrapAst(a), rhs: unwrapAst(b) });
}

/**
 * Collapse a 4-lane vec to a scalar by summing all lanes (Q59).
 * Equivalent to `add(add(v.lane(0), v.lane(1)), add(v.lane(2), v.lane(3)))`.
 */
export function sumLanes(v: Node<"f32x4">): Node<"f32"> {
  return wrapAst<"f32">({ kind: "vecSumLanes", value: unwrapAst(v) });
}

// `.lane(i)` method form (§7 — constant lane index 0..3 → Node<'f32'>).
registerNodeMethod("lane", function lane(this: Node<"f32x4">, i: 0 | 1 | 2 | 3): Node<"f32"> {
  return wrapAst<"f32">({ kind: "vecLane", index: i, value: unwrapAst(this) });
});
