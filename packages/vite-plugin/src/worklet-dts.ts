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
