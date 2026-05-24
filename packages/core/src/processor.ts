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
  ProcessorOptions,
} from "./types.ts";

const notImplemented = (): never => {
  throw new Error("not implemented");
};

export function defineProcessor<C = unknown>(
  _body: (ctx: ProcessorContext) => ProcessorBody,
  _options?: ProcessorOptions,
): CompiledProcessor<C> {
  return notImplemented();
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
