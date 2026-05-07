// Primitives — single source of truth that dispatches to either the legacy
// direct-eval interpreter (when no capture backend is installed) or the AST
// capture path (during compileToWasm).
//
// Every primitive return value is wrapped in interp mode (NodeImpl) so the
// chain-method surface is uniformly available — `sin(w0).div(q)` and
// `w0.sin().div(q)` both work, and capture / interp behave identically.
// Wrapping costs an allocation per op; convolution / FIR examples that
// chew through 1M ops/block render slower in interp than the WASM path
// they're shipped on (real-time WASM is unaffected).

import { getCaptureBackend } from "./capture-backend.js";
import { wrap, unwrap } from "./node-value.js";
import type { Node, ScalarType } from "./types.js";

type N = number;

const c = () => getCaptureBackend();

// Arithmetic
export const add = (a: any, b: any): Node<any> => {
  const cap = c();
  if (cap) return cap.add(a, b);
  return wrap((a as N) + (b as N));
};
export const sub = (a: any, b: any): Node<any> => {
  const cap = c();
  if (cap) return cap.sub(a, b);
  return wrap((a as N) - (b as N));
};
export const mul = (a: any, b: any): Node<any> => {
  const cap = c();
  if (cap) return cap.mul(a, b);
  return wrap((a as N) * (b as N));
};
export const div = (a: any, b: any): Node<any> => {
  const cap = c();
  if (cap) return cap.div(a, b);
  return wrap((a as N) / (b as N));
};
export const mod = (a: any, b: any): Node<any> => {
  const cap = c();
  if (cap) return cap.mod(a, b);
  const aa = a as N;
  const bb = b as N;
  return wrap(aa - Math.floor(aa / bb) * bb);
};
export const neg = (a: any): Node<any> => {
  const cap = c();
  if (cap) return cap.neg(a);
  return wrap(-(a as N));
};
export const min = (a: any, b: any): Node<any> => {
  const cap = c();
  if (cap) return cap.min(a, b);
  return wrap(Math.min(a as N, b as N));
};
export const max = (a: any, b: any): Node<any> => {
  const cap = c();
  if (cap) return cap.max(a, b);
  return wrap(Math.max(a as N, b as N));
};
export const abs = (a: any): Node<any> => {
  const cap = c();
  if (cap) return cap.abs(a);
  return wrap(Math.abs(a as N));
};
export const clamp = (v: any, lo: any, hi: any): Node<any> => {
  const cap = c();
  if (cap) return cap.clamp(v, lo, hi);
  return wrap(Math.min(Math.max(v as N, lo as N), hi as N));
};

// Comparison
export const eq = (a: any, b: any): Node<"bool"> => {
  const cap = c();
  if (cap) return cap.eq(a, b);
  return wrap(unwrap(a) === unwrap(b));
};
export const ne = (a: any, b: any): Node<"bool"> => {
  const cap = c();
  if (cap) return cap.ne(a, b);
  return wrap(unwrap(a) !== unwrap(b));
};
export const lt = (a: any, b: any): Node<"bool"> => {
  const cap = c();
  if (cap) return cap.lt(a, b);
  return wrap((a as N) < (b as N));
};
export const gt = (a: any, b: any): Node<"bool"> => {
  const cap = c();
  if (cap) return cap.gt(a, b);
  return wrap((a as N) > (b as N));
};
export const lte = (a: any, b: any): Node<"bool"> => {
  const cap = c();
  if (cap) return cap.lte(a, b);
  return wrap((a as N) <= (b as N));
};
export const gte = (a: any, b: any): Node<"bool"> => {
  const cap = c();
  if (cap) return cap.gte(a, b);
  return wrap((a as N) >= (b as N));
};

// Math
const mathOp = (name: keyof Math, fallback: (x: N) => N) =>
  (a: any): Node<any> => {
    const cap = c();
    if (cap) return (cap as any)[name as string](a);
    return wrap(fallback(a as N));
  };

export const sin = mathOp("sin", Math.sin);
export const cos = mathOp("cos", Math.cos);
export const tan = mathOp("tan", Math.tan);
export const tanh = mathOp("tanh", Math.tanh);
export const exp = mathOp("exp", Math.exp);
export const log = mathOp("log", Math.log);
export const sqrt = mathOp("sqrt", Math.sqrt);
export const floor = mathOp("floor", Math.floor);
export const ceil = mathOp("ceil", Math.ceil);

