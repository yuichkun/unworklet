/**
 * DSL primitive operators (`01-dsl.md` §2 + Q77 hybrid policy).
 *
 * Each primitive is exposed in two equivalent forms:
 * - free function (e.g. `add(a, b)`)
 * - method on `Node<T>` (e.g. `a.add(b)`)
 *
 * Both shapes compile to the same captured graph node. This file declares
 * the free function form as named exports and extends the `Node<T>`
 * interface (from `../types.ts`) with the method form via TypeScript
 * declaration merging.
 */

import type { AstNode } from "../compile/ast.ts";
import { registerNodeMethod, unwrapAst, wrapAst } from "../compile/capture.ts";
import type { Node, ScalarType } from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────
// Node<T> method form (= Q77 chain, declaration merging into `../types.ts`)
// ─────────────────────────────────────────────────────────────────────────

declare module "../types.ts" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Node<T extends ScalarType | "f32x4" = ScalarType> {
    // Arithmetic
    add(other: Node<T> | number): Node<T>;
    sub(other: Node<T> | number): Node<T>;
    mul(other: Node<T> | number): Node<T>;
    div(other: Node<T> | number): Node<T>;
    mod(other: Node<T> | number): Node<T>;
    neg(): Node<T>;
    // Comparison
    eq(other: Node<T> | number): Node<"bool">;
    lt(other: Node<T> | number): Node<"bool">;
    gt(other: Node<T> | number): Node<"bool">;
    lte(other: Node<T> | number): Node<"bool">;
    gte(other: Node<T> | number): Node<"bool">;
    // Math
    sin(): Node<T>;
    cos(): Node<T>;
    tan(): Node<T>;
    tanh(): Node<T>;
    exp(): Node<T>;
    log(): Node<T>;
    sqrt(): Node<T>;
    abs(): Node<T>;
    floor(): Node<T>;
    ceil(): Node<T>;
    frac(): Node<T>;
    min(other: Node<T> | number): Node<T>;
    max(other: Node<T> | number): Node<T>;
    clamp(lo: Node<T> | number, hi: Node<T> | number): Node<T>;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Free function form
// ─────────────────────────────────────────────────────────────────────────

const notImplemented = (): never => {
  throw new Error("not implemented");
};

// Arithmetic (T extends 'f32' | 'f64' | 'i32' | 'i64' — generic over ScalarType for stub)
export function add<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  return wrapAst<T>({
    kind: "add",
    type: "f32",
    lhs: liftToAst(a),
    rhs: liftToAst(b),
  });
}
registerNodeMethod("add", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<T> {
  return add(this, other);
});
export function sub<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  return wrapAst<T>({
    kind: "sub",
    type: "f32",
    lhs: liftToAst(a),
    rhs: liftToAst(b),
  });
}
registerNodeMethod("sub", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<T> {
  return sub(this, other);
});
export function mul<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  return wrapAst<T>({
    kind: "mul",
    type: "f32",
    lhs: liftToAst(a),
    rhs: liftToAst(b),
  });
}

// JS literal → `{ kind: 'literal', type: 'f32', value }` lift (= Q33 context-
// dependent lift の Phase 3 minimum、 後 続 phase で T-aware fill)。
function liftToAst<T extends ScalarType>(value: Node<T> | number): AstNode {
  if (typeof value === "number") {
    return { kind: "literal", type: "f32", value };
  }
  return unwrapAst(value);
}

// Method form dispatch (= Q77 hybrid)。 module load 時 に prototype に
// `mul` を 登 録、 wrapped `Node<T>` か ら `.mul(other)` が free function
// と 同 AST を 構 築。
registerNodeMethod("mul", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<T> {
  return mul(this, other);
});
export function div<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  return wrapAst<T>({
    kind: "div",
    type: "f32",
    lhs: liftToAst(a),
    rhs: liftToAst(b),
  });
}
registerNodeMethod("div", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<T> {
  return div(this, other);
});
export function mod<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  return wrapAst<T>({
    kind: "mod",
    type: "f32",
    lhs: liftToAst(a),
    rhs: liftToAst(b),
  });
}
registerNodeMethod("mod", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<T> {
  return mod(this, other);
});
export function neg<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({
    kind: "neg",
    type: "f32",
    value: liftToAst(x),
  });
}
registerNodeMethod("neg", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return neg(this);
});

