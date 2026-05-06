// Primitives — single source of truth that dispatches to either the legacy
// direct-eval interpreter (when no capture backend is installed) or the AST
// capture path (during compileToWasm).

import { getCaptureBackend } from "./capture-backend.js";
import type { Node, ScalarType } from "./types.js";

type N = number;

const c = () => getCaptureBackend();

// Arithmetic
export const add = (a: any, b: any): Node<any> => {
  const cap = c();
  if (cap) return cap.add(a, b);
  return (((a as N) + (b as N)) as unknown) as Node<any>;
};
export const sub = (a: any, b: any): Node<any> => {
  const cap = c();
  if (cap) return cap.sub(a, b);
  return (((a as N) - (b as N)) as unknown) as Node<any>;
};
export const mul = (a: any, b: any): Node<any> => {
  const cap = c();
  if (cap) return cap.mul(a, b);
  return (((a as N) * (b as N)) as unknown) as Node<any>;
};
export const div = (a: any, b: any): Node<any> => {
  const cap = c();
  if (cap) return cap.div(a, b);
  return (((a as N) / (b as N)) as unknown) as Node<any>;
};
export const mod = (a: any, b: any): Node<any> => {
  const cap = c();
  if (cap) return cap.mod(a, b);
  const aa = a as N;
  const bb = b as N;
  return ((aa - Math.floor(aa / bb) * bb) as unknown) as Node<any>;
};
export const neg = (a: any): Node<any> => {
  const cap = c();
  if (cap) return cap.neg(a);
  return ((-(a as N)) as unknown) as Node<any>;
};
export const min = (a: any, b: any): Node<any> => {
  const cap = c();
  if (cap) return cap.min(a, b);
  return (Math.min(a as N, b as N) as unknown) as Node<any>;
};
export const max = (a: any, b: any): Node<any> => {
  const cap = c();
  if (cap) return cap.max(a, b);
  return (Math.max(a as N, b as N) as unknown) as Node<any>;
};
export const abs = (a: any): Node<any> => {
  const cap = c();
  if (cap) return cap.abs(a);
  return (Math.abs(a as N) as unknown) as Node<any>;
};
export const clamp = (v: any, lo: any, hi: any): Node<any> => {
  const cap = c();
  if (cap) return cap.clamp(v, lo, hi);
  return (Math.min(Math.max(v as N, lo as N), hi as N) as unknown) as Node<any>;
};

// Comparison
export const eq = (a: any, b: any): Node<"bool"> => {
  const cap = c();
  if (cap) return cap.eq(a, b);
  return ((a === b) as unknown) as Node<"bool">;
};
export const ne = (a: any, b: any): Node<"bool"> => {
  const cap = c();
  if (cap) return cap.ne(a, b);
  return ((a !== b) as unknown) as Node<"bool">;
};
export const lt = (a: any, b: any): Node<"bool"> => {
  const cap = c();
  if (cap) return cap.lt(a, b);
  return (((a as N) < (b as N)) as unknown) as Node<"bool">;
};
export const gt = (a: any, b: any): Node<"bool"> => {
  const cap = c();
  if (cap) return cap.gt(a, b);
  return (((a as N) > (b as N)) as unknown) as Node<"bool">;
};
export const lte = (a: any, b: any): Node<"bool"> => {
  const cap = c();
  if (cap) return cap.lte(a, b);
  return (((a as N) <= (b as N)) as unknown) as Node<"bool">;
};
export const gte = (a: any, b: any): Node<"bool"> => {
  const cap = c();
  if (cap) return cap.gte(a, b);
  return (((a as N) >= (b as N)) as unknown) as Node<"bool">;
};

// Math
const mathOp = (name: keyof Math, fallback: (x: N) => N) =>
  (a: any): Node<any> => {
    const cap = c();
    if (cap) return (cap as any)[name as string](a);
    return (fallback(a as N) as unknown) as Node<any>;
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
    return (fallback(a as N) as unknown) as Node<any>;
  };
const mathOpTable = <N extends number>(name: string, fallback: (a: N) => N) =>
  (a: any): Node<any> => {
    const cap = c() as any;
    if (cap) return cap[name + "Table"]?.(a) ?? cap[name](a);
    return (fallback(a as N) as unknown) as Node<any>;
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
  return (((a as N) - Math.floor(a as N)) as unknown) as Node<any>;
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
  const v = a as number;
  return ((Math.abs(v) < FTZ_THRESHOLD ? 0 : v) as unknown) as Node<"f32">;
};

// select
export const select = <T extends ScalarType | "f32x4">(
  cond: any,
  whenTrue: any,
  whenFalse: any,
): Node<T> => {
  const cap = c();
  if (cap) return cap.select(cond, whenTrue, whenFalse);
  return (cond ? whenTrue : whenFalse) as Node<T>;
};

// Type conversions
export const f32 = (a: any): Node<"f32"> => {
  const cap = c();
  if (cap) return cap.f32(a);
  return (Math.fround(a as N) as unknown) as Node<"f32">;
};
export const f64 = (a: any): Node<"f64"> => {
  const cap = c();
  if (cap) return cap.f64(a);
  return ((a as N) as unknown) as Node<"f64">;
};
export const i32 = (a: any): Node<"i32"> => {
  const cap = c();
  if (cap) return cap.i32(a);
  return (((a as N) | 0) as unknown) as Node<"i32">;
};
export const i64 = (a: any): Node<"i64"> => {
  const cap = c();
  if (cap) return cap.i64(a);
  return (Math.trunc(a as N) as unknown) as Node<"i64">;
};
