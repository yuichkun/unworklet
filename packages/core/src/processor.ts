/**
 * Processor / subgraph constructors (`01-dsl.md` §1 + §5.6).
 *
 * - `defineProcessor((ctx) => ...)`: declares a processor body, returns
 *   `CompiledProcessor<C>` (= graph + schemaHash + worklet namespace).
 * - `defineSubgraph((...args) => ...)`: declares a reusable subgraph at
 *   module scope; lambda args are bound per-instance at `instantiate` time.
 * - `instantiate(subgraph, ...lambdaArgs, options?)`: instantiates a
 *   subgraph in declaration scope. Returns the subgraph body's method
 *   record directly (= no `SubgraphInstance<S>` wrapper, per Q54).
 */

import type {
  CompiledProcessor,
  Node,
  ProcessorBody,
  ProcessorContext,
  ProcessorGraph,
  ProcessorOptions,
} from "./types.ts";
import type { CapturedGraph } from "./compile/ast.ts";
import {
  finalize,
  getCurrentCapture,
  isWrappedNode,
  newCaptureContext,
  runCapture,
} from "./compile/capture.ts";
import { makeWorkletNamespace } from "./worklet.ts";
import { schemaHash } from "./compile/schemaHash.ts";

/**
 * Brand the internal `CapturedGraph` as the opaque public
 * `ProcessorGraph` token. `compile()` (= Step 3.5) recovers the AST
 * through the same identity; external consumers see only the brand.
 */
function brandGraph(graph: CapturedGraph): ProcessorGraph {
  return graph as unknown as ProcessorGraph;
}

/**
 * Default capture rate for the eager `graph` (= the rate-independent metadata
 * view: declarations, layout, worklet namespace, schema hash). The real host
 * rate flows into `compile`'s re-capture (`ctx.sampleRate` is a build-time
 * constant used for coefficient precomputation, so the emitted statements are
 * rate-specific while the schema is not).
 */
export const DEFAULT_CAPTURE_RATE = 48000;

/**
 * Run a `defineProcessor` body through a fresh capture context with the given
 * host sample rate bound to `ctx.sampleRate`, returning the captured AST DAG.
 * Re-runnable: every call uses an isolated context, so `compile` can re-capture
 * at the real rate without mutating the eager graph.
 */
export function captureProcessor(
  body: (ctx: ProcessorContext) => ProcessorBody,
  sampleRate: number,
): CapturedGraph {
  const captureCtx = newCaptureContext();
  const compiledBody = runCapture(captureCtx, () => body({ sampleRate }));
  runCapture(captureCtx, () => {
    compiledBody.process();
  });
  return finalize(captureCtx);
}

export function defineProcessor<C = unknown>(
  body: (ctx: ProcessorContext) => ProcessorBody,
  options?: ProcessorOptions,
): CompiledProcessor<C> {
  // Eager capture at the default rate: declarations / layout / worklet namespace
  // / schema hash are all rate-independent, so this view is correct regardless
  // of the host rate. `compile` re-captures at the real rate for emission.
  const captured = captureProcessor(body, DEFAULT_CAPTURE_RATE);

  return {
    graph: brandGraph(captured),
    // Migration anchor (`01-dsl.md` §8.3): hashed over declarations only, so it
    // is stable across host rates and process-body edits — a preset blob keeps
    // matching unless the slot schema itself changes.
    schemaHash: schemaHash(captured),
    worklet: makeWorkletNamespace(captured),
    migrations: options?.migrations,
    // Re-capture thunk: `compile` binds the real `ctx.sampleRate` here so
    // coefficient precomputation (`440 / ctx.sampleRate`, etc.) uses the host rate.
    __capture: (sampleRate: number) => brandGraph(captureProcessor(body, sampleRate)),
    __compiledProcessor: undefined as unknown as C,
  };
}

/**
 * Opaque subgraph constructor result. Concrete generic constraint for
 * lambda args + method record is impl-phase fill (Q53).
 */
declare const subgraphBrand: unique symbol;

export interface SubgraphDecl<Args extends unknown[], Methods> {
  readonly [subgraphBrand]: { args: Args; methods: Methods };
}

const SUBGRAPH_BODY = Symbol("unworklet.subgraphBody");

export function defineSubgraph<Args extends unknown[], Methods>(
  body: (...args: Args) => Methods,
): SubgraphDecl<Args, Methods> {
  // Carry the body under a symbol key so instantiate can retrieve it and
  // run it inside the active capture.
  return { [SUBGRAPH_BODY]: body } as unknown as SubgraphDecl<Args, Methods>;
}

export type CreateSubgraphOptions = {
  name?: string;
};

/**
 * One subgraph lambda arg, widened to also accept the raw primitive that lifts
 * to its `Node` type: a `Node<"f32">` / numeric-Node arg also accepts a bare
 * `number`, a `Node<"bool">` arg also accepts a `boolean`. This is what lets the
 * `.uwk.ts` sugar write `instantiate(onepole, 0.2)` (the lowering wraps the bare
 * `0.2` into `f32(0.2)` before it reaches the runtime). A non-`Node` arg — e.g.
 * a plain-number config like `defineSubgraph((sr: number) => ...)` — is left
 * exactly as declared, so it is NOT widened and is NOT lifted at runtime.
 */
