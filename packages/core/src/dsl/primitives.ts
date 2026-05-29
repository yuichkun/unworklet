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
 *
 * Arithmetic and comparison primitives are **polymorphic** over the scalar
 * type (`'f32' | 'f64' | 'i32' | 'i64'`, plus `'bool'` for comparison): the
 * operand type is inferred from the first `Node<T>` argument (literals lift to
 * that type via the context-dependent rule, Q33), and is carried on the AST
 * node so emission picks the matching WASM instruction. All-literal calls fall
 * back to `'f32'`. Math primitives (`sin`, `min`, `clamp`, …) stay `f32` here;
 * `f64` math lands with the f64 path.
 */

import type { AstNode } from "../compile/ast.ts";
import { inferAstType } from "../compile/ast.ts";
import { isWrappedNode, registerNodeMethod, unwrapAst, wrapAst } from "../compile/capture.ts";
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
// Type inference + literal lift (= Q33 context-dependent lift)
// ─────────────────────────────────────────────────────────────────────────

type Operand = Node<ScalarType> | number | boolean;

/**
 * The scalar type of a polymorphic primitive call: the type of the first
 * `Node<T>` operand, else `'bool'` when only boolean literals are present,
 * else `'f32'` (the all-literal numeric default).
 */
function operandType(...operands: Operand[]): ScalarType {
  for (const op of operands) {
    if (isWrappedNode(op)) return inferAstType(unwrapAst(op));
  }
  for (const op of operands) {
    if (typeof op === "boolean") return "bool";
  }
  return "f32";
}

/** Lift an operand to an AST node of type `t` (Q33 literal lift). */
function lift(value: Operand, t: ScalarType): AstNode {
  if (typeof value === "boolean") {
    // bool は 内 部 i32 表 現 (= 0/1)。
    return { kind: "literal", type: "bool", value: value ? 1 : 0 };
  }
  if (typeof value === "number") {
    if (t === "i64") {
      // i64 has no implicit number lift (Q33-c): JS number cannot safely
      // represent integers beyond 2^53. Use i64(BigInt(...)) explicitly.
      throw new Error(
        "unworklet: a JS number literal cannot lift to i64 (precision unsafe beyond 2^53 - 1). Use i64(BigInt(...)) explicitly.",
      );
    }
    // i32 stores ToInt32; f32 / f64 store the value as-is.
    return { kind: "literal", type: t, value: t === "i32" ? value | 0 : value };
  }
  return unwrapAst(value);
}

// ─────────────────────────────────────────────────────────────────────────
// Arithmetic (polymorphic over 'f32' | 'f64' | 'i32' | 'i64')
// ─────────────────────────────────────────────────────────────────────────

