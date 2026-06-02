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
import { writeFileSync } from "node:fs";

import { build } from "esbuild";

const { execSync } = await import("node:child_process");

console.log("[unworklet/lang] pack (→ dist/index.mjs)");
execSync("vp pack", { stdio: "inherit" });

console.log("[unworklet/lang] build:browser (vite lib → dist/browser.mjs)");
execSync("vp build --config vite.browser.config.ts", { stdio: "inherit" });

console.log("[unworklet/lang] bundle TS plugin (→ dist/typescript-plugin.cjs)");
await build({
  entryPoints: ["src/typescript-plugin.ts"],
  outfile: "dist/typescript-plugin.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  // tsserver provides `typescript`; sharing its instance is required.
  external: ["typescript"],
  // esbuild emits `exports.default = …`; tsserver wants the factory at module.exports.
  footer: { js: "module.exports = module.exports.default;" },
  logLevel: "info",
});

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
