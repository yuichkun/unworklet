import type { Node } from "../types.js";

// SIMD primitives operate on Float32Array of length 4 representing v128.

type Vec4 = Float32Array;

const wrap = (v: Vec4): Node<"f32x4"> => {
  // Attach a `lane` method on each call result. We use a Proxy-like wrapper
  // by extending the typed array with a `.lane()` method via a helper object
  // since we can't easily prototype-extend Float32Array safely.
  //
  // Instead, we create a fresh object each time? That's heavy. Better: we
  // return the Float32Array itself and provide lane() as an external function
  // that's also attached to its instance via Object.defineProperty.
  if (!(v as any).lane) {
    Object.defineProperty(v, "lane", {
      value: function (i: 0 | 1 | 2 | 3): Node<"f32"> {
        return v[i]! as unknown as Node<"f32">;
      },
      enumerable: false,
      configurable: true,
    });
  }
  return v as unknown as Node<"f32x4">;
};

export function vec4(
  a: Node<"f32"> | number,
  b: Node<"f32"> | number,
  c: Node<"f32"> | number,
  d: Node<"f32"> | number,
): Node<"f32x4"> {
  const v = new Float32Array(4);
  v[0] = a as number;
  v[1] = b as number;
  v[2] = c as number;
  v[3] = d as number;
  return wrap(v);
}

export function splat(x: Node<"f32"> | number): Node<"f32x4"> {
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

export const addVec = elementWise((a, b) => a + b);
export const subVec = elementWise((a, b) => a - b);
export const mulVec = elementWise((a, b) => a * b);
export const divVec = elementWise((a, b) => a / b);
