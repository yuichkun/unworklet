// Pluggable "capture backend" that swaps in to redirect primitive calls from
// direct-evaluation (the legacy interpreter) to AST capture (the compiler).
//
// The interface deliberately mirrors the existing primitives so the compiler
// can implement it, and the core's primitives check if a backend is installed
// before doing direct math.

import type { ScalarType, MidiEvent } from "./types.js";

export type CaptureBackend = {
  // Arithmetic / comparison / logic / math / select / convert
  add: (...args: any[]) => any;
  sub: (...args: any[]) => any;
  mul: (...args: any[]) => any;
  div: (...args: any[]) => any;
  mod: (...args: any[]) => any;
  neg: (a: any) => any;
  min: (a: any, b: any) => any;
  max: (a: any, b: any) => any;
  abs: (a: any) => any;
  clamp: (v: any, lo: any, hi: any) => any;

  eq: (a: any, b: any) => any;
  ne: (a: any, b: any) => any;
  lt: (a: any, b: any) => any;
  gt: (a: any, b: any) => any;
  lte: (a: any, b: any) => any;
  gte: (a: any, b: any) => any;

  sin: (a: any) => any;
  cos: (a: any) => any;
  tan: (a: any) => any;
  tanh: (a: any) => any;
  exp: (a: any) => any;
  log: (a: any) => any;
  sqrt: (a: any) => any;
  floor: (a: any) => any;
  ceil: (a: any) => any;
  frac: (a: any) => any;

  select: (cond: any, t: any, f: any) => any;

  f32: (a: any) => any;
  f64: (a: any) => any;
  i32: (a: any) => any;
  i64: (a: any) => any;

  // Declarations
  state: {
    f32: (initial: number, options?: any) => any;
    f64: (initial: number, options?: any) => any;
    i32: (initial: number, options?: any) => any;
    i64: (initial: number, options?: any) => any;
    bool: (initial: boolean, options?: any) => any;
  };
  buffer: {
    f32: (options: any) => any;
    f64: (options: any) => any;
    i32: (options: any) => any;
  };
  param: (options: any) => any;
  audioInput: (options: any) => any;
  audioOutput: (options: any) => any;

  event: <T = any>(options: any) => any;
  message: <T = any>(options: any) => any;
  midiInput: (options?: any) => any;
  midiOutput: (options?: any) => any;

  // Control flow
  forSample: ((cb: (i: any) => void) => void) & {
    byN: (stride: number, cb: (i: any) => void) => void;
  };
  everyNSamples: (N: number, cb: () => void) => void;
  defineSubgraph: <A extends any[], R>(body: (...args: A) => R) => (...args: A) => R;

  // SIMD
  vec4: (a: any, b: any, c: any, d: any) => any;
  splat: (x: any) => any;
  addVec: (a: any, b: any) => any;
  subVec: (a: any, b: any) => any;
  mulVec: (a: any, b: any) => any;
  divVec: (a: any, b: any) => any;
};

let backend: CaptureBackend | null = null;

export function getCaptureBackend(): CaptureBackend | null {
  return backend;
}

export function setCaptureBackend(b: CaptureBackend | null): void {
  backend = b;
}
