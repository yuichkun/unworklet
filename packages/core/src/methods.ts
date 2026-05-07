// Method surface shared by interp-mode NodeImpl and capture-mode AST nodes.
// All methods delegate to the free-function primitives in primitives.ts —
// which already wrap interp returns and produce method-bearing AST nodes
// in capture mode — so the method just returns whatever the primitive
// gave back. Both styles (free function and method chain) produce
// identical graph / numeric behaviour.

import * as P from "./primitives.js";
import { NodeImpl } from "./node-value.js";

const M = {
  add(this: any, b: any) { return P.add(this, b); },
  sub(this: any, b: any) { return P.sub(this, b); },
  mul(this: any, b: any) { return P.mul(this, b); },
  div(this: any, b: any) { return P.div(this, b); },
  mod(this: any, b: any) { return P.mod(this, b); },
  neg(this: any) { return P.neg(this); },
  min(this: any, b: any) { return P.min(this, b); },
  max(this: any, b: any) { return P.max(this, b); },
  abs(this: any) { return P.abs(this); },
  clamp(this: any, lo: any, hi: any) { return P.clamp(this, lo, hi); },

  eq(this: any, b: any) { return P.eq(this, b); },
  ne(this: any, b: any) { return P.ne(this, b); },
  lt(this: any, b: any) { return P.lt(this, b); },
  gt(this: any, b: any) { return P.gt(this, b); },
  lte(this: any, b: any) { return P.lte(this, b); },
  gte(this: any, b: any) { return P.gte(this, b); },

  sin(this: any) { return P.sin(this); },
  cos(this: any) { return P.cos(this); },
  tan(this: any) { return P.tan(this); },
  tanh(this: any) { return P.tanh(this); },
  exp(this: any) { return P.exp(this); },
  log(this: any) { return P.log(this); },
  sqrt(this: any) { return P.sqrt(this); },
  floor(this: any) { return P.floor(this); },
  ceil(this: any) { return P.ceil(this); },
  frac(this: any) { return P.frac(this); },

  toF32(this: any) { return P.f32(this); },
  toF64(this: any) { return P.f64(this); },
  toI32(this: any) { return P.i32(this); },
  toI64(this: any) { return P.i64(this); },
};

// Patched onto the interp-mode wrapper so `wrap(1).add(2).mul(3)` works.
Object.assign(NodeImpl.prototype, M);

/**
 * Attach the shared method surface to a capture-mode AST node. Called by
 * c.fresh() so every node minted by the capture machinery is chainable.
 */
export function attachMethods(node: any): void {
  Object.assign(node, M);
}
