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

// `everyNSamples(n, body)` (= §9) を 囲 う forSample の stride に bind し て 生 成。
// body を sub-block として capture し、everyNSamples node を loop body に push。
// counterId は call-site ごとに一意 = layout が block 跨ぎ counter slot を確保。
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

// stride 単位の forSample 本体 (= stride 1 が `forSample`、任意 stride が `byN`)。
// emit は既に node.stride 単位で loopCounter を進める (= 1 ブロック 128 / stride 回)。
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
