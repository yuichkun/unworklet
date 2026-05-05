// @unworklet/compiler — graph capture + WASM emission
//
// Public API entry point.

export { capture, type CaptureOptions, type ProcessorBodyForCapture } from "./capture.js";
export { planLayout, type MemoryLayout } from "./memory-layout.js";
export { emitWasm } from "./wasm-emit.js";

export * as ast from "./ast.js";

import { capture } from "./capture.js";
import { planLayout, type MemoryLayout } from "./memory-layout.js";
import { emitWasm } from "./wasm-emit.js";
import type { CapturedGraph } from "./ast.js";

export type CompileOptions = {
  sampleRate: number;
  renderQuantum?: number;
};

export type CompileResult = {
  graph: CapturedGraph;
  layout: MemoryLayout;
  binary: Uint8Array;
  text: string;
};

// User-facing convenience: pass a CompiledProcessor (the result of
// defineProcessor with the capture-mode primitives bound), get back the
// compiled WASM module + layout.
export function compileToWasm(
  body: import("./capture.js").ProcessorBodyForCapture,
  opts: CompileOptions,
): CompileResult {
  const graph = capture(body, opts);
  const layout = planLayout(graph, { renderQuantum: opts.renderQuantum ?? 128 });
  const { binary, text } = emitWasm(graph, layout);
  return { graph, layout, binary, text };
}
