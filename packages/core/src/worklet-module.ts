/**
 * The single source-string emitter for an `addModule()`'d worklet entry — the JS
 * that becomes the AudioWorklet module loaded in the `AudioWorkletGlobalScope`
 * realm. It embeds the compile-time `WorkletMeta` as an inline literal and boots
 * the runtime via `makeWorkletNamespaceFromMeta(meta)`; it MUST NOT re-import the
 * authoring source (no `defineProcessor` re-evaluation on the audio thread —
 * `00-foundations.md` §5.1).
 *
 * Two runtime sources share this one template:
 * - `import` — the build-time `?worklet` chunk (`@unworklet/unplugin`) loads
 *   the runtime via `import ... from "@unworklet/core/worklet"`. The module is
 *   served at a real URL, so its import resolves.
 * - `inline` — the in-browser runtime-compile path (`@unworklet/lang/browser`)
 *   inlines a self-contained bundle of the runtime that assigns
 *   `globalThis.__uwkMakeNs`. A Blob module cannot resolve a bare/sibling import
 *   (and Safari cannot resolve any import in addModule()'d code), so the runtime
 *   travels inline instead.
 */

import type { WorkletMeta } from "./worklet.ts";

export type WorkletRuntimeSource =
  | { readonly kind: "import" }
  | { readonly kind: "inline"; readonly code: string };

export type EmitWorkletModuleOptions = {
  /** Identifier passed to `registerProcessor(...)` (= main-side `processorName`). */
  readonly processorName: string;
  /** How the worklet realm obtains `makeWorkletNamespaceFromMeta`. */
  readonly runtime: WorkletRuntimeSource;
};

/**
 * Serialize a JSON-shaped value to a JS object-literal string. Identical to
 * `JSON.stringify` for every value EXCEPT `bigint`, which it renders as a native
 * BigInt literal (`0n`) so an `i64` state's `initial` survives as a real BigInt
 * in the worklet realm — `JSON.stringify` throws outright on a `bigint`.
 */
export function serializeMetaToJs(value: unknown): string {
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

export function emitWorkletModuleSource(
  meta: WorkletMeta,
  options: EmitWorkletModuleOptions,
): string {
  const { processorName, runtime } = options;
  const metaLiteral = serializeMetaToJs(meta);
  const prelude =
    runtime.kind === "import"
      ? 'import { makeWorkletNamespaceFromMeta } from "@unworklet/core/worklet";'
      : runtime.code;
  const factory =
    runtime.kind === "import" ? "makeWorkletNamespaceFromMeta" : "globalThis.__uwkMakeNs";
  return `${prelude}

const __unworkletMeta = ${metaLiteral};
const __unworkletNs = ${factory}(__unworkletMeta);

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
