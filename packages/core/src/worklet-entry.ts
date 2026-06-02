/**
 * `@unworklet/core/worklet` — worklet-realm-only entry point.
 *
 * Loaded by the vite-plugin-emitted `<processor>.worklet.js` template
 * inside `AudioWorkletGlobalScope`. Exposes the minimum surface needed to
 * boot a `WorkletNamespace` from inlined metadata + WASM bytes (= no
 * `defineProcessor` / no graph capture / no `binaryen` import) so the
 * worklet realm never re-evaluates authoring source.
 *
 * This split lets `vp build` / `vp dev` codegen
 *
 *   import { makeWorkletNamespaceFromMeta } from "@unworklet/core/worklet";
 *   const ns = makeWorkletNamespaceFromMeta(<inline JSON>);
 *
 * — and that import has no transitive dependency on `defineProcessor` /
 * `binaryen` / `compile()`, keeping the worklet chunk audio-thread-safe.
 */

export { makeWorkletNamespaceFromMeta } from "./worklet.ts";
export type { WorkletMeta } from "./worklet.ts";
export type { WorkletNamespace } from "./types.ts";
