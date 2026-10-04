import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { expect, test } from "vite-plus/test";

const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const receipt = (transport: string) => ({
  transport,
  passed: true,
  failures: [],
  sampleRate: 48000,
  elapsedSeconds: 1801,
  audioSeconds: 1800,
  quanta: 675000,
  hiddenSeconds: 900,
  visibleSeconds: 901,
  transitions: { hidden: 15, visible: 15 },
  errors: { total: 0 },
  browserErrors: { total: 0 },
  published: { count: 7000, last: 675000, reversed: 0 },
  stalledIntervals: 0,
  sentMidiPairs: 7200,
  streams: Object.fromEntries(
    ["scalar", "typed", "midi", "sysex", "midiEcho", "sysexEcho"].map((name) => [
      name,
      {
        received: name.endsWith("Echo") ? 7200 : 10546,
        first: 1,
        last: 10546,
        gaps: 0,
        duplicates: 0,
        reversed: 0,
        corrupt: 0,
      },
    ]),
  ),
  overflow: { scalar: 0, typed: 0, midi: 0, midiIn: 0, midiEcho: 0 },
  wasm: { sha256: "a".repeat(64) },
});
const report = () => ({
  revision,
  workingTree: "",
  requestedSecondsPerTransport: 1800,
  passed: true,
  results: [receipt("sab"), receipt("postMessage")],
});
function verify(
  value: unknown,
  expected = revision,
  options: { dirty?: boolean; raw?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "release-soak-gate-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(dir, "tracked"), "clean");
    git("add", "tracked");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    const fixtureRevision = git("rev-parse", "HEAD").trim();
    if (value && typeof value === "object" && "revision" in value && value.revision === revision)
      value = { ...value, revision: fixtureRevision };
    if (expected === revision) expected = fixtureRevision;
    const file = join(dir, "summary.json");
    writeFileSync(file, options.raw ?? JSON.stringify(value));
    if (options.dirty) writeFileSync(join(dir, "tracked"), "changed");
    return spawnSync(
      process.execPath,
      [new URL("release-soak/verify-release.mjs", import.meta.url).pathname, file, expected],
      { encoding: "utf8", cwd: dir },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test("accepts a complete long soak from the exact clean release checkout", () => {
  const result = verify(report());
  expect(result.status, result.stderr).toBe(0);
});
const invalidReports: [string, unknown][] = [
  ["short requested duration", { ...report(), requestedSecondsPerTransport: 120 }],
  ["failed summary", { ...report(), passed: false }],
  ["dirty recorded source", { ...report(), workingTree: " M packages/core/src/client.ts" }],
  ["wrong report revision", { ...report(), revision: "b".repeat(40) }],
  ["missing transport", { ...report(), results: [receipt("sab")] }],
  ["duplicate transport", { ...report(), results: [receipt("sab"), receipt("sab")] }],
];
for (const [label, delta] of Object.entries({
  "short wall time": { elapsedSeconds: 1799 },
  "short audio time": { audioSeconds: 120 },
  "non-finite time": { elapsedSeconds: null },
  "failed transport": { passed: false },
  interruption: { failures: ["run interrupted"] },
  "insufficient progress": { quanta: 1 },
  "no hidden time": { hiddenSeconds: 0 },
  "worklet error": { errors: { total: 1 } },
  "browser error": { browserErrors: { total: 1 } },
  stall: { stalledIntervals: 1 },
  "missing streams": { streams: {} },
  "missing overflow diagnostics": { overflow: {} },
  "missing WASM identity": { wasm: null },
  "incomplete MIDI round-trip": { sentMidiPairs: 7201 },
}))
  invalidReports.push([
    label,
    { ...report(), results: [{ ...receipt("sab"), ...delta }, receipt("postMessage")] },
  ]);
test.each(invalidReports)("rejects %s evidence", (_label, value) => {
  expect(verify(value).status).not.toBe(0);
});
test("rejects a different release checkout", () => {
  expect(verify(report(), "b".repeat(40)).status).not.toBe(0);
});
test("rejects corrupt streams even if a report claims success", () => {
  for (const field of ["gaps", "duplicates", "reversed", "corrupt"]) {
    const value = report();
    Object.assign(value.results[0]!.streams.scalar!, { [field]: 1 });
    expect(verify(value).status).not.toBe(0);
  }
});
test("missing or malformed evidence cannot pass", () => {
  expect(verify(report(), revision, { raw: "{" }).status).not.toBe(0);
  expect(verify(report(), revision, { dirty: true }).status).not.toBe(0);
  for (const value of [null, {}, { passed: true }]) expect(verify(value).status).not.toBe(0);
  const result = spawnSync(process.execPath, [
    new URL("release-soak/verify-release.mjs", import.meta.url).pathname,
    "/nonexistent/summary.json",
    revision,
  ]);
  expect(result.status).not.toBe(0);
});
test("release gates publication on a bounded long soak and uploads reports on failure", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const ordered = [
    "scripts/release-check.ts",
    "run: vp run build",
    "scripts/release-soak/run.mjs --seconds 1800",
    "scripts/release-soak/verify-release.mjs",
    "Upload release soak reports",
    "Check that npm lets",
    "Tag the release",
    "Publish to npm",
    "Create the GitHub Release",
    "Move the production",
  ];
  for (let i = 0; i < ordered.length; i++) {
    expect(workflow.indexOf(ordered[i]!)).toBeGreaterThan(
      i ? workflow.indexOf(ordered[i - 1]!) : -1,
    );
  }
  expect(workflow).toContain("ref: ${{ github.sha }}");
  expect(workflow).toContain("timeout --signal=TERM --kill-after=15s 35m");
  expect(workflow).toContain("timeout-minutes: 36");
  expect(workflow).toContain("timeout-minutes: 90");
  expect(workflow).toContain("if: always()");
  expect(workflow).toContain("name: release-soak-report");
  expect(workflow).not.toContain("continue-on-error");
  expect(workflow.slice(workflow.indexOf("Tag the release"))).not.toContain("if:");
  expect(workflow).toContain("github.event.pull_request.merged");
  expect(workflow).toContain("fetch-depth: 0");
  expect(workflow).toContain("release-soak-${{ github.run_id }}-${{ github.run_attempt }}");
  expect(workflow).toContain("contents: write");
  expect(workflow).toContain("id-token: write");
  expect(workflow).toContain("runs-on: ubuntu-22.04");
});
