// Capture backend implementation: implements the CaptureBackend interface
// from @unworklet/core/internal by delegating to the capture-* primitives.
//
// The compiler installs this backend before invoking the user's body and
// uninstalls it after. This way, the user's defineProcessor body can import
// primitives from @unworklet/core unchanged, and they will dispatch into the
// AST capture path automatically.

import type { CaptureBackend } from "@unworklet/core/internal";

import * as P from "./capture-primitives.js";
import * as D from "./capture-decls.js";
import * as S from "./capture-simd.js";

export const captureBackend: CaptureBackend = {
  // Arithmetic
  add: P.add,
  sub: P.sub,
  mul: P.mul,
  div: P.div,
  mod: P.mod,
  neg: P.neg,
  min: P.min,
  max: P.max,
  abs: P.abs,
  clamp: P.clamp,

  // Comparison
  eq: P.eq,
  ne: P.ne,
  lt: P.lt,
  gt: P.gt,
  lte: P.lte,
  gte: P.gte,

  // Math
  sin: P.sin,
  cos: P.cos,
  tan: P.tan,
  tanh: P.tanh,
  exp: P.exp,
  log: P.log,
  sqrt: P.sqrt,
  floor: P.floor,
  ceil: P.ceil,
  frac: P.frac,

  // Precision-tagged variants
  sinPrecise: P.sinPrecise,
  cosPrecise: P.cosPrecise,
  tanPrecise: P.tanPrecise,
  tanhPrecise: P.tanhPrecise,
  expPrecise: P.expPrecise,
  logPrecise: P.logPrecise,
  sinTable: P.sinTable,
  cosTable: P.cosTable,
  expTable: P.expTable,
  logTable: P.logTable,

  // select
  select: P.select,

  // Conversion
  f32: P.f32,
  f64: P.f64,
  i32: P.i32,
  i64: P.i64,

  // Literal lift (chain-entry helper)
  num: P.num,

  // Declarations
  state: D.state,
  buffer: D.buffer,
  param: D.param,
  audioInput: D.audioInput,
  audioOutput: D.audioOutput,
  event: D.event,
  message: D.message,
  midiInput: D.midiInput,
  midiOutput: D.midiOutput,

  // Control flow
  forSample: D.forSample as any,
  everyNSamples: D.everyNSamples,
  defineSubgraph: D.defineSubgraph as any,

  // SIMD
  vec4: S.vec4,
  splat: S.splat,
  addVec: S.addVec,
  subVec: S.subVec,
  mulVec: S.mulVec,
  divVec: S.divVec,
};