export function add<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  const t = operandType(a, b);
  return wrapAst<T>({ kind: "add", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("add", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<T> {
  return add(this, other);
});

export function sub<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  const t = operandType(a, b);
  return wrapAst<T>({ kind: "sub", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("sub", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<T> {
  return sub(this, other);
});

export function mul<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  const t = operandType(a, b);
  return wrapAst<T>({ kind: "mul", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("mul", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<T> {
  return mul(this, other);
});

export function div<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  const t = operandType(a, b);
  return wrapAst<T>({ kind: "div", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("div", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<T> {
  return div(this, other);
});

export function mod<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  const t = operandType(a, b);
  return wrapAst<T>({ kind: "mod", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("mod", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<T> {
  return mod(this, other);
});

export function neg<T extends ScalarType>(x: Node<T> | number): Node<T> {
  const t = operandType(x);
  return wrapAst<T>({ kind: "neg", type: t, value: lift(x, t) });
}
registerNodeMethod("neg", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return neg(this);
});

// ─────────────────────────────────────────────────────────────────────────
// Comparison (polymorphic operands, returns Node<'bool'>; node.type carries
// the operand type so emission selects the signed/float compare instruction)
// ─────────────────────────────────────────────────────────────────────────

export function eq<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<"bool"> {
  const t = operandType(a, b);
  return wrapAst<"bool">({ kind: "eq", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("eq", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<"bool"> {
  return eq(this, other);
});

export function lt<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<"bool"> {
  const t = operandType(a, b);
  return wrapAst<"bool">({ kind: "lt", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("lt", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<"bool"> {
  return lt(this, other);
});

export function gt<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<"bool"> {
  const t = operandType(a, b);
  return wrapAst<"bool">({ kind: "gt", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("gt", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<"bool"> {
  return gt(this, other);
});

export function lte<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<"bool"> {
  const t = operandType(a, b);
  return wrapAst<"bool">({ kind: "lte", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("lte", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<"bool"> {
  return lte(this, other);
});

export function gte<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<"bool"> {
  const t = operandType(a, b);
  return wrapAst<"bool">({ kind: "gte", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("gte", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<"bool"> {
  return gte(this, other);
});

// ─────────────────────────────────────────────────────────────────────────
// Math (f32 / f64 — `f64` lowering lands with the f64 path; `f32` here)
// ─────────────────────────────────────────────────────────────────────────

export function sin<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({ kind: "sin", type: "f32", value: lift(x, "f32") });
}
registerNodeMethod("sin", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return sin(this);
});
export function cos<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({ kind: "cos", type: "f32", value: lift(x, "f32") });
}
registerNodeMethod("cos", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return cos(this);
});
export function tan<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({ kind: "tan", type: "f32", value: lift(x, "f32") });
}
registerNodeMethod("tan", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return tan(this);
});
export function tanh<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({ kind: "tanh", type: "f32", value: lift(x, "f32") });
}
registerNodeMethod("tanh", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return tanh(this);
});
export function exp<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({ kind: "exp", type: "f32", value: lift(x, "f32") });
}
registerNodeMethod("exp", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return exp(this);
});
export function log<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({ kind: "log", type: "f32", value: lift(x, "f32") });
}
registerNodeMethod("log", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return log(this);
});
export function sqrt<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({ kind: "sqrt", type: "f32", value: lift(x, "f32") });
}
registerNodeMethod("sqrt", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return sqrt(this);
});
export function abs<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({ kind: "abs", type: "f32", value: lift(x, "f32") });
}
registerNodeMethod("abs", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return abs(this);
});
export function floor<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({ kind: "floor", type: "f32", value: lift(x, "f32") });
}
registerNodeMethod("floor", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return floor(this);
});
export function ceil<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({ kind: "ceil", type: "f32", value: lift(x, "f32") });
}
registerNodeMethod("ceil", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return ceil(this);
});
export function frac<T extends ScalarType>(x: Node<T> | number): Node<T> {
  return wrapAst<T>({ kind: "frac", type: "f32", value: lift(x, "f32") });
}
registerNodeMethod("frac", function method<T extends ScalarType>(this: Node<T>): Node<T> {
  return frac(this);
});
export function min<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  return wrapAst<T>({ kind: "min", type: "f32", lhs: lift(a, "f32"), rhs: lift(b, "f32") });
}
registerNodeMethod("min", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<T> {
  return min(this, other);
});
export function max<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  return wrapAst<T>({ kind: "max", type: "f32", lhs: lift(a, "f32"), rhs: lift(b, "f32") });
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
    x: lift(x, "f32"),
    lo: lift(lo, "f32"),
    hi: lift(hi, "f32"),
  });
}
registerNodeMethod("clamp", function method<
  T extends ScalarType,
>(this: Node<T>, lo: Node<T> | number, hi: Node<T> | number): Node<T> {
  return clamp(this, lo, hi);
});

// ─────────────────────────────────────────────────────────────────────────
// Control
// ─────────────────────────────────────────────────────────────────────────

export function select<T extends ScalarType>(
  cond: Node<"bool"> | boolean,
  then: Node<T> | number | boolean,
  else_: Node<T> | number | boolean,
): Node<T> {
  // WASM `select` returns the branch type unchanged; carry it on the AST so
  // downstream inference / emission pick the right type. Literal branches lift
  // to the type of whichever branch is a `Node<T>` (Q33 context-dependent
  // lift); both-literal falls back to `'f32'` (numeric) or `'bool'`.
  const branchType = operandType(then, else_);
  return wrapAst<T>({
    kind: "select",
    type: branchType,
    cond:
      typeof cond === "boolean"
        ? // bool は 内 部 i32 表 現 (= 0/1) = WASM select cond も i32。
          { kind: "literal", type: "i32", value: cond ? 1 : 0 }
        : unwrapAst(cond),
    ifTrue: lift(then, branchType),
    ifFalse: lift(else_, branchType),
  });
}
