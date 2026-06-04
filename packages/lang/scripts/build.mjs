#!/usr/bin/env node
/**
 * Build for @unworklet/lang. `vp pack` cleans `dist/` before writing, so it runs
 * FIRST; everything else (`emptyOutDir: false`) then ADDS to `dist/`.
 *  1. `vp pack` bundles the main entry (`src/index.ts`) → `dist/index.mjs`.
 *  2. `vp build` (vite lib mode) bundles `src/browser.ts` → `dist/browser.mjs`,
 *     inlining the type snapshot + worklet runtime via the build plugins.
 *  3. esbuild bundles the editor TS-plugin entry → `dist/typescript-plugin.cjs`
 *     (CJS, because tsserver loads plugins with `require`; `typescript` stays
 *     external so it shares the editor's instance). The default export is
 *     re-published as `module.exports` so tsserver gets the factory directly.
 *  4. The ambient `.d.ts` is emitted from the single in-source `AMBIENT_DTS`
 *     string → `dist/ambient.d.ts`, the file users add to their `tsconfig` types.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { build } from "esbuild";

const { execSync } = await import("node:child_process");

console.log("[unworklet/lang] pack (→ dist/index.mjs)");
execSync("vp pack", { stdio: "inherit" });

console.log("[unworklet/lang] build:browser (vite lib → dist/browser.mjs)");
execSync("vp build --config vite.browser.config.ts", { stdio: "inherit" });

// tsserver resolves a tsconfig `plugins` entry with a LEGACY resolver that ignores
// the package `exports` map and only probes `<name>.js` / `<name>/index.js` (never
// `.cjs`). So the plugin must live at `<pkg>/typescript-plugin/index.js` with a
// sibling `package.json` marking it CommonJS (this package is `type: module`), so
// `@unworklet/lang/typescript-plugin` resolves for the editor. `typescript` stays
// external to share the editor's instance; the default export is re-published as
// `module.exports` so tsserver gets the factory directly.
console.log("[unworklet/lang] bundle TS plugin (→ typescript-plugin/index.js)");
mkdirSync("typescript-plugin", { recursive: true });
await build({
  entryPoints: ["src/typescript-plugin.ts"],
  outfile: "typescript-plugin/index.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["typescript"],
  footer: { js: "module.exports = module.exports.default;" },
  logLevel: "info",
});
writeFileSync(
  "typescript-plugin/package.json",
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
);

console.log("[unworklet/lang] emit ambient .d.ts (→ dist/ambient.d.ts)");
const ambientBundle = await build({
  entryPoints: ["src/ambient.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const ambientModule = await import(
  `data:text/javascript,${encodeURIComponent(ambientBundle.outputFiles[0].text)}`
);
writeFileSync("dist/ambient.d.ts", `${ambientModule.AMBIENT_DTS.trim()}\n`);
