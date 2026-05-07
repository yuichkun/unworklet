// SIMD primitives for capture mode (@unworklet/core/simd).

import { getCtx, lift } from "./capture.js";
import type { ASTValue } from "./ast.js";

export const vec4 = (a: any, b: any, c: any, d: any): ASTValue => {
  const ctx = getCtx();
  const lanes = [lift(a), lift(b), lift(c), lift(d)];
  return makeVecValue(
    ctx.fresh({
      kind: "vec-ctor",
      type: "f32x4",
      lanes,
    }),
  );
};

export const splat = (x: any): ASTValue => {
  const ctx = getCtx();
  return makeVecValue(
    ctx.fresh({
      kind: "vec-splat",
      type: "f32x4",
      arg: lift(x, "f32"),
    }),
  );
};

function vecArith(op: "addVec" | "subVec" | "mulVec" | "divVec", a: any, b: any): ASTValue {
  const ctx = getCtx();
  return makeVecValue(
    ctx.fresh({
      kind: "vec-arith",
      type: "f32x4",
      op,
      a,
      b,
    }),
  );
}

export const addVec = (a: any, b: any) => vecArith("addVec", a, b);
export const subVec = (a: any, b: any) => vecArith("subVec", a, b);
export const mulVec = (a: any, b: any) => vecArith("mulVec", a, b);
export const divVec = (a: any, b: any) => vecArith("divVec", a, b);

// Lane is a method on the vec value. We attach a `.lane()` method on the ASTValue
// so the user code `acc.lane(0)` returns a new VecLane node. We also attach
// SIMD chain methods (`.add`, `.sub`, `.mul`, `.div`) that delegate to the
// vec arithmetic primitives — symmetric with the scalar Node<T> chain surface.
export function makeVecValue(v: ASTValue): ASTValue {
  const proxy: any = v;
  proxy.lane = (i: 0 | 1 | 2 | 3) => {
    const ctx = getCtx();
    return ctx.fresh({
      kind: "vec-lane",
      type: "f32",
      vec: v,
      lane: i,
    });
  };
  proxy.add = (b: any) => vecArith("addVec", v, b);
  proxy.sub = (b: any) => vecArith("subVec", v, b);
  proxy.mul = (b: any) => vecArith("mulVec", v, b);
  proxy.div = (b: any) => vecArith("divVec", v, b);
  return proxy;
}
