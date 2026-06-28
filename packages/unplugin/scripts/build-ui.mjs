#!/usr/bin/env node
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(here, "..", "devtools-ui");

console.log(`[unworklet/unplugin] build:ui  (${uiRoot})`);
execSync("vp build", { cwd: uiRoot, stdio: "inherit" });
