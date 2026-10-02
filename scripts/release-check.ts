/**
 * Decides whether the Release workflow (`.github/workflows/release.yml`) may
 * publish a merged `release/vX.Y.Z` pull request: the commit the merge created
 * on main must have exactly the files of the pull request's last commit (the
 * one its preview was built from), every package must carry the branch's
 * version, and no newer release may already be tagged. The tag is the first
 * thing a release creates, so a newer release that stopped partway counts too.
 *
 * In the workflow it reads BRANCH, SHA and LISTENED from the environment and
 * appends `VERSION=X.Y.Z` to `$GITHUB_ENV`:
 *
 *   vp exec node scripts/release-check.ts
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

export type ReleaseCheckInput = {
  /** Head branch of the merged pull request, e.g. `release/v0.4.0`. */
  branch: string;
  /** The commit the merge created on main. */
  sha: string;
  /** Whether that commit has exactly the files of the pull request's last commit. */
  sameFilesAsListened: boolean;
  /** `version` of each published package, by package name. */
  packageVersions: Record<string, string>;
  /** The commit each tag points to, by tag name. */
  tags: Record<string, string>;
};

const parse = (version: string): number[] | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : undefined;
};

const compare = (a: number[], b: number[]): number =>
  a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;

export function checkRelease(input: ReleaseCheckInput): { version: string } | { error: string } {
  if (!input.sameFilesAsListened) {
    return {
      error:
        "main differs from the pull request's last commit, so this is not what was listened to. See RELEASE.md.",
    };
  }
  const version = input.branch.slice("release/v".length);
  const parsed = input.branch.startsWith("release/v") ? parse(version) : undefined;
  if (!parsed) return { error: `${input.branch} is not release/vX.Y.Z with numbers only.` };

  for (const [name, actual] of Object.entries(input.packageVersions)) {
    if (actual !== version) {
      return { error: `${name} is at ${actual}, but ${input.branch} releases ${version}.` };
    }
  }

  const tagged = input.tags[`v${version}`];
  if (tagged !== undefined && tagged !== input.sha) {
    return { error: `v${version} was already released from ${tagged}.` };
  }

  const newer = Object.keys(input.tags)
    .map((tag) => ({ tag, parsed: tag.startsWith("v") ? parse(tag.slice(1)) : undefined }))
    .filter((t): t is { tag: string; parsed: number[] } => t.parsed !== undefined)
    .filter((t) => compare(t.parsed, parsed) > 0)
    .sort((a, b) => compare(b.parsed, a.parsed));
  if (newer.length > 0) {
    return {
      error: `${newer[0]!.tag} is already released and includes this release's changes, so v${version} is not published.`,
    };
  }
  return { version };
}

/** Tags by name from `git ls-remote --tags`, with annotated tags resolved to their commits. */
export function tagsFromLsRemote(output: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const line of output.split("\n").filter(Boolean)) {
    const [sha, ref] = line.split("\t") as [string, string];
    const name = ref.replace(/^refs\/tags\//, "");
    if (name.endsWith("^{}")) tags[name.slice(0, -"^{}".length)] = sha;
    else tags[name] ??= sha;
  }
  return tags;
}

const PACKAGES = ["core", "lang", "offline", "test", "unplugin"];

function main(): void {
  const { BRANCH, SHA, LISTENED, GITHUB_ENV } = process.env;
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

  git("fetch", "--depth", "1", "origin", LISTENED!);
  const result = checkRelease({
    branch: BRANCH!,
    sha: SHA!,
    sameFilesAsListened:
      git("rev-parse", `${SHA}^{tree}`) === git("rev-parse", `${LISTENED}^{tree}`),
    packageVersions: Object.fromEntries(
      PACKAGES.map((p) => {
        const { name, version } = JSON.parse(readFileSync(`packages/${p}/package.json`, "utf8"));
        return [name, version];
      }),
    ),
    tags: tagsFromLsRemote(git("ls-remote", "--tags", "origin", "refs/tags/v*")),
  });
  if ("error" in result) {
    console.error(`::error::${result.error}`);
    process.exit(1);
  }
  appendFileSync(GITHUB_ENV!, `VERSION=${result.version}\n`);
  console.log(`Releasing v${result.version}.`);
}

if (import.meta.main) main();
