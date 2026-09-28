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

const DEMO_MANIFEST = "https://unworklet.vercel.app/release.json";
const LATEST_RELEASE = "https://api.github.com/repos/yuichkun/unworklet/releases/latest";

/**
 * Reads what the three currently serve. A request that fails throws rather than
 * reading as a disagreement, so an outage is not reported as a bad release.
 */
export async function readReleaseState(options: {
  names: string[];
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  githubToken?: string;
}): Promise<{ demo: DemoManifest | null; npm: NpmLatest; releaseTag: string }> {
  const read = async (url: string, init?: RequestInit, missingIsNull = false) => {
    const response = await options.fetch(url, init);
    if (response.ok) return response.json();
    if (missingIsNull && response.status === 404) return null;
    throw new Error(`Could not read ${url}: HTTP ${response.status}.`);
  };

  const demo = (await read(DEMO_MANIFEST, undefined, true)) as DemoManifest | null;

  const npm: NpmLatest = {};
  for (const name of options.names) {
    const packument = (await read(`https://registry.npmjs.org/${name}`)) as {
      "dist-tags": { latest: string };
      versions: Record<string, { dist: { integrity: string } }>;
    };
    const latest = packument["dist-tags"].latest;
    npm[name] = { latest, integrity: packument.versions[latest]!.dist.integrity };
  }

  const release = (await read(LATEST_RELEASE, {
    headers: {
      accept: "application/vnd.github+json",
      ...(options.githubToken ? { authorization: `Bearer ${options.githubToken}` } : {}),
    },
  })) as { tag_name: string };

  return { demo, npm, releaseTag: release.tag_name };
}

const PACKAGES = [
  "@unworklet/core",
  "@unworklet/lang",
  "@unworklet/offline",
  "@unworklet/test",
  "@unworklet/unplugin",
];

/**
 * `watch.ts <report file>`: writes the problems found, and exits non-zero when
 * there are any, setting the step output `disagree=true`.
 */
async function main(): Promise<void> {
  const state = await readReleaseState({
    names: PACKAGES,
    fetch,
    githubToken: process.env.GITHUB_TOKEN,
  });
  const problems = checkReleaseConsistency(state);
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
  if (problems.length > 0) {
    const output = process.env.GITHUB_OUTPUT;
    if (output) appendFileSync(output, "disagree=true\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