// Comparison (returns Node<'bool'>)
export function eq<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<"bool"> {
  return wrapAst<"bool">({
    kind: "eq",
    type: "f32",
    lhs: liftToAst(a),
    rhs: liftToAst(b),
  });
}
registerNodeMethod("eq", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<"bool"> {
  return eq(this, other);
});
export function lt<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<"bool"> {
  return wrapAst<"bool">({
    kind: "lt",
    type: "f32",
    lhs: liftToAst(a),
    rhs: liftToAst(b),
  });
}
registerNodeMethod("lt", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<"bool"> {
  return lt(this, other);
});
export function gt<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<"bool"> {
  return wrapAst<"bool">({
    kind: "gt",
    type: "f32",
    lhs: liftToAst(a),
    rhs: liftToAst(b),
  });
}
registerNodeMethod("gt", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<"bool"> {
  return gt(this, other);
});
export function lte<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<"bool"> {
  return wrapAst<"bool">({
    kind: "lte",
    type: "f32",
    lhs: liftToAst(a),
    rhs: liftToAst(b),
  });
}
registerNodeMethod("lte", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<"bool"> {
  return lte(this, other);
});
export function gte<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<"bool"> {
  return wrapAst<"bool">({
    kind: "gte",
    type: "f32",
    lhs: liftToAst(a),
    rhs: liftToAst(b),
  });
}
registerNodeMethod("gte", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<"bool"> {
  return gte(this, other);
});

// Math (f32 / f64 — generic over ScalarType for stub)
export function sin<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({
    kind: "sin",
    type: "f32",
    value: liftToAst(x),
  });
}
registerNodeMethod("sin", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return sin(this);
});
export function cos<T extends ScalarType>(_x: Node<T> | number): Node<T> {
  return notImplemented();
}
export function tan<T extends ScalarType>(_x: Node<T> | number): Node<T> {
  return notImplemented();
}
export function tanh<T extends ScalarType>(_x: Node<T> | number): Node<T> {
  return notImplemented();
}
export function exp<T extends ScalarType>(_x: Node<T> | number): Node<T> {
  return notImplemented();
}
export function log<T extends ScalarType>(_x: Node<T> | number): Node<T> {
  return notImplemented();
}
export function sqrt<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({
    kind: "sqrt",
    type: "f32",
    value: liftToAst(x),
  });
}
registerNodeMethod("sqrt", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return sqrt(this);
});
export function abs<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({
    kind: "abs",
    type: "f32",
    value: liftToAst(x),
  });
}
registerNodeMethod("abs", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return abs(this);
});
export function floor<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({
    kind: "floor",
    type: "f32",
    value: liftToAst(x),
  });
}
registerNodeMethod("floor", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return floor(this);
});
export function ceil<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({
    kind: "ceil",
    type: "f32",
    value: liftToAst(x),
  });
}
registerNodeMethod("ceil", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return ceil(this);
});
export function frac<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({
    kind: "frac",
    type: "f32",
    value: liftToAst(x),
  });
}
registerNodeMethod("frac", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return frac(this);
});
export function min<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  return wrapAst<T>({
    kind: "min",
    type: "f32",
    lhs: liftToAst(a),
    rhs: liftToAst(b),
  });
}
registerNodeMethod("min", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<T> {
  return min(this, other);
});
export function max<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  return wrapAst<T>({
    kind: "max",
    type: "f32",
    lhs: liftToAst(a),
    rhs: liftToAst(b),
  });
}
registerNodeMethod("max", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<T> {
  return max(this, other);
});
export function clamp<T extends ScalarType>(
  x: Node<T> | number,
  lo: Node<T> | number,
  hi: Node<T> | number,
): Node<T> {
  return wrapAst<T>({
    kind: "clamp",
    type: "f32",
    x: liftToAst(x),
    lo: liftToAst(lo),
    hi: liftToAst(hi),
  });
}
registerNodeMethod("clamp", function method<
  T extends ScalarType,
>(this: Node<T>, lo: Node<T> | number, hi: Node<T> | number): Node<T> {
  return clamp(this, lo, hi);
});

// Control
export function select<T extends ScalarType>(
  cond: Node<"bool"> | boolean,
  then: Node<T> | number,
  else_: Node<T> | number,
): Node<T> {
  return wrapAst<T>({
    kind: "select",
    type: "f32",
    cond:
      typeof cond === "boolean"
        ? { kind: "literal", type: "bool", value: cond ? 1 : 0 }
        : unwrapAst(cond),
    then: liftToAst(then),
    else: liftToAst(else_),
  });
}
