// @unworklet/compiler — graph capture + WASM emission

export { capture, type CaptureOptions, type ProcessorBodyForCapture } from "./capture.js";
export { planLayout, type MemoryLayout } from "./memory-layout.js";
export { emitWasm } from "./wasm-emit.js";
export { captureBackend } from "./backend.js";
export {
  generateWorkletModule,
  generateWorkletBundle,
  type WorkletModuleOptions,
  type WorkletBundle,
} from "./worklet-codegen.js";
export {
  analyze,
  formatDiagnostic,
  type Diagnostic,
  type AnalysisResult,
} from "./static-analysis.js";

export * as ast from "./ast.js";

import { capture } from "./capture.js";
import { planLayout, type MemoryLayout } from "./memory-layout.js";
import { emitWasm } from "./wasm-emit.js";
import { captureBackend } from "./backend.js";
import { setCaptureBackend } from "@unworklet/core/internal";
import type { CapturedGraph } from "./ast.js";
import type { CompiledProcessor } from "@unworklet/core";

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

// Capture + plan + emit. Accepts either a raw body or a CompiledProcessor
// (the value returned by defineProcessor). The capture backend is installed
// for the duration of capture so that the user's @unworklet/core primitive
// imports dispatch into AST construction.
export function compileToWasm(
  source: CompiledProcessor | import("./capture.js").ProcessorBodyForCapture,
  opts: CompileOptions,
): CompileResult {
  const body =
    typeof source === "function"
      ? (source as import("./capture.js").ProcessorBodyForCapture)
      : ((ctx: { sampleRate: number; renderQuantum: number }) =>
          (source as CompiledProcessor).body(ctx));

  setCaptureBackend(captureBackend);
  let graph: CapturedGraph;
  try {
    graph = capture(body, opts);
  } finally {
    setCaptureBackend(null);
  }
  const layout = planLayout(graph, { renderQuantum: opts.renderQuantum ?? 128 });
  const { binary, text } = emitWasm(graph, layout);
  return { graph, layout, binary, text };
}
