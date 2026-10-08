import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const repo = "yuichkun/unworklet";
const root = `https://github.com/${repo}`;
type Page<T> = {
  totalCount: number;
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};
type PR = { number: number; title: string; url: string };
type Decision = { changelog?: string; excerpt?: string; reason?: string };
export type Inventory = {
  baseTag: string;
  baseRelease: { id: number; url: string; publishedAt: string };
  baseSha: string;
  candidate: string;
  commits: { sha: string; subject: string; prs: number[] }[];
  prs: PR[];
  decisions: Record<string, Decision>;
};

export async function collectPages<T>(
  fetchPage: (cursor: string | null) => Promise<Page<T>>,
): Promise<T[]> {
  const result: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let total: number | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    if (
      !page ||
      !Number.isSafeInteger(page.totalCount) ||
      page.totalCount < 0 ||
      !Array.isArray(page.nodes) ||
      page.nodes.some((node) => node == null) ||
      !page.pageInfo ||
      typeof page.pageInfo.hasNextPage !== "boolean"
    )
      throw new Error("Invalid API page");
    total ??= page.totalCount;
    if (total !== page.totalCount) throw new Error("API count changed during pagination");
    result.push(...page.nodes);
    if (result.length > total) throw new Error("API returned too many records");
    if (!page.pageInfo.hasNextPage) {
      if (result.length !== total) throw new Error("Incomplete API pagination");
      return result;
    }
    const next = page.pageInfo.endCursor;
    if (!next || cursors.has(next) || !page.nodes.length || result.length >= total)
      throw new Error("Invalid API cursor");
    cursors.add(next);
    cursor = next;
  }
}

function keys(inventory: Inventory): string[] {
  return [
    ...inventory.prs.map((pr) => `pr:${pr.number}`),
    ...inventory.commits
      .filter((commit) => !commit.prs.length)
      .map((commit) => `commit:${commit.sha}`),
  ].sort();
}

export function validateInventory(
  actual: Inventory,
  expected: Inventory,
  changelog: string,
  version?: string,
): void {
  for (const field of [
    "baseTag",
    "baseRelease",
    "baseSha",
    "candidate",
    "commits",
    "prs",
  ] as const) {
    if (!isDeepStrictEqual(actual[field], expected[field]))
      throw new Error(`Stale or incomplete inventory: ${field}`);
  }
  if (!actual.decisions || !isDeepStrictEqual(Object.keys(actual.decisions).sort(), keys(expected)))
    throw new Error("Missing or extra decisions");
  const lines = changelog.split("\n");
  const sections = lines.flatMap((line, i) => (line.startsWith("## ") ? [i] : []));
  const start = sections[0];
  const end = sections[1] ?? lines.length;
  if (
    start === undefined ||
    (version !== undefined && !lines[start]!.startsWith(`## ${version} — `)) ||
    !/^## \d+\.\d+\.\d+ — \d{4}-\d{2}-\d{2}$/.test(lines[start]!)
  )
    throw new Error("First CHANGELOG section must be the release version and date");
  for (const [key, decision] of Object.entries(actual.decisions)) {
    if (!decision || typeof decision !== "object") throw new Error(`Invalid decision: ${key}`);
    if (
      typeof decision.reason === "string" &&
      decision.reason.trim() &&
      !decision.changelog &&
      !decision.excerpt
    )
      continue;
    const prefix = `${root}/blob/${actual.candidate}/CHANGELOG.md#L`;
    const location =
      typeof decision.changelog === "string" && decision.changelog.startsWith(prefix)
        ? /^(\d+)(?:-L(\d+))?$/.exec(decision.changelog.slice(prefix.length))
        : null;
    if (!location || decision.reason)
      throw new Error(`Provide a pinned CHANGELOG link or omission reason: ${key}`);
    const from = Number(location[1]) - 1;
    const to = Number(location[2] ?? location[1]);
    if (
      from <= start ||
      to > end ||
      to <= from ||
      typeof decision.excerpt !== "string" ||
      !decision.excerpt.trim() ||
      lines.slice(from, to).join("\n") !== decision.excerpt
    )
      throw new Error(`Invalid CHANGELOG excerpt: ${key}`);
  }
}

type Release = {
  id: number;
  tag_name: string;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
};

