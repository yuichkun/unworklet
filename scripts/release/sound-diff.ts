/**
 * Compares two directories written by the demo's render-examples.ts and
 * reports which examples sound different. Renders are reproducible, so
 * "identical" means sample for sample, and the examples that moved are the ones
 * worth listening to.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type IndexEntry = {
  slug: string;
  title: string;
  outputs?: Record<string, string[]>;
  error?: string;
};

export type SoundDiffRow = {
  slug: string;
  title: string;
  status: "identical" | "changed" | "new" | "removed" | "unrenderable";
  peakDb?: number;
  rmsDb?: number;
  detail?: string;
};

const readIndex = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8")) as IndexEntry[];

function readChannels(dir: string, entry: IndexEntry): Float32Array[] {
  return Object.keys(entry.outputs!)
    .sort()
    .flatMap((name) =>
      entry.outputs![name]!.map((file) => {
        const bytes = readFileSync(path.join(dir, file));
        return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
      }),
    );
}

const decibels = (amplitude: number) => Math.round(20 * Math.log10(amplitude) * 10) / 10;

function compareEntry(
  before: string,
  after: string,
  was: IndexEntry,
  now: IndexEntry,
): SoundDiffRow {
  const row = { slug: now.slug, title: now.title };
  if (was.error !== undefined || now.error !== undefined) {
    const detail = [
      was.error !== undefined ? `before: ${was.error}` : undefined,
      now.error !== undefined ? `after: ${now.error}` : undefined,
    ]
      .filter(Boolean)
      .join("; ");
    return { ...row, status: "unrenderable", detail };
  }

  const a = readChannels(before, was);
  const b = readChannels(after, now);
  if (a.length !== b.length || a.some((channel, c) => channel.length !== b[c]!.length)) {
    return { ...row, status: "changed", detail: "the outputs have a different shape" };
  }

  let peak = 0;
  let squares = 0;
  let count = 0;
  for (let c = 0; c < a.length; c++) {
    for (let i = 0; i < a[c]!.length; i++) {
      const d = Math.abs(a[c]![i]! - b[c]![i]!);
      if (d > peak) peak = d;
      squares += d * d;
      count++;
    }
  }
  if (peak === 0) return { ...row, status: "identical" };
  return {
    ...row,
    status: "changed",
    peakDb: decibels(peak),
    rmsDb: decibels(Math.sqrt(squares / count)),
  };
}

export function compareRenders(before: string, after: string): SoundDiffRow[] {
  const was = new Map(readIndex(before).map((e) => [e.slug, e]));
  const now = readIndex(after);
  const rows: SoundDiffRow[] = now.map((entry) => {
    const previous = was.get(entry.slug);
    return previous
      ? compareEntry(before, after, previous, entry)
      : { slug: entry.slug, title: entry.title, status: "new" };
  });
  const present = new Set(now.map((e) => e.slug));
  for (const entry of was.values()) {
    if (!present.has(entry.slug))
      rows.push({ slug: entry.slug, title: entry.title, status: "removed" });
  }
  return [
    ...rows.filter((r) => r.status !== "identical"),
    ...rows.filter((r) => r.status === "identical"),
  ];
}

const RESULT: Record<SoundDiffRow["status"], string> = {
  identical: "Identical",
  changed: "**Changed**",
  new: "**New**",
  removed: "**Removed**",
  unrenderable: "**Could not render**",
};

const dbfs = (value: number) => `${value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)} dBFS`;

export function formatSoundReport(
  rows: SoundDiffRow[],
  labels: { before: string; after: string },
): string {
  const moved = rows.filter((r) => r.status !== "identical").length;
  const same = rows.length - moved;
  const summary =
    moved === 0
      ? `All ${rows.length} examples are identical sample for sample.`
      : `${moved} of ${rows.length} examples need listening.` +
        (same === 0
          ? ""
          : ` The other ${same} ${same === 1 ? "is" : "are"} identical sample for sample.`);

  const table = rows.map((r) => {
    const difference =
      r.peakDb !== undefined ? `peak ${dbfs(r.peakDb)}, RMS ${dbfs(r.rmsDb!)}` : (r.detail ?? "—");
    return `| ${r.title} (\`${r.slug}\`) | ${RESULT[r.status]} | ${difference} |`;
  });

  return [
    `## How the examples sound: ${labels.before} → ${labels.after}`,
    "",
    summary,
    "",
    "| Example | Result | Largest difference |",
    "| --- | --- | --- |",
    ...table,
    "",
  ].join("\n");
}

/**
 * `sound-diff.ts <before dir> <after dir> <before label> <after label> [report file]`:
 * writes the report to the job summary, and to the report file when given.
 */
function main(): void {
  const [before, after, beforeLabel, afterLabel, reportFile] = process.argv.slice(2);
  const rows = compareRenders(path.resolve(before!), path.resolve(after!));
  const report = formatSoundReport(rows, { before: beforeLabel!, after: afterLabel! });
  console.log(report);
  if (reportFile) writeFileSync(reportFile, report);
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) appendFileSync(stepSummary, report + "\n");
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    const moved = rows.filter((r) => r.status !== "identical").length;
    appendFileSync(output, `moved=${moved}\n`);
  }
}

if (import.meta.main) main();
