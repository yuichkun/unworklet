/**
 * Checks, from outside, that the production demo, npm and the GitHub Releases
 * agree on the latest release: the demo serves the release manifest it was
 * built with, npm serves the same tarballs under `latest`, and the latest
 * GitHub Release carries that version.
 */

import { appendFileSync, writeFileSync } from "node:fs";

type DemoManifest = { version: string; fingerprint: string; packages: Record<string, string> };
type NpmLatest = Record<string, { latest: string; integrity: string }>;

export function checkReleaseConsistency(state: {
  demo: DemoManifest | null;
  npm: NpmLatest;
  releaseTag: string;
}): string[] {
  const names = Object.keys(state.npm).sort();
  const problems: string[] = [];

  const versions = new Set(names.map((n) => state.npm[n]!.latest));
  if (versions.size > 1) {
    problems.push(
      `npm's latest versions differ between packages: ${names
        .map((n) => `${n} ${state.npm[n]!.latest}`)
        .join(", ")}.`,
    );
  }

  const demo = state.demo;
  if (demo === null) {
    problems.push(
      "The production demo has no /release.json, so it was not deployed by the release workflow.",
    );
  } else {
    for (const name of names) {
      if (state.npm[name]!.latest !== demo.version) {
        problems.push(
          `The production demo is v${demo.version}, but npm's latest ${name} is ${state.npm[name]!.latest}.`,
        );
      }
    }
    for (const name of names) {
      const { latest, integrity } = state.npm[name]!;
      if (latest === demo.version && demo.packages[name] !== integrity) {
        problems.push(
          `The production demo was built from other ${name}@${latest} bytes than npm serves.`,
        );
      }
    }
  }

  for (const name of names) {
    if (`v${state.npm[name]!.latest}` !== state.releaseTag) {
      problems.push(
        `The latest GitHub Release is ${state.releaseTag}, but npm's latest ${name} is ${state.npm[name]!.latest}.`,
      );
    }
  }
  return problems;
}

const PACKAGES = [
  "@unworklet/core",
  "@unworklet/lang",
  "@unworklet/offline",
  "@unworklet/test",
  "@unworklet/unplugin",
];

/** `watch.ts <report file>`: writes the problems found, and exits non-zero when there are any. */
async function main(): Promise<void> {
  const response = await fetch("https://unworklet.vercel.app/release.json");
  const demo = response.ok ? ((await response.json()) as DemoManifest) : null;

  const npm: NpmLatest = {};
  for (const name of PACKAGES) {
    const packument = (await (await fetch(`https://registry.npmjs.org/${name}`)).json()) as {
      "dist-tags": { latest: string };
      versions: Record<string, { dist: { integrity: string } }>;
    };
    const latest = packument["dist-tags"].latest;
    npm[name] = { latest, integrity: packument.versions[latest]!.dist.integrity };
  }

  const release = (await (
    await fetch("https://api.github.com/repos/yuichkun/unworklet/releases/latest", {
      headers: { accept: "application/vnd.github+json" },
    })
  ).json()) as { tag_name: string };

  const problems = checkReleaseConsistency({ demo, npm, releaseTag: release.tag_name });
  const report =
    problems.length === 0
      ? "The production demo, npm and the latest GitHub Release agree.\n"
      : [
          "The production demo, npm and the latest GitHub Release disagree:",
          "",
          ...problems.map((p) => `- ${p}`),
          "",
          "See RELEASE.md for how to bring them back in line.",
          "",
        ].join("\n");
  console.log(report);
  writeFileSync(process.argv[2] ?? "watch-report.md", report);
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) appendFileSync(stepSummary, report);
  if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
