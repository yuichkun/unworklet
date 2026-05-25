/**
 * `forSample` — the per-sample loop primitive (`01-dsl.md` §10).
 *
 * - `forSample(callback)` runs the callback for each sample of the current
 *   render quantum (stride 1).
 * - `forSample.byN(stride, callback)` runs once per `stride` samples
 *   (typical use: `stride = 4` for SIMD bulk operations). Phase 10 で fill。
 *
 * The callback's second argument `everyNSamples` (= sub-rate primitive
 * per Q43) is delivered as an optional callback parameter rather than as
 * a free function import, so its scope is enforced by TypeScript scoping.
 * Phase 3 = `everyNSamples` も throw stub (= Phase 8 で fill)。
 */

import type { AstNode } from "../compile/ast.ts";
import { addStatement, getCurrentCapture, wrapAst } from "../compile/capture.ts";
import type { Node } from "../types.ts";

export type EveryNSamples = (n: number, body: () => void) => void;

export type ForSampleCallback = (i: Node<"i32">, everyNSamples: EveryNSamples) => void;

export interface ForSampleFn {
  (callback: ForSampleCallback): void;
  byN(stride: number, callback: ForSampleCallback): void;
}

const notImplemented = (): never => {
  throw new Error("not implemented");
};

const everyNSamplesStub: EveryNSamples = () => {
  notImplemented();
};

const forSampleBase = (callback: ForSampleCallback): void => {
  const ctx = getCurrentCapture();
  const loopBody: AstNode[] = [];
  const prev = ctx.currentLoopBody;
  ctx.currentLoopBody = loopBody;
  try {
    const i = wrapAst<"i32">({ kind: "loopCounter" });
    callback(i, everyNSamplesStub);
  } finally {
    ctx.currentLoopBody = prev;
  }
  addStatement({ kind: "forSample", stride: 1, body: loopBody });
};

export const forSample: ForSampleFn = Object.assign(forSampleBase, {
  byN(_stride: number, _callback: ForSampleCallback): void {
    notImplemented();
  },
});
