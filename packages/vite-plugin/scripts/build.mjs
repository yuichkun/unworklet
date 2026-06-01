#!/usr/bin/env node
import { cpSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const uiRoot = path.join(pkgRoot, "devtools-ui");
const uiSrcDist = path.join(uiRoot, "dist");
const uiDest = path.join(pkgRoot, "dist", "ui");

console.log(`[unworklet/vite-plugin] build:ui  (${uiRoot})`);
execSync("vp build", { cwd: uiRoot, stdio: "inherit" });

// Two entries: the plugin (`.`) and the dev-bridge browser module (`./devbridge`,
// imported by the injected DevTools page-script). Both are declared in `exports`.
console.log(`[unworklet/vite-plugin] pack     (${pkgRoot})`);
execSync("vp pack src/index.ts src/devbridge.ts", { cwd: pkgRoot, stdio: "inherit" });

console.log(`[unworklet/vite-plugin] copy ui → dist/ui`);
rmSync(uiDest, { recursive: true, force: true });
cpSync(uiSrcDist, uiDest, { recursive: true });
