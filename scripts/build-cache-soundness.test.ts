/**
 * Release invariant: no cached command may produce files it cannot declare.
 *
 * Vite Task caches a command by replaying its terminal output. Files are
 * archived and restored only for a command that declares `output` globs, and
 * `output` belongs to a task in `vite.config.ts` — a `package.json` script has
 * no way to declare it. So a cached script that writes `dist/` gets replayed as
 * a success that writes nothing.
 *
 * That is not hypothetical. `run.cache: true` turned script caching on, and the
 * Vercel deploy of a commit whose `packages/core` inputs matched an earlier
 * deploy replayed core's build, wrote no `dist/`, and failed in
 * `@unworklet/lang`'s browser build with `Could not resolve
 * "@unworklet/core/worklet"` — pointing at a package that had just "built"
 * successfully.
 *
 * The condition below is the principle, not the current setting: a build may
 * cache once it is a task that says what it produces. Converting the scripts to
 * tasks with `output: ["dist/**"]` satisfies this test with caching left on.
 *
 * Found by the pre-release audit of #43.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import rootConfig from "../vite.config.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The five published packages, in the order `RELEASE.md` lists them. */
const PUBLISHED_PACKAGES = ["core", "lang", "offline", "test", "unplugin"] as const;

const readPkg = (relPath: string): { scripts?: Record<string, string> } =>
  JSON.parse(readFileSync(path.join(REPO, relPath), "utf8")) as {
    scripts?: Record<string, string>;
  };

/** `run.cache` accepts a boolean shorthand for both halves. */
function scriptCachingEnabled(cache: unknown): boolean {
  if (typeof cache === "boolean") return cache;
  if (typeof cache === "object" && cache !== null && "scripts" in cache) {
    return (cache as { scripts?: boolean }).scripts === true;
  }
  return false; // the documented default
}

test("a package.json build script is never cached", () => {
  const viaScript = PUBLISHED_PACKAGES.filter(
    (p) => readPkg(`packages/${p}/package.json`).scripts?.build !== undefined,
  );
  // Vacuously true once every build is a task — which is the other way to
  // satisfy this, and the one that keeps the cache.
  if (viaScript.length === 0) return;

  expect(
    scriptCachingEnabled(rootConfig.run?.cache),
    `${viaScript.map((p) => `@unworklet/${p}`).join(", ")} build via a package.json ` +
      `script, which cannot declare \`output\` globs. With \`run.cache.scripts\` on, a ` +
      `cache hit replays the build and writes no dist/. Either leave script caching ` +
      `off, or make each build a task with \`output: ["dist/**"]\`.`,
  ).toBe(false);
});
