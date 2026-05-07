// Proxy primitives used during graph capture. Each primitive returns a fresh
// AST node instead of computing a value. Imported by the `dsl-shims` module
// which dispatches to interpreter or capture mode based on currentRuntime.

import { getCtx, lift, arithType, narrowConst } from "./capture.js";
import type { ASTValue, ScalarType, Statement } from "./ast.js";

const N = (n: any): ASTValue => n as ASTValue;

// ─── Arithmetic ─────────────────────────────────────────────────────────────

function widen(arg: ASTValue, target: ScalarType): ASTValue {
  if (arg.type === target) return arg;
  if (arg.kind === "const") {
    return { ...(arg as any), type: target };
  }
  const c = getCtx();
  return c.fresh({
    kind: "convert",
    type: target,
    from: arg.type,
    arg,
  } as any);
}

function arith(op: any, ...rawArgs: any[]): ASTValue {
  const c = getCtx();
  // Lift each arg, infer type
  const args = rawArgs.map((a) => lift(a));
  let t: ScalarType = "f32";
  if (args.length === 1) t = args[0]!.type as ScalarType;
  else if (args.length === 2) t = arithType(args[0]!, args[1]!);
  else if (args.length === 3) {
    // 3-arg ops (clamp): result follows the first operand; lo/hi widen to match.
    t = args[0]!.type as ScalarType;
  }
  const widened = args.map((a) => widen(a, t));
  return c.fresh({
    kind: "arith",
    type: t,
    op,
    args: widened,
  });
}

export const add = (a: any, b: any) => arith("add", a, b);
export const sub = (a: any, b: any) => arith("sub", a, b);
export const mul = (a: any, b: any) => arith("mul", a, b);
export const div = (a: any, b: any) => arith("div", a, b);
export const mod = (a: any, b: any) => arith("mod", a, b);
export const neg = (a: any) => arith("neg", a);
export const min = (a: any, b: any) => arith("min", a, b);
export const max = (a: any, b: any) => arith("max", a, b);
export const abs = (a: any) => arith("abs", a);
export const clamp = (v: any, lo: any, hi: any) => arith("clamp", v, lo, hi);

// ─── Comparison ─────────────────────────────────────────────────────────────

function compare(op: any, a: any, b: any): ASTValue {
  const c = getCtx();
  const av = lift(a);
  const bv = lift(b);
  const t = arithType(av, bv);
  return c.fresh({
    kind: "compare",
    type: "bool",
    op,
    a: widen(av, t),
    b: widen(bv, t),
  });
}

export const eq = (a: any, b: any) => compare("eq", a, b);
export const ne = (a: any, b: any) => compare("ne", a, b);
export const lt = (a: any, b: any) => compare("lt", a, b);
export const gt = (a: any, b: any) => compare("gt", a, b);
export const lte = (a: any, b: any) => compare("lte", a, b);
export const gte = (a: any, b: any) => compare("gte", a, b);

// ─── Math ───────────────────────────────────────────────────────────────────

function math(op: any, precision: "default" | "precise" | "table", a: any): ASTValue {
  const c = getCtx();
  let av = lift(a);
  // Math ops are always float. If the input is integer, widen to f32.
  if (av.type === "i32" || av.type === "i64" || av.type === "bool") {
    av = widen(av, "f32");
  }
  return c.fresh({
    kind: "math",
    type: av.type,
    op,
    precision,
    arg: av,
  });
}

export const sin = (a: any) => math("sin", "default", a);
export const cos = (a: any) => math("cos", "default", a);
export const tan = (a: any) => math("tan", "default", a);
export const tanh = (a: any) => math("tanh", "default", a);
export const exp = (a: any) => math("exp", "default", a);
export const log = (a: any) => math("log", "default", a);
export const sqrt = (a: any) => math("sqrt", "default", a);
export const floor = (a: any) => math("floor", "default", a);
export const ceil = (a: any) => math("ceil", "default", a);
export const frac = (a: any) => math("frac", "default", a);

// Precise variants (imported from a different path by users).
export const sinPrecise = (a: any) => math("sin", "precise", a);
export const cosPrecise = (a: any) => math("cos", "precise", a);
export const tanPrecise = (a: any) => math("tan", "precise", a);
export const tanhPrecise = (a: any) => math("tanh", "precise", a);
export const expPrecise = (a: any) => math("exp", "precise", a);
export const logPrecise = (a: any) => math("log", "precise", a);

// Table variants.
export const sinTable = (a: any) => math("sin", "table", a);
export const cosTable = (a: any) => math("cos", "table", a);
export const expTable = (a: any) => math("exp", "table", a);
export const logTable = (a: any) => math("log", "table", a);

// ─── select ─────────────────────────────────────────────────────────────────

export const select = (cond: any, whenTrue: any, whenFalse: any): ASTValue => {
  const c = getCtx();
  const cv = lift(cond, "bool");
  const tv = lift(whenTrue);
  const fv = lift(whenFalse);
  const t = arithType(tv, fv);
  return c.fresh({
    kind: "select",
    type: t,
    cond: cv,
    whenTrue: widen(tv, t),
    whenFalse: widen(fv, t),
  });
};

// ─── Type conversions ───────────────────────────────────────────────────────

function convert(target: ScalarType, a: any): ASTValue {
  const c = getCtx();
  const av = lift(a);
  if (av.type === target) return av;
  return c.fresh({
    kind: "convert",
    type: target,
    from: av.type,
    arg: av,
  });
}

export const f32 = (a: any) => convert("f32", a);
export const f64 = (a: any) => convert("f64", a);
export const i32 = (a: any) => convert("i32", a);
export const i64 = (a: any) => convert("i64", a);

// Lift a JS number/boolean to a ConstScalar AST node — backing for the
// chain-entry helper `num()`. Numbers default to f32 (per docs/00 §4);
// booleans become bool consts. Non-literal arguments fall through `lift`
// unchanged so `num(someNode)` is a no-op rather than an error.
export const num = (v: any) => lift(v);