export function verifyBaseRelease(value: unknown, baseTag: string): Inventory["baseRelease"] {
  const release = value as Release | null;
  if (
    !release ||
    release.tag_name !== baseTag ||
    release.draft !== false ||
    release.prerelease !== false ||
    !Number.isSafeInteger(release.id) ||
    release.id < 1 ||
    release.html_url !== `${root}/releases/tag/${baseTag}` ||
    typeof release.published_at !== "string" ||
    !Number.isFinite(Date.parse(release.published_at))
  )
    throw new Error("Invalid published stable release metadata");
  return { id: release.id, url: release.html_url, publishedAt: release.published_at };
}

const plainVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const compareVersions = (a: string, b: string): number => {
  const left = a.split(".").map(BigInt);
  const right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i]! < right[i]!) return -1;
    if (left[i]! > right[i]!) return 1;
  }
  return 0;
};

export function selectBaseRelease(
  values: unknown[],
  baseTag: string,
  version: string,
): Inventory["baseRelease"] {
  if (!plainVersion.test(version))
    throw new Error("Candidate package version must be plain semver");
  const eligible: Release[] = [];
  const ids = new Set<number>();
  for (const value of values) {
    const release = value as Release | null;
    if (
      !release ||
      typeof release.draft !== "boolean" ||
      typeof release.prerelease !== "boolean" ||
      typeof release.tag_name !== "string" ||
      !Number.isSafeInteger(release.id) ||
      release.id < 1 ||
      ids.has(release.id)
    )
      throw new Error("Incomplete or duplicate release metadata");
    ids.add(release.id);
    if (
      release.draft ||
      release.prerelease ||
      !release.tag_name.startsWith("v") ||
      !plainVersion.test(release.tag_name.slice(1))
    )
      continue;
    verifyBaseRelease(release, release.tag_name);
    if (compareVersions(release.tag_name.slice(1), version) < 0) eligible.push(release);
  }
  eligible.sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
  if (!eligible.length || eligible[0]!.tag_name !== baseTag)
    throw new Error(
      "Base tag is not the greatest published stable release below the candidate version",
    );
  return verifyBaseRelease(eligible[0], baseTag);
}

