/**
 * Loop primitives (`01-dsl.md` §10).
 *
 * - `forSample(callback)` runs the callback for each sample of the current
 *   render quantum (stride 1) — `ctx.renderQuantumSize` iterations per call.
 * - `forSample.byN(stride, callback)` runs once per `stride` samples
 *   (typical use: `stride = 4` for SIMD bulk operations).
 * - `forIndex(count, callback)` runs exactly `count` times per call, whatever
 *   the render quantum (a bin / table / voice loop, not a sample loop).
 *
 * The forSample callback's second argument `everyNSamples` (= sub-rate
 * primitive per Q43) is delivered as an optional callback parameter rather
 * than as a free function import, so its scope is enforced by TypeScript scoping.
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

export type ForIndexCallback = (index: Node<"i32">) => void;

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
    // The counter advances by the sample stride once per run of its body. Inside a
    // forIndex body that run repeats `count` times per sample, so the counter would
    // advance by count × stride per sample and the period would be wrong.
    if (ctx.loopDepth > 0 && ctx.sampleLoopDepth !== ctx.loopDepth - 1) {
      throw new Error(
        "unworklet: everyNSamples(...) inside a forIndex body. everyNSamples counts samples, " +
          "so it is only valid directly inside the forSample callback that provided it. " +
          "(stable ID 'scope-violation')",
      );
    }
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

// Capture a loop callback one nesting level down. Returns the collected body and
// this level's depth, which the loop node and every read of its counter carry so
// emit gives each level its own loop-counter local (Q58). A sample loop also
// becomes the target of implicit `atSample` stamps for the duration of its body.
const captureLoopBody = (
  isSampleLoop: boolean,
  run: (counter: Node<"i32">) => void,
): { depth: number; body: AstNode[] } => {
  const ctx = getCurrentCapture();
  const depth = ctx.loopDepth;
  const body: AstNode[] = [];
  const prevBody = ctx.currentLoopBody;
  const prevSampleDepth = ctx.sampleLoopDepth;
  ctx.currentLoopBody = body;
  ctx.loopDepth = depth + 1;
  if (isSampleLoop) ctx.sampleLoopDepth = depth;
  try {
    run(wrapAst<"i32">({ kind: "loopCounter", depth }));
  } finally {
    ctx.currentLoopBody = prevBody;
    ctx.loopDepth = depth;
    ctx.sampleLoopDepth = prevSampleDepth;
  }
  return { depth, body };
};

// Core of forSample, parameterized by stride (stride 1 is `forSample`; any stride is `byN`).
// Emission advances loopCounter in units of node.stride, so one call runs
// renderQuantumSize / stride iterations.
const forSampleStrided = (stride: number, callback: ForSampleCallback): void => {
  const { depth, body } = captureLoopBody(true, (i) => callback(i, makeEveryNSamples(stride)));
  addStatement({ kind: "forSample", stride, depth, body });
};

const forSampleBase = (callback: ForSampleCallback): void => {
  forSampleStrided(1, callback);
};

export const forSample: ForSampleFn = Object.assign(forSampleBase, {
  byN(stride: number, callback: ForSampleCallback): void {
    forSampleStrided(stride, callback);
  },
});

/**
 * Run `callback` exactly `count` times per `process()` call, with `index`
 * counting 0 … count − 1. Unlike `forSample`, the trip count does not follow the
 * render quantum, so a loop over FFT bins, a table, or voices keeps its length
 * when the processor is compiled for another quantum. `count` must be a
 * compile-time positive integer up to 2^31 − 1 (`illegal-forindex-count`).
 *
 * Nests with `forSample` and itself. `index` is not a sample offset: an emit
 * without `atSample` inside it still stamps the enclosing `forSample`'s sample
 * (0 outside every `forSample`), and `everyNSamples` is not available here.
 */
export function forIndex(count: number, callback: ForIndexCallback): void {
  const { depth, body } = captureLoopBody(false, callback);
  addStatement({ kind: "forIndex", count, depth, body });
}