// Precision-tagged variants for @unworklet/dsp/precise and /table import
// paths (per spec Q17). The capture backend exposes corresponding
// primitives that set the MathOp.precision tag; the WASM emitter then
// chooses a different lowering (table-driven approximation vs. JS Math
// import). In interpret mode they all dispatch to JS Math (which is
// f64-precise), so only WASM compilation observes the difference.
const mathOpPrecise = <N extends number>(name: string, fallback: (a: N) => N) =>
  (a: any): Node<any> => {
    const cap = c() as any;
    if (cap) return cap[name + "Precise"]?.(a) ?? cap[name](a);
    return wrap(fallback(a as N));
  };
const mathOpTable = <N extends number>(name: string, fallback: (a: N) => N) =>
  (a: any): Node<any> => {
    const cap = c() as any;
    if (cap) return cap[name + "Table"]?.(a) ?? cap[name](a);
    return wrap(fallback(a as N));
  };

export const sinPrecise = mathOpPrecise("sin", Math.sin);
export const cosPrecise = mathOpPrecise("cos", Math.cos);
export const tanPrecise = mathOpPrecise("tan", Math.tan);
export const tanhPrecise = mathOpPrecise("tanh", Math.tanh);
export const expPrecise = mathOpPrecise("exp", Math.exp);
export const logPrecise = mathOpPrecise("log", Math.log);

export const sinTable = mathOpTable("sin", Math.sin);
export const cosTable = mathOpTable("cos", Math.cos);
export const expTable = mathOpTable("exp", Math.exp);
export const logTable = mathOpTable("log", Math.log);
export const frac = (a: any): Node<any> => {
  const cap = c();
  if (cap) return cap.frac(a);
  return wrap((a as N) - Math.floor(a as N));
};

// flushDenormals — zero out values smaller in magnitude than 1e-30.
// Equivalent to FTZ behaviour on x86; emit-side compiles to
// `select(abs(x) < FTZ_THRESHOLD, 0, x)`. Use on feedback paths whose
// coefficients are close to 1.0 (one-pole filters, reverbs) to avoid
// subnormal stalls. See docs/04-worklet-runtime §6.
const FTZ_THRESHOLD = 1e-30;
export const flushDenormals = (a: any): Node<"f32"> => {
  const cap = c();
  if (cap) {
    return cap.select(
      cap.lt(cap.abs(a), FTZ_THRESHOLD),
      0,
      a,
    ) as Node<"f32">;
  }
  const v = unwrap(a) as number;
  return wrap(Math.abs(v) < FTZ_THRESHOLD ? 0 : v);
};

// select
export const select = <T extends ScalarType | "f32x4">(
  cond: any,
  whenTrue: any,
  whenFalse: any,
): Node<T> => {
  const cap = c();
  if (cap) return cap.select(cond, whenTrue, whenFalse);
  // Wrap the chosen branch so chains continue to work even when one of
  // the branches was a plain JS literal (e.g. `select(cond, ratio, 1)`).
  return wrap(unwrap(unwrap(cond) ? whenTrue : whenFalse)) as Node<T>;
};

// Type conversions
export const f32 = (a: any): Node<"f32"> => {
  const cap = c();
  if (cap) return cap.f32(a);
  return wrap(Math.fround(a as N));
};
export const f64 = (a: any): Node<"f64"> => {
  const cap = c();
  if (cap) return cap.f64(a);
  return wrap(a as N);
};
export const i32 = (a: any): Node<"i32"> => {
  const cap = c();
  if (cap) return cap.i32(a);
  return wrap((a as N) | 0);
};
export const i64 = (a: any): Node<"i64"> => {
  const cap = c();
  if (cap) return cap.i64(a);
  return wrap(Math.trunc(a as N));
};

// num — chain-entry helper for literal-leading expressions.
//
//   num(1).sub(m).mul(dry)   //   (1 - m) * dry  in DSP-flow order
//   num(0.5).add(cos(theta).mul(0.5))   // half-cosine window
//
// Always produces an f32 graph node (or bool for boolean literals).
// For type-explicit literal wrapping, use the existing
// f32 / f64 / i32 / i64 helpers directly.
export function num(v: number): Node<"f32">;
export function num(v: boolean): Node<"bool">;
export function num(v: number | boolean): Node<any> {
  const cap = c();
  if (cap) return cap.num(v);
  return wrap(v);
}
