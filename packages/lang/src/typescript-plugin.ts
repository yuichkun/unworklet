/**
 * The editor entry point: a TypeScript language-service plugin that makes
 * `.uwk.ts` files type-check through their desugared virtual code. Adding it to a
 * `tsconfig.json` is the whole setup — the plugin auto-injects the shipped ambient
 * `.d.ts`, so no `files` / `types` entry is needed and no `// @ts-nocheck`:
 *
 * ```jsonc
 * {
 *   "compilerOptions": {
 *     "plugins": [{ "name": "@unworklet/lang/typescript-plugin" }]
 *   }
 * }
 * ```
 *
 * VS Code users also select "Use Workspace Version" of TypeScript so the editor
 * loads the plugin. The same module powers a `tsc`-style CLI via Volar's program
 * proxy; see {@link createUwkLanguagePlugin}.
 */

import path from "node:path";

import { createLanguageServicePlugin } from "@volar/typescript/lib/quickstart/createLanguageServicePlugin.js";

import { createUwkLanguagePlugin } from "./ide/languagePlugin.ts";

// The plugin ships as `typescript-plugin/index.js` (a CommonJS bundle) sitting
// next to `dist/`, so the shipped ambient is at `../dist/ambient.d.ts`. `__dirname`
// is real in that CJS bundle; it is declared here only so the ESM source type-checks.
declare const __dirname: string;

export default createLanguageServicePlugin((ts, info) => {
  // Auto-inject the shipped ambient `.d.ts` into the project. A `.uwk.ts` writes no
  // imports — `audioInput` / `state` / `mul` / … are ambient globals — so without
  // it the desugared virtual code reports "Cannot find name 'mul'". Injecting it
  // here means the consumer's tsconfig needs only `plugins`, never a `files` entry.
  const ambientPath = path.join(__dirname, "..", "dist", "ambient.d.ts");
  const host = info.languageServiceHost;
  const getScriptFileNames = host.getScriptFileNames.bind(host);
  host.getScriptFileNames = () => {
    const files = getScriptFileNames();
    return files.includes(ambientPath) ? files : [...files, ambientPath];
  };

  return { languagePlugins: [createUwkLanguagePlugin(ts)] };
});
