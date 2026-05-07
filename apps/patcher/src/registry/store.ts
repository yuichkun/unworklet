// Storage backing for the node registry. Lives in a separate module so
// the side-effect `audio-*.ts` registration files can import it cleanly
// without hitting an ESM hoist-vs-TDZ deadlock with the public `index.ts`.

import type { NodeDef } from "../types";

export const registry: Record<string, NodeDef> = {};

export function register(...defs: NodeDef[]) {
  for (const d of defs) {
    if (registry[d.type]) {
      throw new Error(`Node type "${d.type}" already registered`);
    }
    registry[d.type] = d;
  }
}
