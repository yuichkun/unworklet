/**
 * The Volar {@link LanguagePlugin} for `.uwk.ts` files. It teaches any Volar-based
 * TypeScript tool (the editor TS-server plugin, a `tsc`-style CLI, a headless test
 * program) to type-check a `.uwk.ts` against its desugared virtual TypeScript
 * ({@link generateVirtualCode}) and project diagnostics / hover / completion /
 * definitions back to the author's source through the generated mappings.
 *
 * A `.uwk.ts` file already carries the `.ts` extension, so TypeScript includes it
 * in the program natively — this plugin only swaps its content for the virtual
 * code. `preventLeadingOffset` keeps the generated offsets identical to the
 * mappings (no whitespace prefix), so positions line up 1:1.
 */

import type { LanguagePlugin } from "@volar/language-core";
import type { TypeScriptServiceScript } from "@volar/typescript";

import type { FsSnapshot } from "../program.ts";
import { generateVirtualCode } from "./virtualCode.ts";

/** The Volar language id assigned to `.uwk.ts` source scripts. */
export const UWK_LANGUAGE_ID = "uwk";

export function isUwkScript(scriptId: string): boolean {
  return scriptId.endsWith(".uwk.ts");
}

export type UwkLanguagePluginOptions = {
  /**
   * A captured file-system snapshot for the type-directed analysis, for hosts
   * without disk access (the browser). Node hosts omit it (disk-backed).
   */
  snapshot?: FsSnapshot;
};

export function createUwkLanguagePlugin(
  ts: typeof import("typescript"),
  options: UwkLanguagePluginOptions = {},
): LanguagePlugin<string> {
  return {
    getLanguageId(scriptId) {
      return isUwkScript(scriptId) ? UWK_LANGUAGE_ID : undefined;
    },
    createVirtualCode(_scriptId, languageId, snapshot) {
      if (languageId !== UWK_LANGUAGE_ID) return undefined;
      const source = snapshot.getText(0, snapshot.getLength());
      const { code, mappings } = generateVirtualCode(source, { snapshot: options.snapshot });
      return {
        id: "main",
        languageId: "typescript",
        snapshot: {
          getText: (start, end) => code.slice(start, end),
          getLength: () => code.length,
          getChangeRange: () => undefined,
        },
        mappings,
      };
    },
    typescript: {
      extraFileExtensions: [],
      getServiceScript(root): TypeScriptServiceScript {
        return {
          code: root,
          extension: ".ts",
          scriptKind: ts.ScriptKind.TS,
          preventLeadingOffset: true,
        };
      },
    },
  };
}
