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

/**
 * Scalar types every numeric primitive (free-function form) accepts. The method
 * form (`a.add(b)` …) is declared on the `Node` interface in `../types.ts`,
 * co-located with `Node` so the method surface survives dts bundling into the
 * published package; this file owns the runtime impl (free functions +
 * `registerNodeMethod`).
 */
type NumericScalar = "f32" | "f64" | "i32" | "i64";

// ─────────────────────────────────────────────────────────────────────────
// Type inference + literal lift (= Q33 context-dependent lift)
// ─────────────────────────────────────────────────────────────────────────

type Operand = Node<ScalarType> | number | boolean;

// Resolve the shared scalar type of a homogeneous op's operands. A mix of two
// CONCRETELY-typed nodes (e.g. i32 and f32) is REJECTED here with a readable error:
// it used to lower an op of one type fed an operand of the other → invalid WASM that
// surfaced only as a raw validator message ("i32.lt_s expected type i32, found f32")
// the author could not act on. Number literals stay flexible (they lift to a typed
// sibling), so only typed-node-vs-typed-node mismatches throw. ("type ⟺ works".)
function sameType(op: string, ...operands: Operand[]): ScalarType {
  let resolved: ScalarType | null = null;
  for (const operand of operands) {
    if (!isWrappedNode(operand)) continue;
    const ast = unwrapAst(operand);
    const t = inferAstType(ast);
    if (resolved === null) resolved = t;
    else if (resolved !== t) {
      throw new Error(
        `unworklet: ${op}() got operands of different scalar types (${resolved} and ${t}). ` +
          `A numeric op needs one type — cast explicitly, e.g. f32(x) or i32(x).`,
      );
    }
  }
  if (resolved !== null) return resolved;
  for (const operand of operands) if (typeof operand === "boolean") return "bool";
  return "f32";
}

// Single-/uniform-operand resolution; delegates to `sameType` (unary ops pass one
// operand and can't mismatch, so they use the generic label).
function operandType(...operands: Operand[]): ScalarType {
  return sameType("operation", ...operands);
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
    // bool is represented internally as i32 (0/1).
    return { kind: "literal", type: "bool", value: value ? 1 : 0 };
  }
  if (typeof value === "number") {
    return numberLiteral(value, t);
  }
  return unwrapAst(value);
}

// ─────────────────────────────────────────────────────────────────────────
// Arithmetic (polymorphic over 'f32' | 'f64' | 'i32' | 'i64' + SIMD 'f32x4')
// ─────────────────────────────────────────────────────────────────────────

// SIMD f32x4 (§7): the method form of add/sub/mul/div is also declared for f32x4
// (the Node augment in primitives.ts includes "f32x4" in T). When an operand is a
// vec-producing node, a vec node is generated instead of taking the scalar path
// (preventing the "type-checks but doesn't run" case). A number is broadcast to
// all 4 lanes via splat.
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

