/**
 * The editor entry point: a TypeScript language-service plugin that makes
 * `.uwk.ts` files type-check through their desugared virtual code. Add it to a
 * `tsconfig.json` (alongside the shipped ambient `.d.ts`) to get diagnostics,
 * hover, completion, rename, and go-to-definition on the sugar — no
 * `// @ts-nocheck` needed:
 *
 * ```jsonc
 * {
 *   "compilerOptions": {
 *     "plugins": [{ "name": "@unworklet/lang/typescript-plugin" }],
 *     "types": ["@unworklet/lang/ambient"]
 *   }
 * }
 * ```
 *
 * VS Code users also select "Use Workspace Version" of TypeScript so the editor
 * loads the plugin. The same module powers a `tsc`-style CLI via Volar's program
 * proxy; see {@link createUwkLanguagePlugin}.
 */

import { createLanguageServicePlugin } from "@volar/typescript/lib/quickstart/createLanguageServicePlugin.js";

import { createUwkLanguagePlugin } from "./ide/languagePlugin.ts";

export default createLanguageServicePlugin((ts) => ({
  languagePlugins: [createUwkLanguagePlugin(ts)],
}));
