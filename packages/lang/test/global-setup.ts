/**
 * Build the shipped `dist/` of this package and of `@unworklet/core` ONCE, before
 * any test file runs.
 *
 * Several suites here assert against the published artefacts rather than the
 * source: `unworklet-tsc.test.ts` runs the real bin, and `materialize-lowered.test.ts`
 * spawns child Nodes that import `dist/index.mjs` and resolve `@unworklet/core`
 * from `node_modules`. Building inside one file's `beforeAll` made that file
 * DELETE those artefacts (`vp pack` empties `dist/` first) while sibling files
 * were reading them, so a child process could fail with `ERR_MODULE_NOT_FOUND`
 * depending only on how the run happened to interleave.
 *
 * The build is a precondition of the whole suite, so it belongs here, where it
 * runs once and finishes before the first test starts.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const LANG = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(LANG, "../..");
const VP = path.join(REPO, "node_modules/.bin/vp");

export function setup(): void {
  // Skipped in the workspace run: the root `globalSetup` builds these before any
  // project starts, and rebuilding here would empty `dist/` again while other
  // projects' tests are already reading it.
  if (process.env.UWK_DISTS_BUILT === "1") return;
  execFileSync(VP, ["pack"], { cwd: path.join(REPO, "packages/core"), stdio: "ignore" });
  execFileSync(VP, ["run", "build"], { cwd: LANG, stdio: "ignore" });
}
