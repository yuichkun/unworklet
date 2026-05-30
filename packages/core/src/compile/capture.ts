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
   * `everyNSamples` の call-site ごとに振る counter id (= §9.1)。 各 sub-rate
   * call site は block 跨ぎで継続する独立 counter を持つ = layout が id ごとに
   * i32 slot を確保する。 capture 順に 0 から採番。
   */
  everyNSamplesCount: number;
  /**
   * `createSubgraph` instance の body 実行中だけ立つ name prefix (= §5.6、Q53)。
   * subgraph 内の user-named state / buffer に `'<instance>/'` を前置して複数
   * instance の衝突を避ける (= `'lpfL/z1'`)。 非 subgraph では `''`。
   */
  namePrefix: string;
  /** `createSubgraph` instance の auto name 採番 (= name 省略時、graph 内で決定的)。 */
  subgraphCount: number;
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
  };
}

/** `everyNSamples` call-site に block 跨ぎ counter slot 用の一意 id を払い出す。 */
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
 * 値 が `Node<T>` (= `wrapAst` で 包 ま れ た AST proxy) か を 型 安 全 に 判 定。
 *
 * 主 用 途 = `eventDecl.emitIf` の payload field で 「Node<T> か JS literal か」
 * を 安 全 に 分 岐 (= unwrapAst を try-catch で 包 ま な い path)。 unwrapAst は
 * 失 敗 時 throw = ホ ッ ト path で catch 経 由 は cost が 不 必 要 に 高 い。
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