// Arithmetic (add/sub/mul/div) covers numeric scalars + SIMD f32x4. mod/neg cover
// numeric scalars only. bool is excluded (bool arithmetic would lower to f32
// instructions and produce invalid WASM). In the registration, `this` is typed as
// f32 at the type level (operandType / vecBinaryOrNull read the actual type, so vec
// / f64 work too).
export function add(a: Node<"f32"> | number, b: Node<"f32"> | number): Node<"f32">;
export function add(a: Node<"i32"> | number, b: Node<"i32"> | number): Node<"i32">;
export function add(a: Node<"f64"> | number, b: Node<"f64"> | number): Node<"f64">;
export function add(a: Node<"i64"> | number, b: Node<"i64"> | number): Node<"i64">;
export function add<T extends NumericScalar = "f32">(
  a: Node<T> | number,
  b: Node<T> | number,
): Node<T> {
  const vec = vecBinaryOrNull("vecAdd", a, b);
  if (vec !== null) return wrapAst(vec) as Node<T>;
  const t = sameType("add", a, b);
  return wrapAst<T>({ kind: "add", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("add", function (this: Node<"f32">, other: Node<"f32"> | number): Node<"f32"> {
  return add(this, other);
});

export function sub(a: Node<"f32"> | number, b: Node<"f32"> | number): Node<"f32">;
export function sub(a: Node<"i32"> | number, b: Node<"i32"> | number): Node<"i32">;
export function sub(a: Node<"f64"> | number, b: Node<"f64"> | number): Node<"f64">;
export function sub(a: Node<"i64"> | number, b: Node<"i64"> | number): Node<"i64">;
export function sub<T extends NumericScalar = "f32">(
  a: Node<T> | number,
  b: Node<T> | number,
): Node<T> {
  const vec = vecBinaryOrNull("vecSub", a, b);
  if (vec !== null) return wrapAst(vec) as Node<T>;
  const t = sameType("sub", a, b);
  return wrapAst<T>({ kind: "sub", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("sub", function (this: Node<"f32">, other: Node<"f32"> | number): Node<"f32"> {
  return sub(this, other);
});

export function mul(a: Node<"f32"> | number, b: Node<"f32"> | number): Node<"f32">;
export function mul(a: Node<"i32"> | number, b: Node<"i32"> | number): Node<"i32">;
export function mul(a: Node<"f64"> | number, b: Node<"f64"> | number): Node<"f64">;
export function mul(a: Node<"i64"> | number, b: Node<"i64"> | number): Node<"i64">;
export function mul<T extends NumericScalar = "f32">(
  a: Node<T> | number,
  b: Node<T> | number,
): Node<T> {
  const vec = vecBinaryOrNull("vecMul", a, b);
  if (vec !== null) return wrapAst(vec) as Node<T>;
  const t = sameType("mul", a, b);
  return wrapAst<T>({ kind: "mul", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("mul", function (this: Node<"f32">, other: Node<"f32"> | number): Node<"f32"> {
  return mul(this, other);
});

export function div(a: Node<"f32"> | number, b: Node<"f32"> | number): Node<"f32">;
export function div(a: Node<"i32"> | number, b: Node<"i32"> | number): Node<"i32">;
export function div(a: Node<"f64"> | number, b: Node<"f64"> | number): Node<"f64">;
export function div(a: Node<"i64"> | number, b: Node<"i64"> | number): Node<"i64">;
export function div<T extends NumericScalar = "f32">(
  a: Node<T> | number,
  b: Node<T> | number,
): Node<T> {
  const vec = vecBinaryOrNull("vecDiv", a, b);
  if (vec !== null) return wrapAst(vec) as Node<T>;
  const t = sameType("div", a, b);
  return wrapAst<T>({ kind: "div", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("div", function (this: Node<"f32">, other: Node<"f32"> | number): Node<"f32"> {
  return div(this, other);
});

export function mod(a: Node<"f32"> | number, b: Node<"f32"> | number): Node<"f32">;
export function mod(a: Node<"i32"> | number, b: Node<"i32"> | number): Node<"i32">;
export function mod(a: Node<"f64"> | number, b: Node<"f64"> | number): Node<"f64">;
export function mod(a: Node<"i64"> | number, b: Node<"i64"> | number): Node<"i64">;
export function mod<T extends NumericScalar = "f32">(
  a: Node<T> | number,
  b: Node<T> | number,
): Node<T> {
  const t = sameType("mod", a, b);
  return wrapAst<T>({ kind: "mod", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("mod", function (this: Node<"f32">, other: Node<"f32"> | number): Node<"f32"> {
  return mod(this, other);
});

export function neg<T extends NumericScalar = "f32">(x: Node<T> | number): Node<T> {
  const t = operandType(x);
  return wrapAst<T>({ kind: "neg", type: t, value: lift(x, t) });
}
registerNodeMethod("neg", function (this: Node<"f32">): Node<"f32"> {
  return neg(this);
});

// ─────────────────────────────────────────────────────────────────────────
// Comparison (polymorphic operands, returns Node<'bool'>; node.type carries
// the operand type so emission selects the signed/float compare instruction)
// ─────────────────────────────────────────────────────────────────────────

// Comparisons take numeric operands → Node<'bool'>. bool / f32x4 operands are
// excluded. In the registration, `this` is typed as f32 at the type level
// (operandType reads the actual type).
export function eq(a: Node<"f32"> | number, b: Node<"f32"> | number): Node<"bool">;
export function eq(a: Node<"i32"> | number, b: Node<"i32"> | number): Node<"bool">;
export function eq(a: Node<"f64"> | number, b: Node<"f64"> | number): Node<"bool">;
export function eq(a: Node<"i64"> | number, b: Node<"i64"> | number): Node<"bool">;
export function eq<T extends NumericScalar = "f32">(
  a: Node<T> | number,
  b: Node<T> | number,
): Node<"bool"> {
  const t = sameType("eq", a, b);
  return wrapAst<"bool">({ kind: "eq", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("eq", function (this: Node<"f32">, other: Node<"f32"> | number): Node<"bool"> {
  return eq(this, other);
});

export function lt(a: Node<"f32"> | number, b: Node<"f32"> | number): Node<"bool">;
export function lt(a: Node<"i32"> | number, b: Node<"i32"> | number): Node<"bool">;
export function lt(a: Node<"f64"> | number, b: Node<"f64"> | number): Node<"bool">;
export function lt(a: Node<"i64"> | number, b: Node<"i64"> | number): Node<"bool">;
export function lt<T extends NumericScalar = "f32">(
  a: Node<T> | number,
  b: Node<T> | number,
): Node<"bool"> {
  const t = sameType("lt", a, b);
  return wrapAst<"bool">({ kind: "lt", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("lt", function (this: Node<"f32">, other: Node<"f32"> | number): Node<"bool"> {
  return lt(this, other);
});

export function gt(a: Node<"f32"> | number, b: Node<"f32"> | number): Node<"bool">;
export function gt(a: Node<"i32"> | number, b: Node<"i32"> | number): Node<"bool">;
export function gt(a: Node<"f64"> | number, b: Node<"f64"> | number): Node<"bool">;
export function gt(a: Node<"i64"> | number, b: Node<"i64"> | number): Node<"bool">;
export function gt<T extends NumericScalar = "f32">(
  a: Node<T> | number,
  b: Node<T> | number,
): Node<"bool"> {
  const t = sameType("gt", a, b);
  return wrapAst<"bool">({ kind: "gt", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("gt", function (this: Node<"f32">, other: Node<"f32"> | number): Node<"bool"> {
  return gt(this, other);
});

export function lte(a: Node<"f32"> | number, b: Node<"f32"> | number): Node<"bool">;
export function lte(a: Node<"i32"> | number, b: Node<"i32"> | number): Node<"bool">;
export function lte(a: Node<"f64"> | number, b: Node<"f64"> | number): Node<"bool">;
export function lte(a: Node<"i64"> | number, b: Node<"i64"> | number): Node<"bool">;
export function lte<T extends NumericScalar = "f32">(
  a: Node<T> | number,
  b: Node<T> | number,
): Node<"bool"> {
  const t = sameType("lte", a, b);
  return wrapAst<"bool">({ kind: "lte", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("lte", function (this: Node<"f32">, other: Node<"f32"> | number): Node<"bool"> {
  return lte(this, other);
});

export function gte(a: Node<"f32"> | number, b: Node<"f32"> | number): Node<"bool">;
export function gte(a: Node<"i32"> | number, b: Node<"i32"> | number): Node<"bool">;
export function gte(a: Node<"f64"> | number, b: Node<"f64"> | number): Node<"bool">;
export function gte(a: Node<"i64"> | number, b: Node<"i64"> | number): Node<"bool">;
export function gte<T extends NumericScalar = "f32">(
  a: Node<T> | number,
  b: Node<T> | number,
): Node<"bool"> {
  const t = sameType("gte", a, b);
  return wrapAst<"bool">({ kind: "gte", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("gte", function (this: Node<"f32">, other: Node<"f32"> | number): Node<"bool"> {
  return gte(this, other);
});

// ─────────────────────────────────────────────────────────────────────────
// Logical (bool only; bool is internally i32 0/1)
// ─────────────────────────────────────────────────────────────────────────

// `not(b)` lowers to a single `i32.eqz`. bool-only — `not(f32Node)` is a type error.
export function not(b: Node<"bool"> | boolean): Node<"bool"> {
  return wrapAst<"bool">({ kind: "not", type: "bool", value: lift(b, "bool") });
}
registerNodeMethod("not", function (this: Node<"bool">): Node<"bool"> {
  return not(this);
});

// ─────────────────────────────────────────────────────────────────────────
// Math (f32 / f64 — `f64` lowering lands with the f64 path; `f32` here)
// ─────────────────────────────────────────────────────────────────────────

// sqrt / floor / ceil / frac + transcendentals are float-only (f32/f64). An integer
// operand is a type error (sqrt/floor/sin of an integer is non-sensical;
// `f32(intNode).sin()` is the explicit path). In the runtime registration, `this` is
// typed as f32 at the type level (operandType reads the actual type, so f64 works too).
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
// abs is valid for every numeric scalar (f32/f64/i32/i64). Integers emit as select(x<0,-x,x).
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
// min/max/clamp cover numeric scalars only (bool / f32x4 excluded; integers emit as
// compare+select). In the registration, `this` is typed as f32 at the type level
// (operandType reads the actual type).
export function min(a: Node<"f32"> | number, b: Node<"f32"> | number): Node<"f32">;
export function min(a: Node<"i32"> | number, b: Node<"i32"> | number): Node<"i32">;
export function min(a: Node<"f64"> | number, b: Node<"f64"> | number): Node<"f64">;
export function min(a: Node<"i64"> | number, b: Node<"i64"> | number): Node<"i64">;
export function min<T extends NumericScalar = "f32">(
  a: Node<T> | number,
  b: Node<T> | number,
): Node<T> {
  const t = sameType("min", a, b);
  return wrapAst<T>({ kind: "min", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("min", function (this: Node<"f32">, other: Node<"f32"> | number): Node<"f32"> {
  return min(this, other);
});
export function max(a: Node<"f32"> | number, b: Node<"f32"> | number): Node<"f32">;
export function max(a: Node<"i32"> | number, b: Node<"i32"> | number): Node<"i32">;
export function max(a: Node<"f64"> | number, b: Node<"f64"> | number): Node<"f64">;
export function max(a: Node<"i64"> | number, b: Node<"i64"> | number): Node<"i64">;
export function max<T extends NumericScalar = "f32">(
  a: Node<T> | number,
  b: Node<T> | number,
): Node<T> {
  const t = sameType("max", a, b);
  return wrapAst<T>({ kind: "max", type: t, lhs: lift(a, t), rhs: lift(b, t) });
}
registerNodeMethod("max", function (this: Node<"f32">, other: Node<"f32"> | number): Node<"f32"> {
  return max(this, other);
});
export function clamp(
  x: Node<"f32"> | number,
  lo: Node<"f32"> | number,
  hi: Node<"f32"> | number,
): Node<"f32">;
export function clamp(
  x: Node<"i32"> | number,
  lo: Node<"i32"> | number,
  hi: Node<"i32"> | number,
): Node<"i32">;
export function clamp(
  x: Node<"f64"> | number,
  lo: Node<"f64"> | number,
  hi: Node<"f64"> | number,
): Node<"f64">;
export function clamp(
  x: Node<"i64"> | number,
  lo: Node<"i64"> | number,
  hi: Node<"i64"> | number,
): Node<"i64">;
export function clamp<T extends NumericScalar = "f32">(
  x: Node<T> | number,
  lo: Node<T> | number,
  hi: Node<T> | number,
): Node<T> {
  const t = sameType("clamp", x, lo, hi);
  return wrapAst<T>({
    kind: "clamp",
    type: t,
    x: lift(x, t),
    lo: lift(lo, t),
    hi: lift(hi, t),
  });
}
registerNodeMethod(
  "clamp",
  function (this: Node<"f32">, lo: Node<"f32"> | number, hi: Node<"f32"> | number): Node<"f32"> {
    return clamp(this, lo, hi);
  },
);

// ─────────────────────────────────────────────────────────────────────────
// Control
// ─────────────────────────────────────────────────────────────────────────

// Overloads keep a boolean branch valid only for a *bool* select (the canonical
// `select(isMe, true, gate.read())` pattern) and reject a boolean mixed with a
// numeric branch: that mix silently lifts both branches to bool and mistypes the
// result as `Node<numeric>` ("type ⟺ works" breaks). The numeric overloads are
// listed first so a number branch resolves to a numeric select; the bool overload
// only wins when a branch is literally `boolean`. The wide impl signature below
// stays a supertype of all so the body still compiles.
export function select(
  cond: Node<"bool"> | boolean,
  then: Node<"f32"> | number,
  else_: Node<"f32"> | number,
): Node<"f32">;
export function select(
  cond: Node<"bool"> | boolean,
  then: Node<"i32"> | number,
  else_: Node<"i32"> | number,
): Node<"i32">;
export function select(
  cond: Node<"bool"> | boolean,
  then: Node<"f64"> | number,
  else_: Node<"f64"> | number,
): Node<"f64">;
export function select(
  cond: Node<"bool"> | boolean,
  then: Node<"i64"> | number,
  else_: Node<"i64"> | number,
): Node<"i64">;
export function select(
  cond: Node<"bool"> | boolean,
  then: Node<"bool"> | boolean,
  else_: Node<"bool"> | boolean,
): Node<"bool">;
export function select<T extends ScalarType>(
  cond: Node<"bool"> | boolean,
  then: Node<T> | number | boolean,
  else_: Node<T> | number | boolean,
): Node<T> {
  // WASM `select` returns the branch type unchanged; carry it on the AST so
  // downstream inference / emission pick the right type. Literal branches lift
  // to the type of whichever branch is a `Node<T>` (Q33 context-dependent
  // lift); both-literal falls back to `'f32'` (numeric) or `'bool'`.
  const branchType = sameType("select", then, else_);
  return wrapAst<T>({
    kind: "select",
    type: branchType,
    cond:
      typeof cond === "boolean"
        ? // bool is represented internally as i32 (0/1), so the WASM select cond is also i32.
          { kind: "literal", type: "i32", value: cond ? 1 : 0 }
        : unwrapAst(cond),
    ifTrue: lift(then, branchType),
    ifFalse: lift(else_, branchType),
  });
}
