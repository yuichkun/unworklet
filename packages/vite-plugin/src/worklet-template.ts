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

/**
 * Serialize a JSON-shaped value to a JavaScript object-literal string. Identical
 * to `JSON.stringify` for every value EXCEPT `bigint`, which it renders as a
 * native BigInt literal (`0n`). The result is embedded directly into the emitted
 * worklet entry's JS source, so an `i64` state's `initial` (a `bigint`) survives
 * as a real BigInt in the worklet realm — `JSON.stringify` throws outright on a
 * `bigint`, and encoding it as a string would silently change the value's type.
 */
function serializeMetaToJs(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) {
    return `[${value
      .map((v) =>
        v === undefined || typeof v === "function" || typeof v === "symbol"
          ? "null"
          : serializeMetaToJs(v),
      )
      .join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined && typeof v !== "function" && typeof v !== "symbol")
      .map(([k, v]) => `${JSON.stringify(k)}:${serializeMetaToJs(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function emitWorkletTemplate(options: EmitWorkletTemplateOptions): string {
  const { processorName, meta } = options;
  // `WorkletMeta` can carry a `bigint` (= an `i64` state's `initial`), which
  // `JSON.stringify` refuses to serialize. Emit a JS object literal so the
  // bigint round-trips as a native `0n` literal in the worklet realm.
  const metaLiteral = serializeMetaToJs(meta);
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