export function readCandidateChangelog(candidate: string): string {
  return execFileSync("git", ["show", `${candidate}:CHANGELOG.md`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

export async function generateInventory(baseTag: string, candidate: string): Promise<Inventory> {
  if (
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(baseTag) ||
    !/^[a-f0-9]{40}$/.test(candidate)
  )
    throw new Error("Use a plain release tag and full candidate SHA");
  if (git("rev-parse", "--is-shallow-repository") !== "false")
    throw new Error("Full git history required; fetch --unshallow first");
  const version = JSON.parse(git("show", `${candidate}:packages/core/package.json`)).version;
  const releases = await collectPages<unknown>(async (cursor) => {
    const query = `query($cursor: String) { repository(owner: "yuichkun", name: "unworklet") { releases(first: 100, after: $cursor) { totalCount nodes { id: databaseId tag_name: tagName html_url: url published_at: publishedAt draft: isDraft prerelease: isPrerelease } pageInfo { hasNextPage endCursor } } } }`;
    const args = ["api", "graphql", "-f", `query=${query}`];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const response = JSON.parse(
      execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }),
    );
    if (response.errors?.length) throw new Error("GitHub GraphQL returned release metadata errors");
    return response.data?.repository?.releases;
  });
  const baseRelease = selectBaseRelease(releases, baseTag, version);
  const baseSha = git("rev-parse", `refs/tags/${baseTag}^{commit}`);
  const remote = git(
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${baseTag}`,
    `refs/tags/${baseTag}^{}`,
  ).split("\n");
  const resolvedRemote = (remote.find((line) => line.endsWith("^{}")) ?? remote[0])?.split("\t")[0];
  if (resolvedRemote !== baseSha) throw new Error("Base tag is missing or differs from origin");
  git("merge-base", "--is-ancestor", baseSha, candidate);
  const shas = git("rev-list", "--reverse", "--topo-order", `${baseSha}..${candidate}`)
    .split("\n")
    .filter(Boolean);
  if (!shas.length) throw new Error("Empty release range");
  const range = new Set(shas);
  const prs = new Map<number, PR>();
  const commits: Inventory["commits"] = [];
  for (const sha of shas) {
    const associated = await collectPages<
      PR & { merged: boolean; mergeCommit: { oid: string } | null }
    >(async (cursor) => {
      const query = `query($sha: String!, $cursor: String) { repository(owner: "yuichkun", name: "unworklet") { object(expression: $sha) { ... on Commit { associatedPullRequests(first: 100, after: $cursor) { totalCount nodes { number title url merged mergeCommit { oid } } pageInfo { hasNextPage endCursor } } } } } }`;
      const args = ["api", "graphql", "-f", `query=${query}`, "-f", `sha=${sha}`];
      if (cursor) args.push("-f", `cursor=${cursor}`);
      const response = JSON.parse(
        execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }),
      );
      if (response.errors?.length) throw new Error("GitHub GraphQL returned errors");
      return response.data?.repository?.object?.associatedPullRequests;
    });
    const seen = new Set<number>();
    const included: number[] = [];
    for (const pr of associated) {
      if (
        !Number.isSafeInteger(pr.number) ||
        pr.number < 1 ||
        seen.has(pr.number) ||
        typeof pr.title !== "string" ||
        pr.url !== `${root}/pull/${pr.number}` ||
        typeof pr.merged !== "boolean" ||
        (pr.merged && !/^[a-f0-9]{40}$/.test(pr.mergeCommit?.oid ?? ""))
      )
        throw new Error(`Invalid PR association for ${sha}`);
      seen.add(pr.number);
      if (pr.merged && range.has(pr.mergeCommit!.oid)) {
        const item = { number: pr.number, title: pr.title, url: pr.url };
        if (prs.has(pr.number) && !isDeepStrictEqual(prs.get(pr.number), item))
          throw new Error("PR metadata changed during collection");
        prs.set(pr.number, item);
        included.push(pr.number);
      }
    }
    commits.push({
      sha,
      subject: git("show", "-s", "--format=%s", sha),
      prs: included.sort((a, b) => a - b),
    });
  }
  const inventory: Inventory = {
    baseTag,
    baseRelease,
    baseSha,
    candidate,
    commits,
    prs: [...prs.values()].sort((a, b) => a.number - b.number),
    decisions: {},
  };
  inventory.decisions = Object.fromEntries(keys(inventory).map((key) => [key, {}]));
  return inventory;
}

export const MAX_BODY_BYTES = 60_000;
const BEGIN = "<!-- release-inventory:start -->";
const END = "<!-- release-inventory:end -->";

function checkBodySize(notes: string): void {
  const bytes = Buffer.byteLength(notes, "utf8");
  if (bytes > MAX_BODY_BYTES)
    throw new Error(
      `PR body budget exceeded: ${bytes} > ${MAX_BODY_BYTES} UTF-8 bytes. Nothing was truncated; shorten prose or reviewed explanations, never remove scope entries.`,
    );
}

function escapeText(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[&<>"'`[\]\\*_{}()#+.!|~-]/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return `&#${char.charCodeAt(0)};`;
  });
}

