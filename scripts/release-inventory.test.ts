import { marked } from "marked";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  type Inventory,
  collectPages,
  validateInventory,
  generateInventory,
  inventoryFromNotes,
  renderInventory,
  refreshNotes,
  MAX_BODY_BYTES,
  verifyBaseRelease,
  selectBaseRelease,
  readCandidateChangelog,
} from "./release-inventory.ts";

const sha = "a".repeat(40);
const baseSha = "b".repeat(40);
const inventory = () => ({
  baseTag: "v0.5.0",
  baseRelease: {
    id: 123,
    url: "https://github.com/yuichkun/unworklet/releases/tag/v0.5.0",
    publishedAt: "2026-10-06T00:32:03Z",
  },
  baseSha,
  candidate: sha,
  commits: [
    { sha, subject: "fix", prs: [12] },
    { sha: "c".repeat(40), subject: "direct", prs: [] },
  ],
  prs: [{ number: 12, title: "fix", url: "https://github.com/yuichkun/unworklet/pull/12" }],
  decisions: {
    "pr:12": {
      changelog: `https://github.com/yuichkun/unworklet/blob/${sha}/CHANGELOG.md#L3`,
      excerpt: "- Fix audio.",
    },
    [`commit:${"c".repeat(40)}`]: { reason: "Release tooling only; no consumer behavior change." },
  },
});
const changelog =
  "# Changelog\n## 0.5.1 — 2026-10-08\n- Fix audio.\n## 0.5.0 — 2026-10-06\n- Old.\n";
test("accepts every PR and direct commit accounted for, including justified exclusions", () => {
  expect(() => validateInventory(inventory(), inventory(), changelog)).not.toThrow();
});
test.each(["candidate", "baseSha", "baseTag", "baseRelease", "commits", "prs"] as const)(
  "rejects stale or incomplete %s",
  (key) => {
    const edited = inventory();
    Object.assign(edited, { [key]: Array.isArray(edited[key]) ? [] : "stale" });
    expect(() => validateInventory(edited, inventory(), changelog)).toThrow();
  },
);
test("rejects missing, extra and unresolved decisions", () => {
  for (const decisions of [
    {},
    { ...inventory().decisions, extra: { reason: "extra" } },
    { ...inventory().decisions, "pr:12": {} },
  ]) {
    expect(() =>
      validateInventory({ ...inventory(), decisions }, inventory(), changelog),
    ).toThrow();
  }
});
test.each([
  `https://github.com/yuichkun/unworklet/blob/main/CHANGELOG.md#L3`,
  `https://evil.example/blob/${sha}/CHANGELOG.md#L3`,
  `https://github.com/yuichkun/unworklet/blob/${sha}/CHANGELOG.md#L99`,
  `https://github.com/yuichkun/unworklet/blob/${sha}/CHANGELOG.md#L03`,
  `https://github.com/yuichkun/unworklet/blob/${sha}/CHANGELOG.md#L3-L03`,
  `https://github.com/yuichkun/unworklet/blob/${sha}/CHANGELOG.md#L5`,
])("rejects invalid or previous-release changelog link %s", (changelogLink) => {
  const edited = inventory();
  edited.decisions["pr:12"].changelog = changelogLink;
  expect(() => validateInventory(edited, inventory(), changelog)).toThrow();
});
test("rejects excerpt mismatch and ambiguous dispositions", () => {
  const edited = inventory();
  edited.decisions["pr:12"].excerpt = "invented";
  expect(() => validateInventory(edited, inventory(), changelog)).toThrow();
  Object.assign(edited.decisions["pr:12"], { excerpt: "- Fix audio.", reason: "omit" });
  expect(() => validateInventory(edited, inventory(), changelog)).toThrow();
});
test("collects all pages, including empty associations", async () => {
  const pages = [
    { totalCount: 2, nodes: [1], pageInfo: { hasNextPage: true, endCursor: "a" } },
    { totalCount: 2, nodes: [2], pageInfo: { hasNextPage: false, endCursor: "b" } },
  ];
  expect(await collectPages(async () => pages.shift()!)).toEqual([1, 2]);
  expect(
    await collectPages(async () => ({
      totalCount: 0,
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    })),
  ).toEqual([]);
});
test("fails closed on truncated, repeated, inconsistent pages or API failure", async () => {
  for (const page of [
    { totalCount: 2, nodes: [1], pageInfo: { hasNextPage: false, endCursor: "a" } },
    { totalCount: 2, nodes: [1], pageInfo: { hasNextPage: true, endCursor: "a" } },
    { totalCount: 1, nodes: [1, 1], pageInfo: { hasNextPage: false, endCursor: null } },
  ])
    await expect(collectPages(async () => page)).rejects.toThrow();
  await expect(
    collectPages(async () => {
      throw new Error("API unavailable");
    }),
  ).rejects.toThrow("API unavailable");
});

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());

