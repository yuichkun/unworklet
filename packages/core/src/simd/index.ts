import type { Node } from "../types.js";
import { getCaptureBackend } from "../capture-backend.js";
import { wrap as wrapScalar } from "../node-value.js";

// SIMD primitives operate on Float32Array of length 4 representing v128.

type Vec4 = Float32Array;

const wrap = (v: Vec4): Node<"f32x4"> => {
  // Attach `lane` plus SIMD chain methods (`add` / `sub` / `mul` / `div`)
  // on each call result. Direct assignment (vs Object.defineProperty) is
  // ~10× faster and matters in tight convolution / FIR loops where every
  // addVec/mulVec returns a freshly-attached vec.
  const o = v as any;
  if (!o.lane) {
    o.lane = (i: 0 | 1 | 2 | 3) => wrapScalar(v[i]! as number);
    o.add = (b: any) => addVec(v as unknown as Node<"f32x4">, b);
    o.sub = (b: any) => subVec(v as unknown as Node<"f32x4">, b);
    o.mul = (b: any) => mulVec(v as unknown as Node<"f32x4">, b);
    o.div = (b: any) => divVec(v as unknown as Node<"f32x4">, b);
  }
  return v as unknown as Node<"f32x4">;
};

export function vec4(
  a: Node<"f32"> | number,
  b: Node<"f32"> | number,
  c: Node<"f32"> | number,
  d: Node<"f32"> | number,
): Node<"f32x4"> {
  const cap = getCaptureBackend();
  if (cap) return cap.vec4(a, b, c, d);
  const v = new Float32Array(4);
  v[0] = a as number;
  v[1] = b as number;
  v[2] = c as number;
  v[3] = d as number;
  return wrap(v);
}

export function splat(x: Node<"f32"> | number): Node<"f32x4"> {
  const cap = getCaptureBackend();
  if (cap) return cap.splat(x);
  const v = new Float32Array(4);
  v.fill(x as number);
  return wrap(v);
}

const elementWise =
  (op: (a: number, b: number) => number) =>
  (a: Node<"f32x4">, b: Node<"f32x4">): Node<"f32x4"> => {
    const av = a as unknown as Float32Array;
    const bv = b as unknown as Float32Array;
    const out = new Float32Array(4);
    out[0] = op(av[0]!, bv[0]!);
    out[1] = op(av[1]!, bv[1]!);
    out[2] = op(av[2]!, bv[2]!);
    out[3] = op(av[3]!, bv[3]!);
    return wrap(out);
  };

export const addVec = (a: Node<"f32x4">, b: Node<"f32x4">): Node<"f32x4"> => {
  const cap = getCaptureBackend();
  if (cap) return cap.addVec(a, b);
  return elementWise((x, y) => x + y)(a, b);
};
export const subVec = (a: Node<"f32x4">, b: Node<"f32x4">): Node<"f32x4"> => {
  const cap = getCaptureBackend();
  if (cap) return cap.subVec(a, b);
  return elementWise((x, y) => x - y)(a, b);
};
export const mulVec = (a: Node<"f32x4">, b: Node<"f32x4">): Node<"f32x4"> => {
  const cap = getCaptureBackend();
  if (cap) return cap.mulVec(a, b);
  return elementWise((x, y) => x * y)(a, b);
};
export const divVec = (a: Node<"f32x4">, b: Node<"f32x4">): Node<"f32x4"> => {
  const cap = getCaptureBackend();
  if (cap) return cap.divVec(a, b);
  return elementWise((x, y) => x / y)(a, b);
};

/**
 * Attach SIMD chain methods (`.lane`, `.add`, `.sub`, `.mul`, `.div`) to
 * an interp-mode f32x4 (Float32Array). Used by `wrap()` here and by
 * buffer.loadVec in declarations.ts.
 */
export function attachVecMethods(v: Float32Array): Node<"f32x4"> {
  return wrap(v);
}
