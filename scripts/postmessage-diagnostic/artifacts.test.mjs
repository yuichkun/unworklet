import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createArtifactSink } from "./artifacts.mjs";
import { decodeFile } from "./decode.mjs";

await test("manifest precedes trace, runner failure metadata remains bounded without a trace", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "uwk-artifact-test-"));
  try {
    const output = path.join(directory, "trace.json");
    const sink = createArtifactSink(output, { runId: "test-only" });
    sink.start();
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(output + ".manifest.json"), true);
    sink.finish({
      reason: "failed",
      errors: Array(100).fill(new Error("x".repeat(50_000))),
      secondaryExportFailure: {
        name: "DiagnosticExportTimeout",
        message: "Diagnostic export exceeded 100ms",
      },
    });
    const runner = JSON.parse(readFileSync(output + ".runner.json", "utf8"));
    assert.equal(runner.tracePresent, false);
    assert.equal(runner.traceStatus, "incomplete");
    assert.equal(runner.errors.length, 2);
    assert.equal(runner.secondaryExportFailure.name, "DiagnosticExportTimeout");
    assert.ok(readFileSync(output + ".runner.json").length <= 16_384);
    assert.throws(() => createArtifactSink(output, {}), /already exists/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

await test("exclusive trace writes reject oversized data and protect run identity", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "uwk-artifact-test-"));
  try {
    const output = path.join(directory, "trace.json");
    const sink = createArtifactSink(output, { runId: "real" });
    sink.start();
    assert.throws(() => sink.write({ data: "x".repeat(70_000) }), /capacity/);
    assert.equal(existsSync(output), false);
    sink.write({ runId: "wrong", marker: "synthetic" });
    assert.equal(JSON.parse(readFileSync(output, "utf8")).runId, "real");
    assert.throws(() => sink.write({}), /EEXIST/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

await test("output preflight rejects missing or relative paths before any scenario", () => {
  assert.throws(() => createArtifactSink(undefined, {}), /absolute/);
  assert.throws(() => createArtifactSink("trace.json", {}), /absolute/);
});

await test("missing file is incomplete; maximal escaped runner errors stay within capacity", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "uwk-artifact-test-"));
  try {
    const output = path.join(directory, "trace.json");
    assert.equal(decodeFile(output).status, "incomplete");
    const sink = createArtifactSink(output, {});
    sink.start();
    const error = { name: '"'.repeat(4096), message: '"'.repeat(4096), stack: '"'.repeat(4096) };
    sink.finish({
      reason: "failed",
      errors: [error, error],
      caseResult: { state: "failed", errors: [error] },
    });
    assert.ok(readFileSync(output + ".runner.json").length <= 16_384);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
