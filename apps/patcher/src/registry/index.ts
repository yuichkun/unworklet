// Public registry surface. Side-effect imports register every NodeDef.

import type { NodeDef } from "../types";
export { registry, register } from "./store";
import { registry } from "./store";

// Side-effect imports populate `registry` via `register(...)`.
// Because each *.ts file imports `register` from `./store` (not from this
// `index`), the storage module fully initializes before any registration
// runs — no TDZ deadlock on import hoisting.
import "./audio-io";
import "./audio-osc";
import "./audio-math";
import "./audio-trig";
import "./audio-filters";
import "./audio-delays";
import "./audio-envelopes";
import "./audio-dynamics";
import "./audio-routing";
import "./audio-conv";
import "./audio-sampling";
import "./audio-viz";
import "./ui";
import "./control";
import "./control-time";
import "./midi";
import "./gen";
import "./patcher";

// Public list (sorted by category) for the palette.
export function listByCategory(): Record<string, NodeDef[]> {
  const result: Record<string, NodeDef[]> = {};
  for (const def of Object.values(registry)) {
    (result[def.category] ??= []).push(def);
  }
  for (const k of Object.keys(result)) {
    result[k]!.sort((a, b) => a.type.localeCompare(b.type));
  }
  return result;
}
