/**
 * `compile(processor)` — public WASM emission entry (`03-compiler.md` §1).
 *
 * Single async named export on `@unworklet/core` that all consumers
 * (`@unworklet/vite-plugin` build pipeline, `@unworklet/offline`'s
 * `renderOffline`, `replaceProcessor`, and pure Node / browser host
 * scripts that build processors at runtime) call.
 *
 * Orchestrates the 4 stage-別 internal modules (= plan Q-D):
 *
 *   capturedGraph = processor.graph (= defineProcessor で 構 築 済 の
 *                                       brand-only CapturedGraph)
 *   diagnostics   = analyze(graph)        ← Phase 3 = noop = []
 *   memory        = layout(graph)         ← sub-region 区 切 り + ioScratch
 *   wasm          = await emit(graph,     ← binaryen lower (dynamic import)
 *                              memory)
 *   schemaHash    = schemaHash(graph)     ← JSON.stringify + SHA-256 hex
 *
 * Returns `{ wasm, graph, memory, diagnostics, schemaHash,
 * __compiledProcessor }`。 graph / memory / diagnostics は opaque brand
 * cast = consumer は token と し て 扱 う (= vite-plugin / inspect 等 で
 * 内 部 type を 復 元 し て JSON artifact emit)。
 */

import type {
  CompiledProcessor,
  CompileResult,
  DiagnosticsJson,
  GraphJson,
  MemoryJson,
} from "../types.ts";

import { analyze } from "./analyze.ts";
import type { CapturedGraph } from "./ast.ts";
import { emit } from "./emit.ts";
import { layout } from "./layout.ts";
import { schemaHash } from "./schemaHash.ts";

export async function compile<C>(processor: CompiledProcessor<C>): Promise<CompileResult<C>> {
  const graph = processor.graph as unknown as CapturedGraph;
  const diagnostics = analyze(graph);
  const memory = layout(graph);
  const wasm = await emit(graph, memory);
  const hash = schemaHash(graph);
  return {
    wasm,
    graph: graph as unknown as GraphJson,
    memory: memory as unknown as MemoryJson,
    diagnostics: diagnostics as unknown as DiagnosticsJson,
    schemaHash: hash,
    __compiledProcessor: undefined as unknown as C,
  };
}
