import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diagnosticPlugin, testPath } from "./instrument.mjs";
import { createArtifactSink } from "./artifacts.mjs";

await test("actual transform inputs/outputs and fresh IDs are recorded in the manifest", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "uwk-identity-test-"));
  try {
    const runId = randomUUID();
    const output = path.join(directory, "trace.json");
    const sink = createArtifactSink(output, { runId });
    const root = fileURLToPath(new URL("../../packages/core", import.meta.url));
    const plugin = diagnosticPlugin(root, true, runId, (record) => sink.recordTransform(record));
    sink.start();
    assert.deepEqual(JSON.parse(readFileSync(output + ".manifest.json")).transforms, {});
    for (const [role, file] of [
      ["test", testPath],
      ["client", "src/client.ts"],
      ["worklet", "src/worklet.ts"],
    ]) {
      const source = readFileSync(path.join(root, file), "utf8");
      const transformed = plugin.transform(source, path.join(root, file)).code;
      const hash = (text) => createHash("sha256").update(text).digest("hex");
      const record = JSON.parse(readFileSync(output + ".manifest.json")).transforms[role];
      assert.equal(record.runId, runId);
      assert.equal(record.sourcePath, file);
      assert.equal(record.sourceHash, hash(source));
      assert.equal(record.transformedHash, hash(transformed));
      assert.ok(transformed.includes(`uwk-diag-${role}-v2:${runId}`));
      const second = diagnosticPlugin(root, true, randomUUID(), () => {}).transform(
        source,
        path.join(root, file),
      ).code;
      assert.notEqual(hash(second), record.transformedHash);
    }
    assert.equal(
      Object.keys(JSON.parse(readFileSync(output + ".manifest.json")).transforms).length,
      3,
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

await test("conflicting transforms are retained as ambiguous rather than replacing evidence", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "uwk-identity-test-"));
  try {
    const output = path.join(directory, "trace.json");
    const sink = createArtifactSink(output, { runId: "unit-run" });
    sink.start();
    const record = {
      role: "client",
      runId: "unit-run",
      sourcePath: "src/client.ts",
      sourceHash: "a".repeat(64),
      transformedHash: "b".repeat(64),
    };
    sink.recordTransform(record);
    sink.recordTransform({ ...record, transformedHash: "c".repeat(64) });
    const stored = JSON.parse(readFileSync(output + ".manifest.json")).transforms.client;
    assert.equal(stored.ambiguous, true);
    assert.equal(stored.transformedHash, "b".repeat(64));
    assert.throws(() => sink.recordTransform({ ...record, role: "fourth" }), /role/);
    assert.throws(() => sink.recordTransform({ ...record, runId: "another" }), /run ID/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
