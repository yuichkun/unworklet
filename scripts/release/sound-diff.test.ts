import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { compareRenders, formatSoundReport } from "./sound-diff.ts";

type Entry = { slug: string; title: string; channels?: number[][]; error?: string };

function renders(entries: Entry[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "uwk-renders-"));
  const index = entries.map(({ slug, title, channels, error }) => {
    if (error !== undefined) return { slug, title, error };
    const files = (channels ?? []).map((samples, c) => {
      const file = `${slug}.main.${c}.f32`;
      writeFileSync(path.join(dir, file), Buffer.from(new Float32Array(samples).buffer));
      return file;
    });
    return { slug, title, outputs: { main: files } };
  });
  writeFileSync(path.join(dir, "index.json"), JSON.stringify(index));
  return dir;
}

test("examples that render the same samples are identical, others report how far they moved", () => {
  const before = renders([
    { slug: "distortion", title: "Distortion", channels: [[0.5, -0.5, 1]] },
    { slug: "reverb", title: "Feedback reverb", channels: [[0, 0.5, 0.25, 0.125]] },
  ]);
  const after = renders([
    { slug: "distortion", title: "Distortion", channels: [[0.5, -0.5, 1]] },
    { slug: "reverb", title: "Feedback reverb", channels: [[0, 0.5, 0.35, 0.125]] },
  ]);

  const rows = compareRenders(before, after);

  expect(rows).toEqual([
    { slug: "reverb", title: "Feedback reverb", status: "changed", peakDb: -20, rmsDb: -26 },
    { slug: "distortion", title: "Distortion", status: "identical" },
  ]);
});

test("added, removed and unrenderable examples are reported as such", () => {
  const before = renders([
    { slug: "old", title: "Old", channels: [[1]] },
    { slug: "arp", title: "Arpeggiator", error: "Unknown primitive: tanh" },
  ]);
  const after = renders([
    { slug: "arp", title: "Arpeggiator", channels: [[1]] },
    { slug: "new", title: "New", channels: [[1]] },
  ]);

  expect(compareRenders(before, after)).toEqual([
    {
      slug: "arp",
      title: "Arpeggiator",
      status: "unrenderable",
      detail: "before: Unknown primitive: tanh",
    },
    { slug: "new", title: "New", status: "new" },
    { slug: "old", title: "Old", status: "removed" },
  ]);
});

test("a different number of channels or samples counts as a change of shape", () => {
  const before = renders([{ slug: "eq3", title: "EQ", channels: [[1, 1]] }]);
  const after = renders([
    {
      slug: "eq3",
      title: "EQ",
      channels: [
        [1, 1],
        [1, 1],
      ],
    },
  ]);

  expect(compareRenders(before, after)).toEqual([
    { slug: "eq3", title: "EQ", status: "changed", detail: "the outputs have a different shape" },
  ]);
});

test("the report leads with how many examples changed and lists them first", () => {
  const report = formatSoundReport(
    [
      { slug: "reverb", title: "Feedback reverb", status: "changed", peakDb: -20, rmsDb: -26 },
      { slug: "new", title: "New", status: "new" },
      { slug: "distortion", title: "Distortion", status: "identical" },
    ],
    { before: "v0.3.0 (current release)", after: "v0.4.0 (candidate)" },
  );

  expect(report).toBe(
    "## How the examples sound: v0.3.0 (current release) → v0.4.0 (candidate)\n\n" +
      "2 of 3 examples need listening. The other 1 is identical sample for sample.\n\n" +
      "| Example | Result | Largest difference |\n" +
      "| --- | --- | --- |\n" +
      "| Feedback reverb (`reverb`) | **Changed** | peak −20.0 dBFS, RMS −26.0 dBFS |\n" +
      "| New (`new`) | **New** | — |\n" +
      "| Distortion (`distortion`) | Identical | — |\n",
  );
});

test("a report where nothing moved says so", () => {
  const report = formatSoundReport(
    [
      { slug: "distortion", title: "Distortion", status: "identical" },
      { slug: "reverb", title: "Feedback reverb", status: "identical" },
    ],
    { before: "main", after: "this pull request" },
  );

  expect(report).toBe(
    "## How the examples sound: main → this pull request\n\n" +
      "All 2 examples are identical sample for sample.\n\n" +
      "| Example | Result | Largest difference |\n" +
      "| --- | --- | --- |\n" +
      "| Distortion (`distortion`) | Identical | — |\n" +
      "| Feedback reverb (`reverb`) | Identical | — |\n",
  );
});
