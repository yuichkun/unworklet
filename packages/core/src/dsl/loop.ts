/**
 * `forSample` — the per-sample loop primitive (`01-dsl.md` §10).
 *
 * - `forSample(callback)` runs the callback for each sample of the current
 *   render quantum (stride 1).
 * - `forSample.byN(stride, callback)` runs once per `stride` samples
 *   (typical use: `stride = 4` for SIMD bulk operations).
 *
 * The callback's second argument `everyNSamples` (= sub-rate primitive
 * per Q43) is delivered as an optional callback parameter rather than as
 * a free function import, so its scope is enforced by TypeScript scoping.
 */

import type { AstNode } from "../compile/ast.ts";
import {
  addStatement,
  getCurrentCapture,
  nextEveryNSamplesCounterId,
  wrapAst,
} from "../compile/capture.ts";
import type { Node } from "../types.ts";

export type EveryNSamples = (n: number, body: () => void) => void;

export type ForSampleCallback = (i: Node<"i32">, everyNSamples: EveryNSamples) => void;

export interface ForSampleFn {
  (callback: ForSampleCallback): void;
  byN(stride: number, callback: ForSampleCallback): void;
}

// Builds `everyNSamples(n, body)` (§9) bound to the stride of the enclosing forSample.
// The body is captured as a sub-block, and the everyNSamples node is pushed onto the loop body.
// Each call site gets a unique counterId, so the layout reserves a counter slot that persists across blocks.
const makeEveryNSamples =
  (stride: number): EveryNSamples =>
  (n, body) => {
    const ctx = getCurrentCapture();
    const counterId = nextEveryNSamplesCounterId();
    const subBody: AstNode[] = [];
    const prev = ctx.currentLoopBody;
    ctx.currentLoopBody = subBody;
    try {
      body();
    } finally {
      ctx.currentLoopBody = prev;
    }
    addStatement({ kind: "everyNSamples", divisor: n, stride, counterId, body: subBody });
  };

// Core of forSample, parameterized by stride (stride 1 is `forSample`; any stride is `byN`).
// Emission already advances loopCounter in units of node.stride, so one block runs 128 / stride iterations.
const forSampleStrided = (stride: number, callback: ForSampleCallback): void => {
  const ctx = getCurrentCapture();
  const loopBody: AstNode[] = [];
  const prev = ctx.currentLoopBody;
  ctx.currentLoopBody = loopBody;
  try {
    const i = wrapAst<"i32">({ kind: "loopCounter" });
    callback(i, makeEveryNSamples(stride));
  } finally {
    ctx.currentLoopBody = prev;
  }
  addStatement({ kind: "forSample", stride, body: loopBody });
};

const forSampleBase = (callback: ForSampleCallback): void => {
  forSampleStrided(1, callback);
};

export const forSample: ForSampleFn = Object.assign(forSampleBase, {
  byN(stride: number, callback: ForSampleCallback): void {
    forSampleStrided(stride, callback);
  },
});
