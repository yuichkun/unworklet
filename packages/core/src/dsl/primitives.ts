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
 * Arithmetic, comparison, and math primitives are **polymorphic** over the
 * scalar type (`'f32' | 'f64' | 'i32' | 'i64'`, plus `'bool'` for comparison):
 * the operand type is inferred from the first `Node<T>` argument (literals lift
 * to that type via the context-dependent rule, Q33), and is carried on the AST
 * node so emission picks the matching WASM instruction. All-literal calls fall
 * back to `'f32'`. Transcendentals (`sin` / `cos` / `tan` / `tanh` / `exp` /
 * `log`) share one `(f32) -> f32` polynomial; the `f64` form bridges through it
 * (demote → call → promote) so accuracy is f32-limited (~1e-4, Q17).
 */

import type { AstNode } from "../compile/ast.ts";
import { inferAstType } from "../compile/ast.ts";
import { isWrappedNode, registerNodeMethod, unwrapAst, wrapAst } from "../compile/capture.ts";
import type { Node, ScalarType } from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────
// Node<T> method form (= Q77 chain, declaration merging into `../types.ts`)
// ─────────────────────────────────────────────────────────────────────────

/**
 * A float-only math method: callable (returning `Node<T>`) only when `T` is a
 * floating-point scalar, otherwise typed `never` so the call site fails to
 * compile (= the method is not callable on `i32` / `i64` / `bool` / `f32x4`).
 */
type FloatMethod<T> = T extends "f32" | "f64" ? () => Node<T> : never;

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
    // Math — `sqrt` / `floor` / `ceil` / `frac` / transcendentals are float-only
    // (integer versions are non-sensical: sqrt of an int is non-integral, floor /
    // ceil of an int is a no-op, frac is 0). The method is typed `never` for
    // non-float `T` so e.g. `i32(1).sin()` is a compile error (`f32(i32(1)).sin()`
    // is the explicit path). `abs` is meaningful for every numeric scalar, so it
    // stays available on `i32` / `i64` (lowered to `select(x < 0, -x, x)`).
    sin: FloatMethod<T>;
    cos: FloatMethod<T>;
    tan: FloatMethod<T>;
    tanh: FloatMethod<T>;
    exp: FloatMethod<T>;
    log: FloatMethod<T>;
    sqrt: FloatMethod<T>;
    floor: FloatMethod<T>;
    ceil: FloatMethod<T>;
    frac: FloatMethod<T>;
    abs: T extends "f32" | "f64" | "i32" | "i64" ? () => Node<T> : never;
    min(other: Node<T> | number): Node<T>;
    max(other: Node<T> | number): Node<T>;
    clamp(lo: Node<T> | number, hi: Node<T> | number): Node<T>;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Type inference + literal lift (= Q33 context-dependent lift)
// ─────────────────────────────────────────────────────────────────────────

type Operand = Node<ScalarType> | number | boolean;

/** A `num(v)` chain-start literal whose type defers to a typed sibling (Q77). */
function isLooseLiteral(ast: AstNode): ast is Extract<AstNode, { kind: "literal" }> {
  return ast.kind === "literal" && ast.loose === true;
}

/**
 * The scalar type of a polymorphic primitive call: the type of the first
 * concretely-typed `Node<T>` operand (a loose `num` literal defers), else
 * `'bool'` when only boolean literals are present, else `'f32'` (the all-loose
 * / all-literal numeric default).
 */
function operandType(...operands: Operand[]): ScalarType {
  for (const op of operands) {
    if (isWrappedNode(op)) {
      const ast = unwrapAst(op);
      if (isLooseLiteral(ast)) continue;
      return inferAstType(ast);
    }
  }
  for (const op of operands) {
    if (typeof op === "boolean") return "bool";
  }
  return "f32";
}

