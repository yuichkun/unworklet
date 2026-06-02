/**
 * The editor entry is a well-formed TypeScript-server plugin factory. tsserver
 * loads the module and calls it with `{ typescript }`; the export must therefore
 * be a function. (The end-to-end behavior it wires up — diagnostics, hover,
 * completion, definition over the same language plugin — is proven in
 * `ide/languagePlugin.test.ts`.)
 */

import { expect, test } from "vite-plus/test";

import plugin from "./typescript-plugin.ts";

test("the default export is a PluginModuleFactory function tsserver can call", () => {
  expect(typeof plugin).toBe("function");
});
