import path from "node:path";

import type { WorkletNamespace } from "@unworklet/core";

/**
 * Emit the per-file `?worklet` type witness for a compiled processor.
 *
 * The shipped `@unworklet/unplugin/client` reference declares a WILDCARD
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
  const named = (list: readonly unknown[], value: (d: Record<string, unknown>) => string): string =>
    list
      .map((d) => {
        const r = d as Record<string, unknown>;
        return `${JSON.stringify(r.name as string)}: ${value(r)}`;
      })
      .join("; ");
  // Names come straight off the compiled namespace. Values: params are always
  // AudioParams ("f32" marker), state carries its scalar type, the rest key on
  // the name with an `unknown` value — enough for completion + a typed surface,
  // since UnworkletNode maps each name to its fixed handle type.
  const params = named(ns.parameterDescriptors, () => `"f32"`);
  const state = named(ns.publishSlots, (d) => JSON.stringify(d.type as string));
  // Direction marker per event so the node surface narrows `.on` / `.emit`:
  // eventRings = `event({ to: 'main' })` (worklet→main) → main receives → "out";
  // messageRings = `event({ from: 'main' })` (main→worklet) → main sends → "in";
  // a name declared in both (a same-name in/out pair, Q87) → "inout".
  const eventDir = new Map<string, { out: boolean; in: boolean }>();
  for (const r of ns.eventRings) {
    const name = (r as { name: string }).name;
    eventDir.set(name, { out: true, in: eventDir.get(name)?.in ?? false });
  }
  for (const r of ns.messageRings) {
    const name = (r as { name: string }).name;
    eventDir.set(name, { out: eventDir.get(name)?.out ?? false, in: true });
  }
  const events = [...eventDir]
    .map(
      ([name, d]) =>
        `${JSON.stringify(name)}: ${JSON.stringify(d.out && d.in ? "inout" : d.out ? "out" : "in")}`,
    )
    .join("; ");
  const midi = named(ns.midiRings, () => "unknown");
  const inputs = named(ns.inputs, () => "unknown");
  const outputs = named(ns.outputs, () => "unknown");
  return `declare module ${JSON.stringify(specifier)} {
  const processor: import("@unworklet/core").CompiledProcessor<{
    params: { ${params} };
    state: { ${state} };
    events: { ${events} };
    midi: { ${midi} };
    inputs: { ${inputs} };
    outputs: { ${outputs} };
  }>;
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
