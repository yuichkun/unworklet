/**
 * Build-time graph capture context (= plan Q-B).
 *
 * Module-level mutable `currentCapture` holds the active context for
 * the duration of a `defineProcessor` body invocation. Primitives
 * (`mul` / `forSample` / `audioInput` / etc.) push declarations and
 * AST nodes into this context via the helpers below.
 *
 * Concurrent compile is not a Phase 3 requirement (= one process at a
 * time through `renderOffline`). Switching to `AsyncLocalStorage`
 * later affects only the helpers in this file — the public primitive
 * surface stays unchanged.
 */

import type { AstNode, CapturedGraph, Declaration } from "./ast.ts";
import type { Node, ScalarType } from "../types.ts";

export type CaptureContext = {
  declarations: Declaration[];
  statements: AstNode[];
  /**
   * When non-null, primitive calls append into this array instead of
   * the top-level `statements`. Set by `forSample` (= plan Step 3.3)
   * for the duration of its callback.
   */
  currentLoopBody: AstNode[] | null;
  /**
   * Counter id assigned per `everyNSamples` call-site (= §9.1). Each
   * sub-rate call site owns an independent counter that persists across
   * blocks, so the layout reserves one i32 slot per id. Numbered from 0
   * in capture order.
   */
  everyNSamplesCount: number;
  /**
   * Name prefix active only while a `instantiate` instance body runs
   * (= §5.6, Q53). User-named state / buffer inside the subgraph are
   * prefixed with `'<instance>/'` to avoid collisions across multiple
   * instances (= `'lpfL/z1'`). Empty `''` outside subgraphs.
   */
  namePrefix: string;
  /** Auto-name numbering for `instantiate` instances (= when the name is omitted; deterministic within the graph). */
  subgraphCount: number;
  /**
   * Sequence number for the temp locals used to pin mutable reads
   * (= `03-compiler.md` §2.7, issue #8). Assigned at each call site of
   * `state.read()` / `buffer.read()` / `buffer.readInterpolated()`; emit
   * allocates one slot per id past the fixed locals (= `TEMP_LOCAL_BASE +
   * tempId`). Monotonically increasing from 0 in capture order.
   */
  tempCount: number;
};

let currentCapture: CaptureContext | null = null;

export function newCaptureContext(): CaptureContext {
  return {
    declarations: [],
    statements: [],
    currentLoopBody: null,
    everyNSamplesCount: 0,
    namePrefix: "",
    subgraphCount: 0,
    tempCount: 0,
  };
}

/**
 * Capture a mutable memory read (`stateLoad` / `bufferRead` /
 * `bufferReadInterpolated`) into a temp WASM local at its lexical point and
 * return a `tempRef` `Node<T>` that reads it (= `03-compiler.md` §2.7, issue
 * #8). The `tempAssign` statement is recorded at the current statement position
 * (= before any enclosing statement, since the read is evaluated inner-to-outer
 * during graph capture), so a later `store` to the same slot cannot change what
 * the returned `Node` evaluates to. Pure arithmetic over the returned `tempRef`
 * stays referentially transparent under emit's lazy re-walk.
 */
export function captureTemp<T extends ScalarType>(read: AstNode, type: ScalarType): Node<T> {
  const ctx = getCurrentCapture();
  const tempId = ctx.tempCount++;
  addStatement({ kind: "tempAssign", tempId, valueType: type, value: read });
  return wrapAst<T>({ kind: "tempRef", tempId, type });
}

/** Hand out a unique id for the block-spanning counter slot of an `everyNSamples` call-site. */
export function nextEveryNSamplesCounterId(): number {
  const ctx = getCurrentCapture();
  return ctx.everyNSamplesCount++;
}

export function getCurrentCapture(): CaptureContext {
  if (!currentCapture) {
    throw new Error(
      "unworklet primitive call outside `defineProcessor` body — " +
        "primitives are only valid during graph capture",
    );
  }
  return currentCapture;
}

export function runCapture<T>(ctx: CaptureContext, fn: () => T): T {
  const prev = currentCapture;
  currentCapture = ctx;
  try {
    return fn();
  } finally {
    currentCapture = prev;
  }
}

export function addStatement(node: AstNode): void {
  const ctx = getCurrentCapture();
  if (ctx.currentLoopBody !== null) {
    ctx.currentLoopBody.push(node);
  } else {
    ctx.statements.push(node);
  }
}

export function addDeclaration(decl: Declaration): void {
  const ctx = getCurrentCapture();
  // A declaration is only legal in declaration scope (= the top of a defineProcessor /
  // defineSubgraph body, before the return). Declaring state.* / buffer.* / param.* /
  // event / message / instantiate in expression scope (= inside a forSample /
  // forSample.byN / everyNSamples / onReceive / onEvent handler body, while currentLoopBody
  // is set) is a graph-capture-time error per §5.6.4 / Q34 (= it would break the static
  // reservation of the state region and the build-time determination of the instance count).
  if (ctx.currentLoopBody !== null) {
    const name = "name" in decl && typeof decl.name === "string" ? ` '${decl.name}'` : "";
    throw new Error(
      `unworklet: declaration '${decl.kind}'${name} inside expression scope ` +
        `(forSample / everyNSamples / handler body). Declarations are only valid in ` +
        `declaration scope — the top of a defineProcessor / defineSubgraph body, before ` +
        `the returned process / method record. (stable ID 'scope-violation')`,
    );
  }
  ctx.declarations.push(decl);
}

export function finalize(ctx: CaptureContext): CapturedGraph {
  return { declarations: ctx.declarations, statements: ctx.statements };
}

// ─────────────────────────────────────────────────────────────────────────
// `Node<T>` proxy = wraps an AST node + carries the method-form dispatch
// table populated by `dsl/primitives.ts` (= plan Step 3.3) and
// `dsl/declarations.ts` (= plan Step 3.4).
// ─────────────────────────────────────────────────────────────────────────

const astPayload: unique symbol = Symbol("unworklet.astPayload");

type WrappedNode<T extends ScalarType | "f32x4"> = Node<T> & {
  readonly [astPayload]: AstNode;
};

/**
 * Prototype shared by every wrapped `Node<T>`. `registerNodeMethod`
 * extends this object during package init so method-form chains
 * (= `a.mul(b)`) dispatch into the same free-function path as the
 * named exports (= `mul(a, b)`).
 */
const nodePrototype: Record<string, unknown> = {};

export function wrapAst<T extends ScalarType | "f32x4">(node: AstNode): Node<T> {
  const wrapped = Object.create(nodePrototype) as WrappedNode<T>;
  Object.defineProperty(wrapped, astPayload, { value: node, enumerable: false });
  return wrapped;
}

export function unwrapAst(node: Node<ScalarType | "f32x4">): AstNode {
  const ast = (node as WrappedNode<ScalarType | "f32x4">)[astPayload];
  if (!ast) {
    throw new Error("expected wrapped `Node<T>` with AST payload");
  }
  return ast;
}

/**
 * Type-safely test whether a value is a `Node<T>` (= an AST proxy wrapped
 * by `wrapAst`).
 *
 * Main use = branching safely between `Node<T>` and a JS literal in the
 * payload field of `eventDecl.emitIf` (= a path that avoids wrapping
 * unwrapAst in try-catch). unwrapAst throws on failure, so routing through
 * a catch on the hot path costs more than necessary.
 */
export function isWrappedNode(value: unknown): value is Node<ScalarType | "f32x4"> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  return astPayload in (value as object);
}

export function registerNodeMethod(name: string, fn: (...args: never[]) => unknown): void {
  nodePrototype[name] = fn;
}
