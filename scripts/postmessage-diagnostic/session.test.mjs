import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDiagnosticSession } from "./session.mjs";

await test("active session requires identical settings and finished sessions cannot be reattached", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "uwk-session-test-"));
  try {
    const output = path.join(directory, "trace.json");
    const settings = { recording: true, hashes: { config: "a" } };
    const session = getDiagnosticSession(output, settings);
    session.sink.start();
    const manifest = readFileSync(output + ".manifest.json", "utf8");
    const separatelyEvaluated = await import(`./session.mjs?test=${session.runId}`);
    assert.equal(separatelyEvaluated.getDiagnosticSession(output, settings), session);
    assert.throws(
      () => getDiagnosticSession(output, { ...settings, recording: false }),
      /identity/,
    );
    assert.throws(() => getDiagnosticSession(output, { ...settings, hashes: {} }), /identity/);
    assert.throws(() => session.sink.start(), /EEXIST/);
    assert.equal(readFileSync(output + ".manifest.json", "utf8"), manifest);
    const separateProcess = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { getDiagnosticSession } from ${JSON.stringify(new URL("./session.mjs", import.meta.url).href)};
       getDiagnosticSession(process.argv[1], JSON.parse(process.argv[2]));`,
        output,
        JSON.stringify(settings),
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(separateProcess.status, 0);
    assert.match(separateProcess.stderr, /already exists/);
    session.sink.finish({ reason: "unit-only" });
    assert.throws(() => getDiagnosticSession(output, settings), /finished/);
    assert.throws(() => session.sink.write({}), /finished/);
    assert.throws(() => session.sink.recordTransform({}), /finished/);
    assert.throws(() => session.sink.finish({ reason: "again" }), /finished/);
    assert.equal(readFileSync(output + ".manifest.json", "utf8"), manifest);
    const fresh = getDiagnosticSession(path.join(directory, "fresh.json"), settings);
    assert.notEqual(fresh.runId, session.runId);
    fresh.sink.start();
    fresh.sink.finish({ reason: "unit-only" });
  } finally {
    rmSync(directory, { recursive: true });
  }
});

await test("disk artifacts are never adopted, and competing owners retain exclusive creation", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "uwk-session-test-"));
  try {
    for (const suffix of ["", ".manifest.json", ".runner.json", ".manifest.json.pending"]) {
      const output = path.join(directory, `trace-${suffix.length}.json`);
      writeFileSync(output + suffix, "retained evidence", { flag: "wx" });
      assert.throws(() => getDiagnosticSession(output, {}), /already exists/);
      assert.equal(readFileSync(output + suffix, "utf8"), "retained evidence");
    }
    const output = path.join(directory, "race.json");
    const session = getDiagnosticSession(output, {});
    assert.throws(() => session.sink.recordTransform({}), /not started/);
    assert.throws(() => session.sink.write({}), /not started/);
    assert.throws(() => session.sink.finish({ reason: "premature" }), /not started/);
    writeFileSync(output + ".manifest.json", "another owner", { flag: "wx" });
    assert.throws(() => session.sink.start(), /EEXIST/);
    assert.throws(() => session.sink.write({}), /not started/);
    assert.equal(readFileSync(output + ".manifest.json", "utf8"), "another owner");
  } finally {
    rmSync(directory, { recursive: true });
  }
});
