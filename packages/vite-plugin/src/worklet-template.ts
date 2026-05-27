/**
 * Emit the worklet runtime entry source (= the JS that becomes
 * `<processor>.worklet.js` and is loaded via `audioWorklet.addModule(url)`
 * in the AudioWorkletGlobalScope realm)。
 *
 * Authoritative shape (= `01-dsl.md` §11 + Q80 + `04-worklet-runtime.md` §2):
 * the worklet entry exposes a `class extends AudioWorkletProcessor` that
 * wires its 3 entry points (= `initialize` / `process` /
 * `parameterDescriptors`) onto an instance built from compile-time
 * **metadata only**。 The template MUST NOT re-import the authoring source
 * inside `AudioWorkletGlobalScope` — that would re-evaluate
 * `defineProcessor(...)` and any author top-level side effects in the
 * worklet realm, breaking the spec's audio-thread safety guarantees
 * (`00-foundations.md` §5.1) and forcing every `?worklet` consumer to
 * keep their processor source worklet-safe by hand。
 *
 * Instead the template inlines a JSON metadata blob (= layout + decl list)
 * computed once at build / dev time from `compile(processor).graph`, and
 * boots the runtime via `@unworklet/core/worklet`'s
 * `makeWorkletNamespaceFromMeta(meta)` — a thin entry that pulls in only
 * the runtime helpers (no `binaryen`, no `defineProcessor`, no graph
 * capture machinery)。
 */

import type { WorkletMeta } from "@unworklet/core";

export type EmitWorkletTemplateOptions = {
  /** Identifier passed to `registerProcessor(...)` (= main-side `processorName`). */
  processorName: string;
  /**
   * Serializable metadata extracted from the processor's captured graph at
   * build / dev time。 Inlined into the emitted worklet entry as JSON so
   * the worklet chunk depends only on compile outputs。
   */
  meta: WorkletMeta;
};

export function emitWorkletTemplate(options: EmitWorkletTemplateOptions): string {
  const { processorName, meta } = options;
  // JSON.stringify on `WorkletMeta` is safe — every field is a plain
  // serializable structure (= `Layout` is a record of offsets, decl arrays
  // hold primitive props per `ast.ts`)。 No functions, no symbols。
  const metaLiteral = JSON.stringify(meta);
  return `import { makeWorkletNamespaceFromMeta } from "@unworklet/core/worklet";

const __unworkletMeta = ${metaLiteral};
const __unworkletNs = makeWorkletNamespaceFromMeta(__unworkletMeta);

class UnworkletProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return __unworkletNs.parameterDescriptors;
  }
  constructor(opts) {
    super();
    __unworkletNs.initialize(this, opts);
  }
  process(inputs, outputs, parameters) {
    return __unworkletNs.process(this, inputs, outputs, parameters);
  }
}

registerProcessor(${JSON.stringify(processorName)}, UnworkletProcessor);
`;
}
