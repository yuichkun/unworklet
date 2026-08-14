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
  // Per-event witness entry: direction (so `.on` / `.emit` narrows) and the
  // declared field shape (so the payload types recover the declared `T`).
  //   eventRings   = `event({ to: 'main' })`   (worklet→main) → main receives → "out"
  //   messageRings = `event({ from: 'main' })` (main→worklet) → main sends    → "in"
  //   a same-name in/out pair (Q87)                                          → "inout"
  // Field markers: a scalar field is its wire type as a string
  // (`"f32"` / `"i32"` / `"bool"` etc.); a typed-array field is `{ array: <el> }`.
  // `EventSurfaceFor` in `@unworklet/core` reads these back into payload types.
  type WitnessField = { name: string; wireType?: string; payloadElementType?: string };
  type WitnessRing = { name: string; fields?: readonly WitnessField[] };
  // The two directions are separate rings with separate payloads, so their field
  // sets are tracked separately. Merging them would make a same-name in/out pair
  // (Q87) demand the outbound fields on `.emit(...)` and promise the inbound ones
  // to `.on(...)`, neither of which the runtime carries.
  type EventInfo = { outFields?: Map<string, string>; inFields?: Map<string, string> };
  const eventInfo = new Map<string, EventInfo>();
  const fieldMarker = (f: WitnessField): string =>
    f.payloadElementType !== undefined
      ? `{ array: ${JSON.stringify(f.payloadElementType)} }`
      : JSON.stringify(f.wireType ?? "unknown");
  const collect = (r: WitnessRing, into?: Map<string, string>): Map<string, string> => {
    const m = into ?? new Map<string, string>();
    for (const f of r.fields ?? []) m.set(f.name, fieldMarker(f));
    return m;
  };
  const ensureInfo = (name: string): EventInfo => {
    const prior = eventInfo.get(name);
    if (prior !== undefined) return prior;
    const info: EventInfo = {};
    eventInfo.set(name, info);
    return info;
  };
  for (const r of ns.eventRings as readonly WitnessRing[]) {
    const info = ensureInfo(r.name);
    info.outFields = collect(r, info.outFields);
  }
  for (const r of ns.messageRings as readonly WitnessRing[]) {
    const info = ensureInfo(r.name);
    info.inFields = collect(r, info.inFields);
  }
  const fieldsBody = (m: Map<string, string> | undefined): string => {
    const s = [...(m ?? [])].map(([n, t]) => `${JSON.stringify(n)}: ${t}`).join("; ");
    return s === "" ? "{}" : `{ ${s} }`;
  };
  const events = [...eventInfo]
    .map(([name, info]) => {
      const key = JSON.stringify(name);
      // A single-direction port keeps the flat `fields` shape; only a genuine
      // in/out pair needs the split, so the common witness stays unchanged.
      if (info.outFields !== undefined && info.inFields !== undefined) {
        return (
          `${key}: { dir: "inout"; outFields: ${fieldsBody(info.outFields)}; ` +
          `inFields: ${fieldsBody(info.inFields)} }`
        );
      }
      const dir = info.outFields !== undefined ? "out" : "in";
      const fields = info.outFields ?? info.inFields;
      return `${key}: { dir: ${JSON.stringify(dir)}; fields: ${fieldsBody(fields)} }`;
    })
    .join("; ");
  // Per-port MIDI witness: direction only (`{ dir: "in" | "out" }`). MIDI events
  // carry a fixed `MidiEvent` union payload (not user-defined), so no `fields`
  // block — `MidiPortSurfaceFor` in `@unworklet/core` reads `dir` and narrows
  // the port surface to `.send` (main → worklet, `"in"`) or `.onEvent`
  // (worklet → main, `"out"`).
  const midi = named(ns.midiRings, (d) => {
    const dir = d.direction as "in" | "out";
    return `{ dir: ${JSON.stringify(dir)} }`;
  });
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
