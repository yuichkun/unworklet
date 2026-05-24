/**
 * Processor / subgraph constructors (`01-dsl.md` §1 + §5.6).
 *
 * - `defineProcessor((ctx) => ...)`: declares a processor body, returns
 *   `CompiledProcessor<C>` (= graph + schemaHash + worklet namespace).
 * - `defineSubgraph((...args) => ...)`: declares a reusable subgraph at
 *   module scope; lambda args are bound per-instance at `createSubgraph` time.
 * - `createSubgraph(subgraph, ...lambdaArgs, options?)`: instantiates a
 *   subgraph in declaration scope. Returns the subgraph body's method
 *   record directly (= no `SubgraphInstance<S>` wrapper, per Q54).
 */

import type {
  CompiledProcessor,
  ProcessorBody,
  ProcessorContext,
  ProcessorGraph,
  ProcessorOptions,
  WorkletNamespace,
} from "./types.ts";
import type { CapturedGraph } from "./compile/ast.ts";
import { finalize, newCaptureContext, runCapture } from "./compile/capture.ts";

const notImplemented = (): never => {
  throw new Error("not implemented");
};

/**
 * Brand the internal `CapturedGraph` as the opaque public
 * `ProcessorGraph` token. `compile()` (= Step 3.5) recovers the AST
 * through the same identity; external consumers see only the brand.
 */
function brandGraph(graph: CapturedGraph): ProcessorGraph {
  return graph as unknown as ProcessorGraph;
}

const workletStub: WorkletNamespace = {
  initialize: (() => {
    throw new Error("worklet namespace not implemented");
  }) as WorkletNamespace["initialize"],
  process: (() => {
    throw new Error("worklet namespace not implemented");
  }) as WorkletNamespace["process"],
  parameterDescriptors: [],
};

export function defineProcessor<C = unknown>(
  body: (ctx: ProcessorContext) => ProcessorBody,
  _options?: ProcessorOptions,
): CompiledProcessor<C> {
  const captureCtx = newCaptureContext();

  // Declarations + the process lambda are gathered first. `ctx.sampleRate`
  // is a Phase 3 placeholder — the host (= `renderOffline`) will supply
  // the real rate when `compile()` is invoked end-to-end.
  const compiledBody = runCapture(captureCtx, () => {
    const procCtx: ProcessorContext = { sampleRate: 0 };
    return body(procCtx);
  });

  // Invoke `process` once during capture so its top-level statements
  // (= per-block code + `forSample` invocations) populate
  // `captureCtx.statements`.
  runCapture(captureCtx, () => {
    compiledBody.process();
  });

  return {
    graph: brandGraph(finalize(captureCtx)),
    schemaHash: "phase-3-stub",
    worklet: workletStub,
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

export function defineSubgraph<Args extends unknown[], Methods>(
  _body: (...args: Args) => Methods,
): SubgraphDecl<Args, Methods> {
  return notImplemented();
}

export type CreateSubgraphOptions = {
  name?: string;
};

/**
 * `createSubgraph(subgraph, ...lambdaArgs, options?)` — concrete signature
 * (variadic + optional trailing options) is impl-phase fill per Q53; this
 * stub accepts a permissive shape.
 */
export function createSubgraph<Args extends unknown[], Methods>(
  _subgraph: SubgraphDecl<Args, Methods>,
  ..._args: unknown[]
): Methods {
  return notImplemented();
}
