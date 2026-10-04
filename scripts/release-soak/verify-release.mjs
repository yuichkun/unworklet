import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { validateReceipt } from "./integrity.mjs";

const [file, expectedRevision] = process.argv.slice(2);
assert.match(expectedRevision ?? "", /^[a-f0-9]{40}$/, "expected release SHA is required");
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  expectedRevision,
  "checkout differs from release SHA",
);
assert.equal(
  execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  }).trim(),
  "",
  "tracked checkout changed during soak",
);
const report = JSON.parse(readFileSync(file, "utf8"));
assert.equal(report.revision, expectedRevision, "soak ran on a different revision");
assert.equal(report.workingTree, "", "soak checkout was dirty");
assert.equal(
  report.requestedSecondsPerTransport,
  1800,
  "release requires the full 1800-second soak",
);
assert.equal(report.passed, true, "soak failed");
assert.deepEqual(
  report.results.map((result) => result.transport).sort(),
  ["postMessage", "sab"],
  "both transports must pass",
);

function numbers(record, keys) {
  for (const key of keys)
    assert.ok(
      typeof record[key] === "number" && Number.isFinite(record[key]) && record[key] >= 0,
      `invalid ${key}`,
    );
}
for (const result of report.results) {
  assert.equal(result.passed, true, `${result.transport} failed`);
  assert.deepEqual(result.failures, [], "soak reported failures or interruption");
  numbers(result, [
    "elapsedSeconds",
    "audioSeconds",
    "quanta",
    "hiddenSeconds",
    "visibleSeconds",
    "stalledIntervals",
    "sentMidiPairs",
  ]);
  numbers(result.transitions, ["hidden", "visible"]);
  numbers(result.published, ["count", "last", "reversed"]);
  numbers(result.errors, ["total"]);
  assert.equal(result.browserErrors.total, 0, "browser errors were reported");
  assert.deepEqual(Object.keys(result.streams).sort(), [
    "midi",
    "midiEcho",
    "scalar",
    "sysex",
    "sysexEcho",
    "typed",
  ]);
  for (const stream of Object.values(result.streams))
    numbers(stream, ["received", "first", "last", "gaps", "duplicates", "reversed", "corrupt"]);
  assert.deepEqual(Object.keys(result.overflow).sort(), [
    "midi",
    "midiEcho",
    "midiIn",
    "scalar",
    "typed",
  ]);
  numbers(result.overflow, Object.keys(result.overflow));
  assert.deepEqual(
    validateReceipt(result, result.transport, 1800),
    [],
    "soak integrity checks failed",
  );
  assert.equal(
    result.streams.midiEcho.received,
    result.sentMidiPairs,
    "MIDI round-trip incomplete",
  );
  assert.equal(
    result.streams.sysexEcho.received,
    result.sentMidiPairs,
    "SysEx round-trip incomplete",
  );
  assert.match(result.wasm.sha256, /^[a-f0-9]{64}$/, "missing WASM identity");
}
console.log(`Release soak verified for ${expectedRevision}: 1800 seconds per transport.`);
