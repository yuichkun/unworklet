/**
 * Build-time adapter over `@unworklet/core`'s `emitWorkletModuleSource` — emits
 * the `?worklet` chunk's source (the JS loaded via `audioWorklet.addModule(url)`
 * in the worklet realm). The chunk is served at a real URL, so it boots the
 * runtime via `import { makeWorkletNamespaceFromMeta } from "@unworklet/core/worklet"`
 * (the `import` runtime source). The shared emitter inlines the `WorkletMeta` and
 * never re-imports the authoring source into the audio thread.
 *
 * The in-browser runtime-compile path (`@unworklet/lang/browser`) uses the same
 * emitter with the `inline` runtime source instead.
 */

import { emitWorkletModuleSource } from "@unworklet/core";
import type { WorkletMeta } from "@unworklet/core";

export type EmitWorkletTemplateOptions = {
  /** Identifier passed to `registerProcessor(...)` (= main-side `processorName`). */
  processorName: string;
  /** Serializable metadata extracted from the processor's captured graph. */
  meta: WorkletMeta;
};

export function emitWorkletTemplate(options: EmitWorkletTemplateOptions): string {
  return emitWorkletModuleSource(options.meta, {
    processorName: options.processorName,
    runtime: { kind: "import" },
  });
}
