import { expect, test } from "vite-plus/test";

import { planRelease } from "./version.ts";
import type { ChangesetStatus } from "./version.ts";

const HEADER = `# Changelog

The five published packages are versioned in lockstep.
`;

const PREVIOUS = `## 0.3.0 — 2026-09-14

Earlier release notes.
`;

const PACKAGES = ["core", "lang", "offline", "test", "unplugin"];

function status(
  changesets: Array<{ id: string; summary: string; types: Record<string, string> }>,
  newVersion: string,
  oldVersion = "0.3.0",
): ChangesetStatus {
  return {
    changesets: changesets.map((c) => ({
      id: c.id,
      summary: c.summary,
      releases: Object.entries(c.types).map(([name, type]) => ({ name, type })),
    })),
    releases: [
      ...PACKAGES.map((p) => ({
        name: `@unworklet/${p}`,
        type: "patch",
        oldVersion,
        newVersion,
        changesets: [],
      })),
      {
        name: "@unworklet-examples/demo",
        type: "none",
        oldVersion: "0.0.0",
        newVersion: "0.0.0",
        changesets: [],
      },
    ],
  };
}

test("a patch-only release inserts a Changes section above the previous release", () => {
  const plan = planRelease(
    status(
      [
        {
          id: "a",
          summary: "**Faster renders.** Repeated renders reuse the compile.",
          types: { "@unworklet/offline": "patch" },
        },
        {
          id: "b",
          summary: "Fix a typo in an error message.",
          types: { "@unworklet/core": "patch" },
        },
      ],
      "0.3.1",
    ),
    { changelog: HEADER + "\n" + PREVIOUS, date: "2026-09-28" },
  );

  expect(plan.version).toBe("0.3.1");
  expect(plan.changelog).toBe(
    HEADER +
      "\n## 0.3.1 — 2026-09-28\n\n### Changes\n\n" +
      "**Faster renders.** Repeated renders reuse the compile.\n\n" +
      "Fix a typo in an error message.\n\n" +
      PREVIOUS,
  );
});

test("minor changesets are listed under Breaking, ahead of the other changes", () => {
  const plan = planRelease(
    status(
      [
        { id: "a", summary: "A fix.", types: { "@unworklet/core": "patch" } },
        {
          id: "b",
          summary: "**Exports are rejected.** Move them into a separate module.",
          types: { "@unworklet/lang": "minor", "@unworklet/core": "patch" },
        },
      ],
      "0.4.0",
    ),
    { changelog: HEADER + "\n" + PREVIOUS, date: "2026-10-01" },
  );

  expect(plan.version).toBe("0.4.0");
  expect(plan.changelog).toBe(
    HEADER +
      "\n## 0.4.0 — 2026-10-01\n\n### Breaking\n\n" +
      "**Exports are rejected.** Move them into a separate module.\n\n" +
      "### Changes\n\nA fix.\n\n" +
      PREVIOUS,
  );
});

test("a changelog with no earlier release gets the section appended after its header", () => {
  const plan = planRelease(
    status(
      [{ id: "a", summary: "First.", types: { "@unworklet/core": "patch" } }],
      "0.0.1",
      "0.0.0",
    ),
    { changelog: HEADER, date: "2026-09-28" },
  );

  expect(plan.changelog).toBe(HEADER + "\n## 0.0.1 — 2026-09-28\n\n### Changes\n\nFirst.\n");
});

test("release notes list each change by its first line and link to the changelog at the tag", () => {
  const plan = planRelease(
    status(
      [
        {
          id: "a",
          summary: "**Exports are rejected.**\n\nLonger explanation.\n\n```ts\ncode();\n```",
          types: { "@unworklet/lang": "minor" },
        },
        { id: "b", summary: "A fix.\n\nMore detail.", types: { "@unworklet/core": "patch" } },
      ],
      "0.4.0",
    ),
    { changelog: HEADER, date: "2026-10-01" },
  );

  expect(plan.notes).toBe(
    "### Breaking\n\n- **Exports are rejected.**\n\n" +
      "### Changes\n\n- A fix.\n\n" +
      "Full notes: [CHANGELOG.md at v0.4.0](https://github.com/yuichkun/unworklet/blob/v0.4.0/CHANGELOG.md)\n",
  );
});

test("a major changeset before 1.0 is refused, naming the changeset and the fix", () => {
  expect(() =>
    planRelease(
      status(
        [{ id: "bold-move", summary: "Big.", types: { "@unworklet/core": "major" } }],
        "1.0.0",
      ),
      { changelog: HEADER, date: "2026-09-28" },
    ),
  ).toThrow(/bold-move.*major.*minor/s);
});

test("a status with no package to release is refused", () => {
  const empty: ChangesetStatus = {
    changesets: [],
    releases: [
      {
        name: "@unworklet-examples/demo",
        type: "none",
        oldVersion: "0.0.0",
        newVersion: "0.0.0",
        changesets: [],
      },
    ],
  };

  expect(() => planRelease(empty, { changelog: HEADER, date: "2026-09-28" })).toThrow(
    /nothing to release/i,
  );
});

test("packages that would release under different versions are refused", () => {
  const split = status([{ id: "a", summary: "x", types: { "@unworklet/core": "patch" } }], "0.3.1");
  split.releases[1] = { ...split.releases[1]!, newVersion: "0.4.0" };

  expect(() => planRelease(split, { changelog: HEADER, date: "2026-09-28" })).toThrow(
    /0\.3\.1.*0\.4\.0/s,
  );
});