/** Lift a JS number to an AST literal of type `t` (Q33 literal lift). */
function numberLiteral(value: number, t: ScalarType): AstNode {
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

/** Lift an operand to an AST node of type `t` (Q33 literal lift). */
function lift(value: Operand, t: ScalarType): AstNode {
  if (typeof value === "boolean") {
    // bool は 内 部 i32 表 現 (= 0/1)。
    return { kind: "literal", type: "bool", value: value ? 1 : 0 };
  }
  if (typeof value === "number") {
    return numberLiteral(value, t);
  }
  const ast = unwrapAst(value);
  // 型 未 確 定 の loose num literal は、 sibling で 解 決 し た t へ 再 lift。
  if (isLooseLiteral(ast)) {
    return numberLiteral(Number(ast.value), t);
  }
  return ast;
}

// ─────────────────────────────────────────────────────────────────────────
// Arithmetic (polymorphic over 'f32' | 'f64' | 'i32' | 'i64' + SIMD 'f32x4')
// ─────────────────────────────────────────────────────────────────────────

// SIMD f32x4 (= §7): add/sub/mul/div の method 形 は f32x4 でも型宣言されている
// (= primitives.ts の Node augment が T に "f32x4" を含む)。 オペランドが vec-producing
// node なら scalar 経路ではなく vec node を生成する (= 型通るが動かない を防止)。 number
// は splat で 4 lane に broadcast。
const VEC_KINDS = new Set(["vecConst", "vecSplat", "vecAdd", "vecSub", "vecMul", "vecDiv"]);
const isF32x4Operand = (op: Operand): boolean =>
  isWrappedNode(op) && VEC_KINDS.has(unwrapAst(op).kind);
const liftVec = (op: Operand): AstNode =>
  isWrappedNode(op)
    ? unwrapAst(op)
    : { kind: "vecSplat", value: { kind: "literal", type: "f32", value: Number(op) } };
const vecBinaryOrNull = (
  kind: "vecAdd" | "vecSub" | "vecMul" | "vecDiv",
  a: Operand,
  b: Operand,
): AstNode | null =>
  isF32x4Operand(a) || isF32x4Operand(b) ? { kind, lhs: liftVec(a), rhs: liftVec(b) } : null;

export function add<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  const vec = vecBinaryOrNull("vecAdd", a, b);
  if (vec !== null) return wrapAst(vec) as Node<T>;
  const t = operandType(a, b);
  return wrapAst<T>({ kind: "add", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("add", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<T> {
  return add(this, other);
});

export function sub<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  const vec = vecBinaryOrNull("vecSub", a, b);
  if (vec !== null) return wrapAst(vec) as Node<T>;
  const t = operandType(a, b);
  return wrapAst<T>({ kind: "sub", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("sub", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<T> {
  return sub(this, other);
});

export function mul<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  const vec = vecBinaryOrNull("vecMul", a, b);
  if (vec !== null) return wrapAst(vec) as Node<T>;
  const t = operandType(a, b);
  return wrapAst<T>({ kind: "mul", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("mul", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<T> {
  return mul(this, other);
});

export function div<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  const vec = vecBinaryOrNull("vecDiv", a, b);
  if (vec !== null) return wrapAst(vec) as Node<T>;
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

// sqrt / floor / ceil / frac + transcendentals は float (f32/f64) 限定。整数 operand は
// 型エラー (= 整数の sqrt/floor/sin はナンセンス、`f32(intNode).sin()` が明示 path)。
// runtime registration の `this` は型表現上 f32 (= operandType が実型を読むので f64 も動く)。
type FloatScalar = "f32" | "f64";
export function sin<T extends FloatScalar = "f32">(x: Node<T> | number): Node<T> {
  const t = operandType(x);
  return wrapAst<T>({ kind: "sin", type: t, value: lift(x, t) });
}
registerNodeMethod("sin", function (this: Node<"f32">): Node<"f32"> {
  return sin(this);
});
export function cos<T extends FloatScalar = "f32">(x: Node<T> | number): Node<T> {
  const t = operandType(x);
  return wrapAst<T>({ kind: "cos", type: t, value: lift(x, t) });
}
registerNodeMethod("cos", function (this: Node<"f32">): Node<"f32"> {
  return cos(this);
});
export function tan<T extends FloatScalar = "f32">(x: Node<T> | number): Node<T> {
  const t = operandType(x);
  return wrapAst<T>({ kind: "tan", type: t, value: lift(x, t) });
}
registerNodeMethod("tan", function (this: Node<"f32">): Node<"f32"> {
  return tan(this);
});
export function tanh<T extends FloatScalar = "f32">(x: Node<T> | number): Node<T> {
  const t = operandType(x);
  return wrapAst<T>({ kind: "tanh", type: t, value: lift(x, t) });
}
registerNodeMethod("tanh", function (this: Node<"f32">): Node<"f32"> {
  return tanh(this);
});
export function exp<T extends FloatScalar = "f32">(x: Node<T> | number): Node<T> {
  const t = operandType(x);
  return wrapAst<T>({ kind: "exp", type: t, value: lift(x, t) });
}
registerNodeMethod("exp", function (this: Node<"f32">): Node<"f32"> {
  return exp(this);
});
export function log<T extends FloatScalar = "f32">(x: Node<T> | number): Node<T> {
  const t = operandType(x);
  return wrapAst<T>({ kind: "log", type: t, value: lift(x, t) });
}
registerNodeMethod("log", function (this: Node<"f32">): Node<"f32"> {
  return log(this);
});
export function sqrt<T extends FloatScalar = "f32">(x: Node<T> | number): Node<T> {
  const t = operandType(x);
  return wrapAst<T>({ kind: "sqrt", type: t, value: lift(x, t) });
}
registerNodeMethod("sqrt", function (this: Node<"f32">): Node<"f32"> {
  return sqrt(this);
});
// abs は全 numeric scalar (f32/f64/i32/i64) で有効。整数は emit で select(x<0,-x,x)。
export function abs<T extends FloatScalar | "i32" | "i64" = "f32">(x: Node<T> | number): Node<T> {
  const t = operandType(x);
  return wrapAst<T>({ kind: "abs", type: t, value: lift(x, t) });
}
registerNodeMethod("abs", function (this: Node<"f32">): Node<"f32"> {
  return abs(this);
});
export function floor<T extends FloatScalar = "f32">(x: Node<T> | number): Node<T> {
  const t = operandType(x);
  return wrapAst<T>({ kind: "floor", type: t, value: lift(x, t) });
}
registerNodeMethod("floor", function (this: Node<"f32">): Node<"f32"> {
  return floor(this);
});
export function ceil<T extends FloatScalar = "f32">(x: Node<T> | number): Node<T> {
  const t = operandType(x);
  return wrapAst<T>({ kind: "ceil", type: t, value: lift(x, t) });
}
registerNodeMethod("ceil", function (this: Node<"f32">): Node<"f32"> {
  return ceil(this);
});
export function frac<T extends FloatScalar = "f32">(x: Node<T> | number): Node<T> {
  const t = operandType(x);
  return wrapAst<T>({ kind: "frac", type: t, value: lift(x, t) });
}
registerNodeMethod("frac", function (this: Node<"f32">): Node<"f32"> {
  return frac(this);
});
export function min<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  const t = operandType(a, b);
  return wrapAst<T>({ kind: "min", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("min", function method<
  T extends ScalarType,
>(this: Node<T>, other: Node<T> | number): Node<T> {
  return min(this, other);
});
export function max<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T> {
  const t = operandType(a, b);
  return wrapAst<T>({ kind: "max", type: t, lhs: lift(a, t), rhs: lift(b, t) });
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
  const t = operandType(x, lo, hi);
  return wrapAst<T>({
    kind: "clamp",
    type: t,
    x: lift(x, t),
    lo: lift(lo, t),
    hi: lift(hi, t),
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
