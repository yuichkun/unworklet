/**
 * Build every shipped `dist/` ONCE, before any project's tests run.
 *
 * Several suites assert against the published artefacts rather than the source —
 * `@unworklet/core`'s export conditions, `unworklet-tsc`'s real bin, the temps
 * that child processes import. Building those inside a `beforeAll` made one
 * suite DELETE them (`vp pack` empties `dist/` first) while suites in OTHER
 * projects, which vitest runs in parallel, were importing them. The symptom is
 * `ERR_MODULE_NOT_FOUND` in a test that has nothing to do with building, in a
 * different place on each run.
 *
 * The artefacts are a precondition of the whole workspace run, so they are built
 * here. `UWK_DISTS_BUILT` tells the per-package hooks the work is done: they
 * still build when a package's suite is run on its own, where nothing else is
 * reading `dist/` concurrently.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const VP = path.join(REPO, "node_modules/.bin/vp");

export function setup(): void {
  execFileSync(VP, ["pack"], { cwd: path.join(REPO, "packages/core"), stdio: "ignore" });
  execFileSync(VP, ["run", "build"], { cwd: path.join(REPO, "packages/lang"), stdio: "ignore" });
  process.env.UWK_DISTS_BUILT = "1";
}
