/**
 * Release invariant: every version string this repo ships moves in lockstep.
 *
 * Six files carry a version, and a release is only coherent when all six agree:
 * the five published npm packages (their `workspace:^` peers on each other
 * resolve to the published range at publish time, so a missed bump ships an
 * unsatisfiable peer), plus `.claude-plugin/plugin.json`.
 *
 * The plugin manifest is the one that is easy to forget and the most damaging to
 * forget. Claude Code treats `plugin.json`'s `version` as the **cache key for
 * update detection** — with it set, users keep their cached copy and
 * `/plugin update` reports "already at the latest version" until the string
 * changes, no matter how many commits land. The plugin ships `skills/unworklet/`,
 * so a stale version silently strands every guide fix. That is exactly what
 * happened between the v0.1.0 tag and this guard: twelve commits changed
 * `skills/` while `plugin.json` sat at `0.1.0`.
 *
 * This test spans every package at once, so it lives in the root project rather
 * than in any single package's suite (see `vite.config.ts`'s `test.include`).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The five published packages, in the order `RELEASE.md` lists them. */
const PUBLISHED_PACKAGES = ["core", "lang", "offline", "test", "unplugin"] as const;

const readVersion = (relPath: string): string => {
  const raw = readFileSync(path.join(REPO, relPath), "utf8");
  const { version } = JSON.parse(raw) as { version?: string };
  expect(version, `${relPath} has no "version" field`).toBeDefined();
  return version!;
};

test("all five published packages carry the same version", () => {
  const versions = PUBLISHED_PACKAGES.map((p) => ({
    file: `packages/${p}/package.json`,
    version: readVersion(`packages/${p}/package.json`),
  }));
  const distinct = [...new Set(versions.map((v) => v.version))];
  expect(
    distinct,
    `lockstep broken — ${versions.map((v) => `${v.file}=${v.version}`).join(", ")}`,
  ).toHaveLength(1);
});

test("the Claude Code plugin manifest carries the same version as the packages (a stale one strands every guide fix behind `/plugin update`)", () => {
  const pkgVersion = readVersion("packages/core/package.json");
  const pluginVersion = readVersion(".claude-plugin/plugin.json");
  expect(
    pluginVersion,
    `.claude-plugin/plugin.json is at ${pluginVersion} but the packages are at ` +
      `${pkgVersion}. Claude Code pins the plugin to this string, so users keep ` +
      `their cached copy — bump it with the packages (RELEASE.md step 2).`,
  ).toBe(pkgVersion);
});

test("the shared version is plain semver (Claude Code compares it as an opaque string)", () => {
  // No range operators, no `v` prefix, no build metadata: the plugin cache key is
  // a literal string comparison, and npm rejects a non-semver `version` outright.
  expect(readVersion("packages/core/package.json")).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});
