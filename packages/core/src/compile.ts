/**
 * `compile(processor)` — public WASM emission entry (`03-compiler.md` §1).
 *
 * Single async named export on `@unworklet/core` that all consumers
 * (`@unworklet/vite-plugin` build pipeline, `@unworklet/offline`'s
 * `renderOffline`, `replaceProcessor`, and pure Node / browser host
 * scripts that build processors at runtime) call.
 *
 * Returns `{ wasm, graph, memory, diagnostics, schemaHash }` in one call.
 * `binaryen` is loaded via dynamic import from inside this function so
 * static-path consumers (= apps that never call `compile`) do not pay
 * the bundle cost (`09-repo-structure.md` §2.4 invariant).
 */

import type { CompiledProcessor, CompileResult } from "./types.ts";

export function compile<C>(_processor: CompiledProcessor<C>): Promise<CompileResult<C>> {
  throw new Error("not implemented");
}
