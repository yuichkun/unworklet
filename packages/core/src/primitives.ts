import type { Node, ScalarType } from "./types.js";

// Numeric primitives operate as plain JS math in the pure-JS interpreter.
// All Node<T> values are encoded as actual JS numbers/booleans.

type N = number;

const n = <T extends ScalarType>(v: number | boolean): Node<T> => v as unknown as Node<T>;
const b = <T extends ScalarType>(v: boolean): Node<T> => v as unknown as Node<T>;

// Arithmetic
export const add = (a: Node<any> | N, c: Node<any> | N): Node<any> => n((a as N) + (c as N));
export const sub = (a: Node<any> | N, c: Node<any> | N): Node<any> => n((a as N) - (c as N));
export const mul = (a: Node<any> | N, c: Node<any> | N): Node<any> => n((a as N) * (c as N));
export const div = (a: Node<any> | N, c: Node<any> | N): Node<any> => n((a as N) / (c as N));
export const mod = (a: Node<any> | N, c: Node<any> | N): Node<any> => {
  const aa = a as N;
  const cc = c as N;
  // proper modulo (handles negative)
  const r = aa - Math.floor(aa / cc) * cc;
  return n(r);
};
export const neg = (a: Node<any> | N): Node<any> => n(-(a as N));

// Comparison -> Node<'bool'>
export const eq = (a: Node<any> | N | boolean, c: Node<any> | N | boolean): Node<"bool"> =>
  b((a as any) === (c as any));
export const ne = (a: Node<any> | N | boolean, c: Node<any> | N | boolean): Node<"bool"> =>
  b((a as any) !== (c as any));
export const lt = (a: Node<any> | N, c: Node<any> | N): Node<"bool"> => b((a as N) < (c as N));
export const gt = (a: Node<any> | N, c: Node<any> | N): Node<"bool"> => b((a as N) > (c as N));
export const lte = (a: Node<any> | N, c: Node<any> | N): Node<"bool"> => b((a as N) <= (c as N));
export const gte = (a: Node<any> | N, c: Node<any> | N): Node<"bool"> => b((a as N) >= (c as N));

// Math
export const sin = (a: Node<any> | N): Node<any> => n(Math.sin(a as N));
export const cos = (a: Node<any> | N): Node<any> => n(Math.cos(a as N));
export const tan = (a: Node<any> | N): Node<any> => n(Math.tan(a as N));
export const tanh = (a: Node<any> | N): Node<any> => n(Math.tanh(a as N));
export const exp = (a: Node<any> | N): Node<any> => n(Math.exp(a as N));
export const log = (a: Node<any> | N): Node<any> => n(Math.log(a as N));
export const sqrt = (a: Node<any> | N): Node<any> => n(Math.sqrt(a as N));
export const abs = (a: Node<any> | N): Node<any> => n(Math.abs(a as N));
export const floor = (a: Node<any> | N): Node<any> => n(Math.floor(a as N));
export const ceil = (a: Node<any> | N): Node<any> => n(Math.ceil(a as N));
export const frac = (a: Node<any> | N): Node<any> => n((a as N) - Math.floor(a as N));
export const min = (a: Node<any> | N, c: Node<any> | N): Node<any> => n(Math.min(a as N, c as N));
export const max = (a: Node<any> | N, c: Node<any> | N): Node<any> => n(Math.max(a as N, c as N));
export const clamp = (v: Node<any> | N, lo: Node<any> | N, hi: Node<any> | N): Node<any> =>
  n(Math.min(Math.max(v as N, lo as N), hi as N));

// Control
export const select = <T extends ScalarType | "f32x4">(
  cond: Node<"bool"> | boolean,
  whenTrue: Node<T> | number | boolean,
  whenFalse: Node<T> | number | boolean,
): Node<T> => (cond ? whenTrue : whenFalse) as Node<T>;

// Type conversions
export const f32 = (a: Node<any> | N): Node<"f32"> => Math.fround(a as N) as unknown as Node<"f32">;
export const f64 = (a: Node<any> | N): Node<"f64"> => a as N as unknown as Node<"f64">;
export const i32 = (a: Node<any> | N): Node<"i32"> => ((a as N) | 0) as unknown as Node<"i32">;
export const i64 = (a: Node<any> | N): Node<"i64"> => Math.trunc(a as N) as unknown as Node<"i64">;

// Splat (used when we need a constant Node<T>) - identity in this interpreter
export const splat32 = (a: number): Node<"f32"> => a as unknown as Node<"f32">;
