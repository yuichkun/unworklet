/**
 * Captures the `@unworklet/lang` type-environment snapshot in Node (at dev/build
 * time, where there is a disk + `ts.sys`) and serves it to the browser as the
 * virtual module `virtual:uwk-type-snapshot`. The live editor passes it to
 * `lower(src, { snapshot })` so `.uwk.ts` lowering runs entirely in the browser.
 *
 * Works in dev and prod identically — the plugin runs in the Vite/Node process
 * either way, so the shipped bundle carries a self-contained snapshot.
 */
import { captureFsSnapshot } from "@unworklet/lang";
import type { Plugin } from "vite-plus";

const VIRTUAL_ID = "virtual:uwk-type-snapshot";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

export function uwkTypeSnapshot(): Plugin {
  let serialized: string | undefined;
  return {
    name: "uwk-type-snapshot",
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      serialized ??= JSON.stringify(captureFsSnapshot());
      return `export default ${serialized};`;
    },
  };
}