type LiftArg<A> = A extends Node<infer T> ? (T extends "bool" ? A | boolean : A | number) : A;
type LiftArgs<Args extends unknown[]> = { [K in keyof Args]: LiftArg<Args[K]> };

// Treat a trailing argument as instantiate options only when it is a plain
// object whose sole key is `name` — this distinguishes it from a lambda arg that
// is a Node, an array, or a multi-key object.
function isCreateSubgraphOptions(v: unknown): v is CreateSubgraphOptions {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !isWrappedNode(v) &&
    Object.keys(v).length > 0 &&
    Object.keys(v).every((k) => k === "name")
  );
}

/**
 * `instantiate(subgraph, ...lambdaArgs, options?)` (= §5.6, Q53/Q54).
 *
 * In declaration scope, the subgraph body runs **inside the active capture**, so
 * its internal state / buffer declarations are registered into the parent graph
 * under the instance name prefix (= each instance gets independent state). The
 * method record returned by the body is returned **as-is** (= no
 * `SubgraphInstance` wrapper, Q54). Each method closure captures the instance's
 * state and can later be invoked in expression scope.
 */
export function instantiate<Args extends unknown[], Methods>(
  subgraph: SubgraphDecl<Args, Methods>,
  // The lambda args, constrained to the subgraph's declared tuple (each `Node`
  // arg also accepting its liftable primitive), plus an optional trailing
  // options object. A wrong type, a wrong arity, or a non-liftable value is a
  // compile error — the prior `...rest: unknown[]` accepted anything. There is
  // no runtime lift: a `Node` arg is either an explicit `Node` (raw core) or a
  // sugar literal the lowering already wrapped; a plain-number arg stays a
  // plain number.
  ...rest: [...LiftArgs<Args>, CreateSubgraphOptions?]
): Methods {
  const body = (subgraph as unknown as Record<symbol, ((...a: Args) => Methods) | undefined>)[
    SUBGRAPH_BODY
  ];
  if (typeof body !== "function") {
    throw new Error("unworklet: instantiate requires a defineSubgraph(...) value");
  }
  let args: unknown[] = rest;
  let instanceName: string | undefined;
  const last = rest[rest.length - 1];
  // Treat the trailing argument as options only when it has the options shape
  // ({name} only) AND the number of rest args exceeds the lambda's arity.
  // Otherwise, for a subgraph whose outer lambda takes a {name}-shaped config,
  // instantiate(sg, {name:"osc"}) would have its object misread as options:
  // the type binds it to the lambda arg, but at runtime it gets sliced off and
  // the body sees undefined (= a "types ⟺ runtime" violation). Treating only the
  // arity-exceeding trailing arg as options matches TS's `[...Args, options?]`
  // tuple interpretation.
  if (rest.length > 0 && isCreateSubgraphOptions(last) && rest.length > body.length) {
    instanceName = last.name;
    args = rest.slice(0, -1);
  }
  const ctx = getCurrentCapture();
  // instantiate is declaration-scope only (§5.6.4 / Q34). Instantiating in
  // expression scope (= while currentLoopBody is active: forSample /
  // everyNSamples / handler body) is a graph-capture-time error. Even a plain
  // subgraph with no internal state is rejected here (= when there are internal
  // declarations, addDeclaration in the body raises the same error).
  if (ctx.currentLoopBody !== null) {
    throw new Error(
      "unworklet: instantiate(...) inside expression scope " +
        "(forSample / everyNSamples / handler body). Subgraph instantiation is only valid " +
        "in declaration scope — the top of a defineProcessor / defineSubgraph body, before " +
        "the returned process / method record. (stable ID 'scope-violation')",
    );
  }
  const name = instanceName ?? `__sg_${ctx.subgraphCount++}`;
  const prevPrefix = ctx.namePrefix;
  ctx.namePrefix = prevPrefix + name + "/";
  const declStart = ctx.declarations.length;
  let methods: Methods;
  try {
    methods = body(...(args as Args));
  } finally {
    ctx.namePrefix = prevPrefix;
  }
  // §8.1 / Q41: an instance with no name plus a named-factory slot (= user-named
  // / persistent / publish = userNamed true) would have its snapshot / main-side
  // path use the auto prefix '__sg_N/...', which is instantiation-order
  // dependent and causes positional drift → graph-capture-time error. A
  // plain-only instance (= all internal slots anonymous) needs no stable path,
  // so no name is required (= the common case, §8.1).
  if (instanceName === undefined) {
    const named = ctx.declarations
      .slice(declStart)
      .find((d) => "userNamed" in d && (d as { userNamed?: boolean }).userNamed === true);
    if (named !== undefined) {
      const slotName = (named as { name?: string }).name ?? "?";
      throw new Error(
        `unworklet: subgraph instance with a named/persistent/publish slot '${slotName}' ` +
          `must be given an explicit instance name ` +
          `(instantiate(subgraph, ...args, { name: '...' })). Without it the snapshot path ` +
          `'__sg_N/...' depends on instantiation order (§8.1 / Q41). ` +
          `(stable ID 'subgraph-missing-name')`,
      );
    }
  }
  return methods;
}