function mockRepository(options: { shallow?: boolean; remote?: string; response?: unknown } = {}) {
  vi.mocked(execFileSync).mockImplementation(((command: string, args: string[]) => {
    if (command === "gh" && args.some((arg) => arg.includes("releases(first:")))
      return JSON.stringify({
        data: {
          repository: {
            releases: {
              totalCount: 1,
              nodes: [release],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    if (command === "gh")
      return JSON.stringify(
        options.response ?? {
          data: {
            repository: {
              object: {
                associatedPullRequests: {
                  totalCount: 1,
                  nodes: [
                    {
                      number: 12,
                      title: "fix",
                      url: "https://github.com/yuichkun/unworklet/pull/12",
                      merged: true,
                      mergeCommit: { oid: sha },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      );
    if (args[0] === "rev-parse")
      return args[1] === "--is-shallow-repository" ? String(options.shallow ?? false) : baseSha;
    if (args[0] === "ls-remote") return `${options.remote ?? baseSha}\trefs/tags/v0.5.0`;
    if (args[0] === "merge-base") return "";
    if (args[0] === "rev-list") return sha;
    if (args[0] === "show")
      return args[1]?.endsWith(":packages/core/package.json")
        ? JSON.stringify({ version: "0.5.1" })
        : "fix";
    throw new Error(`Unexpected command ${command} ${args.join(" ")}`);
  }) as typeof execFileSync);
}

test("generates complete pinned metadata and leaves decisions unresolved", async () => {
  mockRepository();
  const actual = await generateInventory("v0.5.0", sha);
  expect(actual).toEqual({
    ...inventory(),
    commits: [inventory().commits[0]],
    decisions: { "pr:12": {} },
  });
  expect(() => validateInventory(actual, actual, changelog)).toThrow();
});
test("keeps unassociated commits explicit", async () => {
  mockRepository({
    response: {
      data: {
        repository: {
          object: {
            associatedPullRequests: {
              totalCount: 0,
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
  });
  const actual = await generateInventory("v0.5.0", sha);
  expect(actual.commits).toEqual([{ sha, subject: "fix", prs: [] }]);
  expect(actual.decisions).toEqual({ [`commit:${sha}`]: {} });
});
test.each([
  { shallow: true },
  { remote: "d".repeat(40) },
  { response: { errors: [{ message: "denied" }] } },
  { response: {} },
  {
    response: {
      data: {
        repository: {
          object: {
            associatedPullRequests: {
              totalCount: 1,
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
  },
])("rejects incomplete repository/API state %j", async (options) => {
  mockRepository(options);
  await expect(generateInventory("v0.5.0", sha)).rejects.toThrow();
});
test("rejects network/authentication failure", async () => {
  mockRepository();
  const implementation = vi.mocked(execFileSync).getMockImplementation()!;
  vi.mocked(execFileSync).mockImplementation(((command: string, args: string[]) => {
    if (command === "gh") throw new Error("HTTP 401");
    return implementation(command, args);
  }) as typeof execFileSync);
  await expect(generateInventory("v0.5.0", sha)).rejects.toThrow("HTTP 401");
});
test("requires unambiguous full refs and exactly one notes block", async () => {
  await expect(generateInventory("main", sha)).rejects.toThrow();
  await expect(generateInventory("v0.5.0", "abc123")).rejects.toThrow();
  const block = "```release-inventory\n" + JSON.stringify(inventory()) + "\n```";
  expect(inventoryFromNotes(renderInventory(inventory()))).toEqual(inventory());
  for (const notes of ["", block + "\n" + block, "```release-inventory\ninvalid\n```"])
    expect(() => inventoryFromNotes(notes)).toThrow();
});
test("both workflows bind accounting to the listened head before publication", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  expect(workflow.indexOf("scripts/release-check.ts")).toBeLessThan(
    workflow.indexOf("scripts/release-inventory.ts check"),
  );
  expect(workflow.indexOf("scripts/release-inventory.ts check")).toBeLessThan(
    workflow.indexOf("vp run build"),
  );
  expect(workflow).toContain("LISTENED: ${{ github.event.pull_request.head.sha }}");
  const prWorkflow = readFileSync(
    new URL("../.github/workflows/release-inventory.yml", import.meta.url),
    "utf8",
  );
  expect(prWorkflow).toContain("synchronize, edited");
  expect(prWorkflow).toContain("LISTENED: ${{ github.event.pull_request.head.sha }}");
  const template = readFileSync(
    new URL("../.github/release_pull_request_template.md", import.meta.url),
    "utf8",
  );
  expect(template.match(/^## .+$/gm)).toEqual([
    "## Problem / motivation",
    "## Changes",
    "## Validation",
    "## Related issues",
  ]);
});

test("rejects a dated but wrong version section", () => {
  expect(() =>
    validateInventory(inventory(), inventory(), changelog.replace("0.5.1", "0.5.0"), "0.5.1"),
  ).toThrow();
});

test("rejects a changed total count between pages", async () => {
  const pages = [
    { totalCount: 2, nodes: [1], pageInfo: { hasNextPage: true, endCursor: "a" } },
    { totalCount: 3, nodes: [2, 3], pageInfo: { hasNextPage: false, endCursor: "b" } },
  ];
  await expect(collectPages(async () => pages.shift()!)).rejects.toThrow("count changed");
});
test.each(["duplicate", "foreign-url", "missing-merge"])(
  "rejects corrupt PR metadata: %s",
  async (kind) => {
    const pr = {
      number: 12,
      title: "fix",
      url: "https://github.com/yuichkun/unworklet/pull/12",
      merged: true,
      mergeCommit: { oid: sha },
    };
    const nodes =
      kind === "duplicate"
        ? [pr, pr]
        : [
            {
              ...pr,
              ...(kind === "foreign-url"
                ? { url: "https://example.com/pull/12" }
                : { mergeCommit: null }),
            },
          ];
    mockRepository({
      response: {
        data: {
          repository: {
            object: {
              associatedPullRequests: {
                totalCount: nodes.length,
                nodes,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    });
    await expect(generateInventory("v0.5.0", sha)).rejects.toThrow("Invalid PR association");
  },
);
test("open PRs and PRs merged outside the range cannot hide direct commits", async () => {
  const nodes = [
    {
      number: 12,
      title: "open",
      url: "https://github.com/yuichkun/unworklet/pull/12",
      merged: false,
      mergeCommit: null,
    },
    {
      number: 13,
      title: "outside",
      url: "https://github.com/yuichkun/unworklet/pull/13",
      merged: true,
      mergeCommit: { oid: baseSha },
    },
  ];
  mockRepository({
    response: {
      data: {
        repository: {
          object: {
            associatedPullRequests: {
              totalCount: 2,
              nodes,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
  });
  const actual = await generateInventory("v0.5.0", sha);
  expect(actual.prs).toEqual([]);
  expect(actual.decisions).toEqual({ [`commit:${sha}`]: {} });
});

test("enumerates side-branch and merge commits from real Git with an annotated base tag", async () => {
  const { execFileSync: realExec } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const directory = mkdtempSync(join(tmpdir(), "release-inventory-"));
  const run = (...args: string[]) =>
    realExec(
      "git",
      ["-c", "user.name=Release test", "-c", "user.email=release@example.invalid", ...args],
      { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  try {
    run("init", "-b", "main");
    run("commit", "--allow-empty", "-m", "base");
    run("tag", "-a", "v0.5.0", "-m", "base tag");
    const resolvedBase = run("rev-parse", "HEAD");
    run("remote", "add", "origin", directory);
    run("switch", "-c", "side");
    run("commit", "--allow-empty", "-m", "side change");
    const side = run("rev-parse", "HEAD");
    run("switch", "main");
    run("commit", "--allow-empty", "-m", "direct change");
    const direct = run("rev-parse", "HEAD");
    run("merge", "--no-ff", "side", "-m", "merge side");
    const candidate = run("rev-parse", "HEAD");
    vi.mocked(execFileSync).mockImplementation(((command: string, args: string[]) =>
      command === "git"
        ? args[1]?.endsWith(":packages/core/package.json")
          ? JSON.stringify({ version: "0.5.1" })
          : run(...args)
        : args.some((arg) => arg.includes("releases(first:"))
          ? JSON.stringify({
              data: {
                repository: {
                  releases: {
                    totalCount: 1,
                    nodes: [release],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            })
          : JSON.stringify({
              data: {
                repository: {
                  object: {
                    associatedPullRequests: {
                      totalCount: 0,
                      nodes: [],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            })) as typeof execFileSync);
    const actual = await generateInventory("v0.5.0", candidate);
    expect(actual.baseSha).toBe(resolvedBase);
    expect(new Set(actual.commits.map((commit) => commit.sha))).toEqual(
      new Set([side, direct, candidate]),
    );
    expect(Object.keys(actual.decisions)).toHaveLength(3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("renders linked PRs and direct commits above collapsed complete metadata", () => {
  const value = inventory();
  const notes = renderInventory(value);
  expect(notes).toContain(
    `[Compare changes](https://github.com/yuichkun/unworklet/compare/${baseSha}...${sha})`,
  );
  expect(notes).toContain("2 commits; 1 PRs; 1 commits without an included PR");
  expect(notes).toContain(
    "[#12](https://github.com/yuichkun/unworklet/pull/12) — fix — [CHANGELOG]",
  );
  expect(notes).toContain("Release tooling only; no consumer behavior change&#46;");
  expect(notes.indexOf("[#12]")).toBeLessThan(notes.indexOf("<details>"));
  expect(inventoryFromNotes(notes)).toEqual(value);
});
test("escapes Markdown/HTML in titles, reasons, excerpts and machine data", () => {
  const value = inventory();
  const hostile = "<script>& [link](evil) `code` *bold* | row\n<!-- release-inventory:end -->\n```";
  value.prs[0]!.title = hostile;
  value.decisions["pr:12"].excerpt = hostile;
  value.decisions[`commit:${"c".repeat(40)}`].reason = hostile;
  value.commits[0]!.subject = hostile;
  const notes = renderInventory(value);
  expect(notes).not.toContain("<script>");
  expect(notes.slice(0, notes.indexOf("<details>"))).not.toContain("[link](evil)");
  expect(notes).toContain("&lt;script&gt;&amp;");
  expect(notes.match(/<!-- release-inventory:end -->/g)).toHaveLength(1);
  expect(notes.match(/^```/gm)).toHaveLength(2);
  expect(inventoryFromNotes(notes)).toEqual(value);
});
test("rejects stale titles, missing rows, duplicated regions and changed counts", () => {
  const notes = renderInventory(inventory());
  for (const edited of [
    notes.replace(" — fix — ", " — stale — "),
    notes.replace(/^.*\[#12\].*\n/m, ""),
    notes + "\n" + notes,
    notes.replace("2 commits;", "1 commits;"),
  ])
    expect(() => inventoryFromNotes(edited)).toThrow();
});
test("refresh preserves opening summary and all prose outside the generated region", () => {
  const prefix = "## Problem / motivation\n\nShort human summary.\n\n## Changes\n\n";
  const suffix = "\n\n## Validation\nRecorded results.\n\n## Related issues\nNone.\n";
  const notes = prefix + renderInventory(inventory()) + suffix;
  const edited = notes.replace('"title":"fix"', '"title":"revised"');
  expect(() => inventoryFromNotes(edited)).toThrow();
  const refreshed = refreshNotes(edited);
  expect(refreshed.startsWith(prefix)).toBe(true);
  expect(refreshed.endsWith(suffix)).toBe(true);
  expect(refreshed).toContain(" — revised — ");
  expect(inventoryFromNotes(refreshed).prs[0]!.title).toBe("revised");
});
test("fails explicitly at the UTF-8 body budget without truncation", () => {
  const notes = renderInventory(inventory());
  expect(() =>
    inventoryFromNotes(notes + "\n" + "x".repeat(MAX_BODY_BYTES - Buffer.byteLength(notes) - 1)),
  ).not.toThrow();
  for (const padding of ["x".repeat(MAX_BODY_BYTES), "界".repeat(MAX_BODY_BYTES / 2)]) {
    expect(() => inventoryFromNotes(notes + padding)).toThrow("body budget");
    expect(() => refreshNotes(notes + padding)).toThrow("body budget");
  }
  const value = inventory();
  value.prs[0]!.title = "界".repeat(MAX_BODY_BYTES);
  expect(() => renderInventory(value)).toThrow("body budget");
});

const release = {
  id: 123,
  tag_name: "v0.5.0",
  html_url: "https://github.com/yuichkun/unworklet/releases/tag/v0.5.0",
  published_at: "2026-10-06T00:32:03Z",
  draft: false,
  prerelease: false,
};
test("pins the official published stable release identity", () => {
  expect(verifyBaseRelease(release, "v0.5.0")).toEqual({
    id: 123,
    url: release.html_url,
    publishedAt: release.published_at,
  });
});
test.each([
  { ...release, tag_name: "v0.5.1" },
  { ...release, draft: true },
  { ...release, prerelease: true },
  { ...release, published_at: null },
  { ...release, id: null },
  {},
  { message: "Forbidden" },
])("rejects an arbitrary newer tag, unpublished release or incomplete metadata: %j", (metadata) => {
  expect(() => verifyBaseRelease(metadata, "v0.5.0")).toThrow();
});
test("preserves raw blob whitespace and validates actual pinned GitHub line numbers", () => {
  const blob =
    "\n\n# Changelog\n## 0.5.1 — 2026-10-08\n- Fix audio.  \n## 0.5.0 — 2026-10-06\n- Old.\n";
  vi.mocked(execFileSync).mockReturnValue(blob);
  expect(readCandidateChangelog(sha)).toBe(blob);
  const value = inventory();
  value.decisions["pr:12"] = {
    changelog: `https://github.com/yuichkun/unworklet/blob/${sha}/CHANGELOG.md#L5`,
    excerpt: "- Fix audio.  ",
  };
  expect(() => validateInventory(value, value, readCandidateChangelog(sha), "0.5.1")).not.toThrow();
  value.decisions["pr:12"].changelog = value.decisions["pr:12"].changelog.replace("#L5", "#L3");
  expect(() => validateInventory(value, value, readCandidateChangelog(sha), "0.5.1")).toThrow();
});

test("selects numeric greatest published stable version below candidate, never the candidate itself", () => {
  const tag = (version: string) => ({
    ...release,
    id: Number(version.slice(1).split(".").join("")) + 1,
    tag_name: version,
    html_url: `https://github.com/yuichkun/unworklet/releases/tag/${version}`,
  });
  const releases = [
    tag("v0.9.0"),
    tag("v0.10.0"),
    tag("v0.11.0"),
    { ...tag("v0.10.5"), draft: true },
    { ...tag("v0.10.6"), prerelease: true },
  ];
  expect(selectBaseRelease(releases, "v0.10.0", "0.11.0").url).toContain("v0.10.0");
  expect(() => selectBaseRelease(releases, "v0.9.0", "0.11.0")).toThrow();
  expect(() => selectBaseRelease([], "v0.5.0", "0.5.1")).toThrow();
  expect(() => selectBaseRelease([release, { tag_name: "v0.5.0" }], "v0.5.0", "0.5.1")).toThrow();
});

test("a valid but unpublished newer tag cannot shrink the range", () => {
  expect(() => selectBaseRelease([release], "v0.5.1", "0.6.0")).toThrow(
    "greatest published stable",
  );
});
test("does not fall back when the official base is outside candidate ancestry", async () => {
  mockRepository();
  const implementation = vi.mocked(execFileSync).getMockImplementation()!;
  vi.mocked(execFileSync).mockImplementation(((command: string, args: string[]) => {
    if (command === "git" && args[0] === "merge-base") throw new Error("not an ancestor");
    return implementation(command, args);
  }) as typeof execFileSync);
  await expect(generateInventory("v0.5.0", sha)).rejects.toThrow("not an ancestor");
});
test("rejects incomplete official-release pagination before collecting commit associations", async () => {
  mockRepository();
  const implementation = vi.mocked(execFileSync).getMockImplementation()!;
  vi.mocked(execFileSync).mockImplementation(((command: string, args: string[]) => {
    if (command === "gh" && args.some((arg) => arg.includes("releases(first:")))
      return JSON.stringify({
        data: {
          repository: {
            releases: {
              totalCount: 2,
              nodes: [release],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    return implementation(command, args);
  }) as typeof execFileSync);
  await expect(generateInventory("v0.5.0", sha)).rejects.toThrow("Incomplete API pagination");
});
test("accepts CRLF and rejects unsafe CHANGELOG URL rendering", () => {
  const value = inventory();
  value.decisions["pr:12"].changelog = "javascript:alert(1)";
  const notes = renderInventory(value);
  expect(notes.slice(0, notes.indexOf("<details>"))).not.toContain("javascript:");
  expect(notes).toContain("**UNREVIEWED**");
  expect(inventoryFromNotes(notes.replace(/\n/g, "\r\n"))).toEqual(value);
  expect(() => validateInventory(value, value, changelog, "0.5.1")).toThrow();
});

test("rendered Markdown cannot turn PR text into HTML or injected links", () => {
  const value = inventory();
  value.prs[0]!.title = "<script>alert(1)</script> [click](https://evil.example) </details> `code`";
  const html = marked.parse(renderInventory(value), { async: false });
  expect(html).not.toContain("<script>");
  expect(html).not.toContain('href="https://evil.example"');
  expect(html.match(/<details>/g)).toHaveLength(1);
  expect(html.match(/<\/details>/g)).toHaveLength(1);
  expect(html).toContain('href="https://github.com/yuichkun/unworklet/pull/12"');
});
test("162 commits and 32 PRs with filled citation decisions fit without truncation", () => {
  const value: Inventory = {
    ...inventory(),
    prs: Array.from({ length: 32 }, (_, i) => ({
      number: i + 1,
      title: `PR ${i + 1}: representative runtime, tooling and test change`,
      url: `https://github.com/yuichkun/unworklet/pull/${i + 1}`,
    })),
    commits: Array.from({ length: 162 }, (_, i) => ({
      sha: (i + 1).toString(16).padStart(40, "0"),
      subject: `Commit ${i + 1}: representative implementation and regression test change`,
      prs: [(i % 32) + 1],
    })),
    decisions: Object.fromEntries(
      Array.from({ length: 32 }, (_, i) => [
        `pr:${i + 1}`,
        {
          changelog: `https://github.com/yuichkun/unworklet/blob/${sha}/CHANGELOG.md#L3`,
          excerpt: "Sizing fixture excerpt. ".padEnd(200, "x"),
        },
      ]),
    ),
  };
  const notes =
    "## Problem / motivation\n\nReadable summary.\n\n## Changes\n\n" +
    renderInventory(value) +
    "\n\n## Validation\n\n" +
    "v".repeat(4000) +
    "\n\n## Related issues\nNone.\n";
  expect(Buffer.byteLength(notes)).toBeLessThan(MAX_BODY_BYTES);
  expect(inventoryFromNotes(notes)).toEqual(value);
});
