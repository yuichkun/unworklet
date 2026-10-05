import type { Plugin } from "vite-plus";
import { captureFsSnapshot } from "../../packages/lang/src/capture.ts";
import { createHelpSignatures } from "./src/help/signatures.ts";

let snapshot: ReturnType<typeof captureFsSnapshot> | undefined;
let signatures: string | undefined;
export function editorAssets(): Plugin {
  return {
    name: "uwk-editor-assets",
    resolveId(id) {
      if (id === "virtual:uwk-editor-snapshot" || id === "virtual:uwk-help-signatures")
        return `\0${id}`;
    },
    load(id) {
      if (id === "\0virtual:uwk-editor-snapshot") {
        snapshot ??= captureFsSnapshot();
        return `export default ${JSON.stringify(snapshot)};`;
      }
      if (id === "\0virtual:uwk-help-signatures") {
        snapshot ??= captureFsSnapshot();
        signatures ??= JSON.stringify(createHelpSignatures(snapshot));
        return `export default ${signatures};`;
      }
    },
  };
}
