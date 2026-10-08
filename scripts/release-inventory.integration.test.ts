import { expect, test } from "vite-plus/test";
import type { Inventory } from "./release-inventory.ts";
import { verifyPublishedInventory } from "./release-inventory.integration.ts";

const candidate = "0c4c889f4898197009cfc8879a1aedd1509246e2";
const firstMerge = "7f8dec1ab7f478c640f8e172a538f89e588b256a";
const gitCommits = [candidate, firstMerge];
function fixture(): Inventory {
  return {
    baseTag: "v0.4.1",
    baseSha: "fff85f19d2a24032a962479143ab3657fffb8e14",
    baseRelease: {
      id: 1,
      url: "https://github.com/yuichkun/unworklet/releases/tag/v0.4.1",
      publishedAt: "2026-01-01T00:00:00Z",
    },
    candidate,
    commits: [
      { sha: firstMerge, subject: "first", prs: [107] },
      { sha: candidate, subject: "release", prs: [130] },
    ],
    prs: [107, 130].map((number) => ({
      number,
      title: "public title",
      url: `https://github.com/yuichkun/unworklet/pull/${number}`,
    })),
    decisions: { "pr:107": {}, "pr:130": {} },
  };
}

test("compares the complete Git scope independently of traversal order", () => {
  expect(() => verifyPublishedInventory(fixture(), gitCommits)).not.toThrow();
});

test.each([
  ["missing commit", (value: Inventory) => value.commits.pop()],
  ["duplicate commit", (value: Inventory) => value.commits.push(value.commits[0]!)],
  [
    "extra commit",
    (value: Inventory) => value.commits.push({ sha: "a".repeat(40), subject: "extra", prs: [] }),
  ],
  [
    "wrong base",
    (value: Inventory) => {
      value.baseSha = "a".repeat(40);
    },
  ],
  [
    "wrong candidate",
    (value: Inventory) => {
      value.candidate = "a".repeat(40);
    },
  ],
  [
    "wrong tag",
    (value: Inventory) => {
      value.baseTag = "v0.4.0";
    },
  ],
  ["missing known PR", (value: Inventory) => value.prs.pop()],
  [
    "wrong PR URL",
    (value: Inventory) => {
      value.prs[0]!.url = "https://example.com/107";
    },
  ],
  [
    "missing merge association",
    (value: Inventory) => {
      value.commits[0]!.prs = [];
    },
  ],
] as const)("rejects %s", (_name, mutate) => {
  const value = fixture();
  mutate(value);
  expect(() => verifyPublishedInventory(value, gitCommits)).toThrow();
});
