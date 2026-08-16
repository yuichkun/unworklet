/**
 * Release invariant: the five published packages move in lockstep.
 *
 * They depend on each other through `workspace:^` specifiers, which pnpm rewrites
 * into a real range against the sibling's version at publish time. Bump four and
 * forget one, and the four ship a peer range no published version satisfies —
 * every consumer install breaks.
 *
 * This test spans every package at once, so it belongs to no single package's
 * suite; it runs in the `release-invariants` project (see `scripts/vite.config.ts`).
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

test("the shared version is plain semver", () => {
  // No range operators, no `v` prefix, no build metadata — npm rejects a
  // non-semver `version` outright, and the tag derives from this string.
  expect(readVersion("packages/core/package.json")).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});
