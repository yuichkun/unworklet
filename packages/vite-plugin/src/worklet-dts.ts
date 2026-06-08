import path from "node:path";

import type { WorkletNamespace } from "@unworklet/core";

/**
 * Emit the per-file `?worklet` type witness for a compiled processor.
 *
 * The shipped `@unworklet/vite-plugin/client` reference declares a WILDCARD
 * `declare module "*?worklet"` typed as `CompiledProcessor<unknown>` — enough to
 * resolve the import, but it erases the per-processor surface so `node.params.x`
 * is an untyped `Record`. This emits a MORE SPECIFIC `declare module` for one
 * processor file, whose default export carries the declared names; TypeScript
 * prefers the longest-matching module pattern, so the specific witness wins over
 * the wildcard and `node.params.<name>` becomes typed (an undeclared name errors).
 *
 * Names come from the compiled `WorkletNamespace` the plugin already evaluates
 * for `compile()`, so the type is derived from the same declarations the WASM is,
 * never hand-maintained.
 */
export function workletDts(specifier: string, ns: WorkletNamespace): string {
  const params = ns.parameterDescriptors
    .map((d) => `${JSON.stringify((d as { name: string }).name)}: "f32"`)
    .join("; ");
  return `declare module ${JSON.stringify(specifier)} {
  const processor: import("@unworklet/core").CompiledProcessor<{ params: { ${params} } }>;
  export default processor;
}
`;
}

/**
 * The aggregate witness for every `?worklet`-imported processor in the project:
 * one `declare module` per source, keyed on its filename so the wildcard matches
 * the consumer's `import x from "./<file>?worklet"`. The plugin writes this single
 * file and re-emits it on every processor edit; the editor's file watch refreshes
 * `node.params.<name>` completions without a restart (proven in worklet-dts-live).
 *
 * The module pattern is `*​/<basename>?worklet`, so two processors sharing a
 * basename in different folders would collide — the caller must warn rather than
 * silently shadow one.
 */
export function workletsDts(entries: { source: string; ns: WorkletNamespace }[]): string {
  return entries.map((e) => workletDts(`*/${path.basename(e.source)}?worklet`, e.ns)).join("\n");
}
