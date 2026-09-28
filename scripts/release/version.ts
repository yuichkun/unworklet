/**
 * Turns the pending changesets into the next release: the shared version, the
 * CHANGELOG.md section, and the GitHub Release notes.
 *
 * Pre-1.0 the minor is the breaking-change axis (RELEASE.md), so a `minor`
 * changeset is a breaking change and everything else is a `patch`. Changesets
 * would turn a `major` into 1.0.0, which is never what a pre-1.0 changeset
 * means, so it is refused rather than released.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type ChangesetStatus = {
  changesets: Array<{
    id: string;
    summary: string;
    releases: Array<{ name: string; type: string }>;
  }>;
  releases: Array<{
    name: string;
    type: string;
    oldVersion: string;
    newVersion: string;
    changesets: string[];
  }>;
};

export type ReleasePlan = { version: string; changelog: string; notes: string };

const REPO_URL = "https://github.com/yuichkun/unworklet";

export function planRelease(
  status: ChangesetStatus,
  options: { changelog: string; date: string },
): ReleasePlan {
  const released = status.releases.filter((r) => r.type !== "none");
  if (released.length === 0)
    throw new Error("Nothing to release: there are no pending changesets.");

  const versions = [...new Set(released.map((r) => r.newVersion))];
  if (versions.length > 1) {
    throw new Error(
      `The packages would release under different versions (${versions.join(", ")}); ` +
        "they must move in lockstep.",
    );
  }
  const version = versions[0]!;

  for (const changeset of status.changesets) {
    for (const release of changeset.releases) {
      const oldVersion = released.find((r) => r.name === release.name)?.oldVersion ?? version;
      if (release.type === "major" && oldVersion.startsWith("0.")) {
        throw new Error(
          `Changeset "${changeset.id}" marks ${release.name} as major. Before 1.0 a breaking ` +
            "change is a minor; change the changeset to minor.",
        );
      }
    }
  }

  const isBreaking = (c: ChangesetStatus["changesets"][number]) =>
    c.releases.some((r) => r.type === "minor" || r.type === "major");
  const breaking = status.changesets.filter(isBreaking);
  const changes = status.changesets.filter((c) => !isBreaking(c));

  const groups = [
    { title: "Breaking", items: breaking },
    { title: "Changes", items: changes },
  ].filter((g) => g.items.length > 0);

  const section =
    `## ${version} — ${options.date}\n\n` +
    groups
      .map((g) => `### ${g.title}\n\n` + g.items.map((c) => `${c.summary.trim()}\n\n`).join(""))
      .join("");

  const firstRelease = options.changelog.search(/^## /m);
  const changelog =
    firstRelease === -1
      ? `${options.changelog}\n${section.trimEnd()}\n`
      : options.changelog.slice(0, firstRelease) + section + options.changelog.slice(firstRelease);

  const notes =
    groups
      .map(
        (g) =>
          `### ${g.title}\n\n` +
          g.items.map((c) => `- ${c.summary.trim().split("\n")[0]}\n`).join("") +
          "\n",
      )
      .join("") +
    `Full notes: [CHANGELOG.md at v${version}](${REPO_URL}/blob/v${version}/CHANGELOG.md)\n`;

  return { version, changelog, notes };
}

/**
 * Applies the plan to the working tree: writes CHANGELOG.md, lets Changesets
 * bump the package versions and delete the consumed changeset files, and
 * reports the version and notes path to the workflow.
 */
function main(): void {
  const work = mkdtempSync(path.join(tmpdir(), "uwk-version-"));
  const statusFile = path.join(work, "status.json");
  execFileSync("vp", ["exec", "changeset", "status", "--output", statusFile], { stdio: "inherit" });
  const status = JSON.parse(readFileSync(statusFile, "utf8")) as ChangesetStatus;

  const plan = planRelease(status, {
    changelog: readFileSync("CHANGELOG.md", "utf8"),
    date: new Date().toISOString().slice(0, 10),
  });

  execFileSync("vp", ["exec", "changeset", "version"], { stdio: "inherit" });
  writeFileSync("CHANGELOG.md", plan.changelog);

  const notesFile = path.join(work, "release-notes.md");
  writeFileSync(notesFile, plan.notes);
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `version=${plan.version}\nnotes=${notesFile}\n`);
  console.log(`Prepared v${plan.version}`);
}

if (import.meta.main) main();
