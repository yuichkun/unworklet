#!/usr/bin/env node
/**
 * Two-stage build for @unworklet/lang. `vp pack` cleans `dist/` before writing,
 * so it must run FIRST; the vite lib build (`emptyOutDir: false`) then ADDS
 * `dist/browser.mjs` without wiping the packed main entry.
 *  1. `vp pack` bundles the main entry (`src/index.ts`) → `dist/index.mjs`.
 *  2. `vp build` (vite lib mode) bundles `src/browser.ts` → `dist/browser.mjs`,
 *     inlining the type snapshot + worklet runtime via the build plugins (tsdown
 *     can't run vite plugins, so this entry is built separately).
 */
import { execSync } from "node:child_process";

console.log("[unworklet/lang] pack (→ dist/index.mjs)");
execSync("vp pack", { stdio: "inherit" });

console.log("[unworklet/lang] build:browser (vite lib → dist/browser.mjs)");
execSync("vp build --config vite.browser.config.ts", { stdio: "inherit" });
