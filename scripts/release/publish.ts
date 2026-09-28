/**
 * Publishes the release tarballs exactly as they were built.
 *
 * npm scans every new version before it can be installed, and the scans finish
 * in no particular order. Publishing everything at once would leave a window in
 * which a package is installable while a package it depends on is not, so each
 * layer waits until the previous one is installable. A rerun publishes only
 * what npm does not have yet; a version npm has with other contents stops the
 * release, because a published version can never be replaced.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { publishLayers } from "./tarballs.ts";
import type { Tarball } from "./tarballs.ts";

export type Registry = {
  /** The integrity npm serves for name@version, or null while it cannot be installed. */
  integrity(name: string, version: string): Promise<string | null>;
};

export type PublishOptions = {
  registry: Registry;
  publish(tarball: Tarball): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  pollMs: number;
  timeoutMs: number;
};

export type PublishResult = Array<{ name: string; action: "published" | "already-published" }>;

const label = (t: Tarball) => `${t.name}@${t.version}`;

function differentContents(t: Tarball, served: string): Error {
  return new Error(
    `npm has ${label(t)} with different contents: npm serves ${served}, this release built ` +
      `${t.integrity}. A published version cannot be replaced; release a new version instead.`,
  );
}

export async function publishRelease(
  tarballs: Tarball[],
  options: PublishOptions,
): Promise<PublishResult> {
  const present = new Map<string, string | null>();
  for (const t of tarballs) {
    const served = await options.registry.integrity(t.name, t.version);
    if (served !== null && served !== t.integrity) throw differentContents(t, served);
    present.set(t.name, served);
  }

  const result: PublishResult = [];
  for (const layer of publishLayers(tarballs)) {
    const published: Tarball[] = [];
    for (const t of layer) {
      if (present.get(t.name) === t.integrity) {
        result.push({ name: t.name, action: "already-published" });
        continue;
      }
      await options.publish(t);
      published.push(t);
      result.push({ name: t.name, action: "published" });
    }

    const deadline = options.now() + options.timeoutMs;
    let waiting = published;
    while (waiting.length > 0) {
      const next: Tarball[] = [];
      for (const t of waiting) {
        const served = await options.registry.integrity(t.name, t.version);
        if (served === null) next.push(t);
        else if (served !== t.integrity) throw differentContents(t, served);
      }
      waiting = next;
      if (waiting.length === 0) break;
      if (options.now() >= deadline) {
        throw new Error(
          `${waiting.map(label).join(", ")} did not become installable within ` +
            `${options.timeoutMs / 60_000} minutes of publishing. Rerun the publish job once npm ` +
            "serves them; packages that are already published are skipped.",
        );
      }
      await options.sleep(options.pollMs);
    }
  }
  return result;
}

export const npmRegistry: Registry = {
  async integrity(name, version) {
    const response = await fetch(`https://registry.npmjs.org/${name}/${version}`, {
      headers: { accept: "application/json" },
    });
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(`npm registry answered ${response.status} for ${name}@${version}`);
    const body = (await response.json()) as { dist?: { integrity?: string } };
    return body.dist?.integrity ?? null;
  },
};

/** Publishes the tarballs listed in `<dir>/tarballs.json` with the workflow's trusted-publishing identity. */
async function main(): Promise<void> {
  const dir = path.resolve(process.argv[2] ?? "release-tarballs");
  const tarballs = (
    JSON.parse(readFileSync(path.join(dir, "tarballs.json"), "utf8")) as Tarball[]
  ).map((t) => ({ ...t, file: path.join(dir, t.file) }));

  const result = await publishRelease(tarballs, {
    registry: npmRegistry,
    publish: async (t) => {
      execFileSync(
        "vp",
        ["pm", "publish", t.file, "--access", "public", "--provenance", "--no-git-checks"],
        { stdio: "inherit" },
      );
    },
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    pollMs: 30_000,
    timeoutMs: 60 * 60_000,
  });

  const lines = result.map((r) => `| \`${r.name}\` | ${r.action} |`);
  const summary = ["| Package | Result |", "| --- | --- |", ...lines, ""].join("\n");
  console.log(summary);
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) appendFileSync(stepSummary, `## npm publish\n\n${summary}\n`);
}

if (import.meta.main) await main();
