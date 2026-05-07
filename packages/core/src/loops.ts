import { getCurrentRuntime, Scope, nextSubgraphId } from "./runtime.js";
import { getCaptureBackend } from "./capture-backend.js";
import { wrap } from "./node-value.js";
import type { Node } from "./types.js";

export type ForSample = {
  (callback: (i: Node<"i32">) => void): void;
  byN(stride: number, callback: (i: Node<"i32">) => void): void;
};

const forSampleImpl = (callback: (i: Node<"i32">) => void): void => {
  const cap = getCaptureBackend();
  if (cap) return cap.forSample(callback as any);
  _forSampleImpl(1, callback);
};
(forSampleImpl as any).byN = function (stride: number, callback: (i: Node<"i32">) => void) {
  const cap = getCaptureBackend();
  if (cap) return cap.forSample.byN(stride, callback as any);
  if (!Number.isInteger(stride) || stride <= 0) {
    throw new Error(`forSample.byN stride must be a positive integer, got ${stride}`);
  }
  _forSampleImpl(stride, callback);
};

export const forSample = forSampleImpl as ForSample;

function _forSampleImpl(stride: number, callback: (i: Node<"i32">) => void) {
  const rt = getCurrentRuntime();
  // Drain pending messages/MIDI now (handlers above this forSample are registered).
  if (!rt._messagesDrained && rt._drainHook) {
    rt._drainHook();
    rt._messagesDrained = true;
  }
  const block = rt.currentBlockSize;
  for (let i = 0; i < block; i += stride) {
    rt.iStack.push(i);
    for (const s of rt.allScopes) s.resetSubgraphCursors();
    try {
      // Wrap so user code can chain methods on `i`: i.add(1), i.lt(64), etc.
      callback(wrap<Node<"i32">>(i));
    } finally {
      rt.iStack.pop();
    }
  }
}

export function everyNSamples(N: number, callback: () => void): void {
  const cap = getCaptureBackend();
  if (cap) return cap.everyNSamples(N, callback);
  if (!Number.isInteger(N) || N <= 0) {
    throw new Error(`everyNSamples N must be a positive integer, got ${N}`);
  }
  const rt = getCurrentRuntime();
  const i = rt.currentI();
  if (i === null) {
    throw new Error(
      "everyNSamples must be called inside a forSample callback (no `i` in scope at per-block phase)",
    );
  }
  const absSample = rt._absoluteSamplePos + i;
  if (absSample % N === 0) {
    callback();
  }
}

// defineSubgraph: returns a function that, when called, instantiates (lazily)
// per-call-site state and runs the body.
//
// Each call site gets its own instance pool indexed by call cursor (which
// resets at the start of each forSample iteration). State within an instance
// persists across all invocations of that instance.
export function defineSubgraph<A extends any[], R>(
  body: (...args: A) => R | { process: () => R },
): (...args: A) => R {
  // Note: this runs at module load, not per-render. We can't pre-bind to a
  // capture backend here because none is installed yet. Instead, the returned
  // function dispatches per-call.
  const sgId = nextSubgraphId();
  return function (...args: A): R {
    const cap = getCaptureBackend();
    if (cap) return cap.defineSubgraph(body as any)(...(args as any));
    const rt = getCurrentRuntime();
    const parentScope = rt.currentScope();
    let instances = parentScope.subgraphInstances.get(sgId);
    if (!instances) {
      instances = [];
      parentScope.subgraphInstances.set(sgId, instances);
      parentScope.subgraphCursors.set(sgId, 0);
    }
    const cursor = parentScope.subgraphCursors.get(sgId) ?? 0;
    let inst = instances[cursor];
    if (!inst) {
      const childScope = new Scope(parentScope.pathPrefix + `__sg${sgId}_${cursor}/`);
      rt.allScopes.push(childScope);
      inst = { scope: childScope };
      instances.push(inst);
    }
    parentScope.subgraphCursors.set(sgId, cursor + 1);

    rt.pushScope(inst.scope);
    inst.scope.resetDeclCursor();
    let result: any;
    try {
      result = body(...args);
      // After first invocation, mark scope as fully declared so subsequent
      // calls reuse existing slots.
      if (!inst.scope.fullyDeclared) {
        inst.scope.fullyDeclared = true;
      }
      // Handle { process: () => R } return shape
      if (
        result !== null &&
        typeof result === "object" &&
        typeof (result as any).process === "function"
      ) {
        // Cache the process function for subsequent runs (avoiding re-eval of decls)
        inst.processFn = (result as any).process;
        result = inst.processFn!();
      }
    } finally {
      rt.popScope();
    }
    return result as R;
  };
}