export function renderInventory(inventory: Inventory): string {
  const fullSha = /^[a-f0-9]{40}$/;
  if (
    !fullSha.test(inventory.baseSha) ||
    !fullSha.test(inventory.candidate) ||
    inventory.commits.some((commit) => !fullSha.test(commit.sha)) ||
    inventory.prs.some((pr) => !Number.isSafeInteger(pr.number) || pr.number < 1)
  )
    throw new Error("Invalid inventory link identity");
  const direct = inventory.commits.filter((commit) => !commit.prs.length);
  const decisionText = (key: string): string => {
    const decision = inventory.decisions[key];
    if (!decision) return "**UNREVIEWED**";
    if (typeof decision.reason === "string" && decision.reason.trim())
      return `Omitted: ${escapeText(decision.reason)}`;
    const prefix = `${root}/blob/${inventory.candidate}/CHANGELOG.md#L`;
    if (
      typeof decision.changelog === "string" &&
      decision.changelog.startsWith(prefix) &&
      /^[1-9]\d*(?:-L[1-9]\d*)?$/.test(decision.changelog.slice(prefix.length)) &&
      typeof decision.excerpt === "string"
    )
      return `[CHANGELOG](${decision.changelog}): ${escapeText(decision.excerpt)}`;
    return "**UNREVIEWED**";
  };
  const machine = JSON.stringify(inventory).replace(
    /[<>&`]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const output = [
    BEGIN,
    `Base: [${escapeText(inventory.baseTag)}](${root}/releases/tag/${encodeURIComponent(inventory.baseTag)}) / [${inventory.baseSha}](${root}/commit/${inventory.baseSha})`,
    `Candidate: [${inventory.candidate}](${root}/commit/${inventory.candidate})`,
    `[Compare changes](${root}/compare/${inventory.baseSha}...${inventory.candidate})`,
    "",
    `${inventory.commits.length} commits; ${inventory.prs.length} PRs; ${direct.length} commits without an included PR.`,
    "",
    "### Included PRs",
    "",
    ...inventory.prs.map(
      (pr) =>
        `- [#${pr.number}](${root}/pull/${pr.number}) — ${escapeText(pr.title)} — ${decisionText(`pr:${pr.number}`)}`,
    ),
    ...(inventory.prs.length ? [] : ["None."]),
    "",
    "### Commits without an included PR",
    "",
    ...direct.map(
      (commit) =>
        `- [${commit.sha.slice(0, 7)}](${root}/commit/${commit.sha}) — ${escapeText(commit.subject)} — ${decisionText(`commit:${commit.sha}`)}`,
    ),
    ...(direct.length ? [] : ["None."]),
    "",
    "<details>",
    "<summary>Complete machine-readable inventory and CHANGELOG decisions</summary>",
    "",
    "```release-inventory",
    machine,
    "```",
    "",
    "</details>",
    END,
  ].join("\n");
  checkBodySize(output);
  return output;
}

function notesRegion(notes: string): { start: number; end: number; inventory: Inventory } {
  checkBodySize(notes);
  const starts = [...notes.matchAll(/^<!-- release-inventory:start -->\r?$/gm)];
  const ends = [...notes.matchAll(/^<!-- release-inventory:end -->\r?$/gm)];
  if (starts.length !== 1 || ends.length !== 1 || starts[0]!.index >= ends[0]!.index)
    throw new Error("Expected one generated release-inventory region");
  const start = starts[0]!.index;
  const end = ends[0]!.index + END.length;
  const blocks = [...notes.matchAll(/^```release-inventory\r?\n([\s\S]*?)\r?\n```\r?$/gm)];
  if (
    blocks.length !== 1 ||
    blocks[0]!.index < start ||
    blocks[0]!.index + blocks[0]![0].length > end
  )
    throw new Error("Expected one release-inventory block inside the generated region");
  return { start, end, inventory: JSON.parse(blocks[0]![1]!) };
}

export function inventoryFromNotes(notes: string): Inventory {
  const { start, end, inventory } = notesRegion(notes);
  if (notes.slice(start, end).replace(/\r\n/g, "\n") !== renderInventory(inventory))
    throw new Error(
      "Stale or missing readable inventory. Run render after editing machine decisions; then check against Git/API.",
    );
  return inventory;
}

export function refreshNotes(notes: string): string {
  const { start, end, inventory } = notesRegion(notes);
  const refreshed = notes.slice(0, start) + renderInventory(inventory) + notes.slice(end);
  checkBodySize(refreshed);
  return refreshed;
}

async function main(): Promise<void> {
  const [mode, baseTag, candidate] = process.argv.slice(2);
  if (mode === "generate" && baseTag && candidate) {
    const inventory = await generateInventory(baseTag, candidate);
    process.stdout.write(renderInventory(inventory));
  } else if (mode === "render" && baseTag) {
    process.stdout.write(refreshNotes(readFileSync(baseTag, "utf8")));
  } else if (mode === "check") {
    const notes = process.env.NOTES ?? readFileSync(process.argv[3]!, "utf8");
    const actual = inventoryFromNotes(notes);
    const expected = await generateInventory(
      actual.baseTag,
      process.env.LISTENED ?? candidate ?? git("rev-parse", "HEAD"),
    );
    validateInventory(
      actual,
      expected,
      readCandidateChangelog(expected.candidate),
      JSON.parse(git("show", `${expected.candidate}:packages/core/package.json`)).version,
    );
    console.log(
      `Release inventory and CHANGELOG accounting verified for ${expected.candidate}. Semantic review still required.`,
    );
  } else
    throw new Error(
      "Usage: release-inventory.ts generate <base-tag> <full-sha> | render <notes-file> | check <notes-file>",
    );
}
if (import.meta.main) await main();
