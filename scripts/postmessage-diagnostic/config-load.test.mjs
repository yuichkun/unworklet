import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadConfigFromFile } from "vite-plus";

await test("runner and browser-server config evaluations share identity and the exclusive sink", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "uwk-config-test-"));
  const output = path.join(directory, "trace.json");
  const priorOutput = process.env.UWK_DIAG_OUTPUT;
  const priorExit = process.exitCode;
  process.env.UWK_DIAG_OUTPUT = output;
  try {
    const file = fileURLToPath(new URL("./vite.config.mts", import.meta.url));
    const load = async () =>
      (await loadConfigFromFile({ command: "serve", mode: "test" }, file)).config;
    const runner = await load();
    const reporter = runner.test.reporters[1];
    reporter.onInit();
    const firstManifest = readFileSync(output + ".manifest.json", "utf8");
    const browser = await load();
    assert.equal(readFileSync(output + ".manifest.json", "utf8"), firstManifest);
    assert.equal(runner.test.retry, 0);
    assert.equal(browser.test.testNamePattern, runner.test.testNamePattern);
    const runId = JSON.parse(firstManifest).runId;
    for (const [role, sourcePath] of [
      ["test", "src/__tests__/browser/postmessage/message-counter.test.ts"],
      ["client", "src/client.ts"],
      ["worklet", "src/worklet.ts"],
    ]) {
      const id = path.join(browser.root, sourcePath);
      const source = readFileSync(id, "utf8");
      const emitted = browser.plugins[0].transform(source, id).code;
      assert.ok(emitted.includes(`uwk-diag-${role}-v2:${runId}`));
      assert.equal(runner.plugins[0].transform(source, id).code, emitted);
      const record = JSON.parse(readFileSync(output + ".manifest.json", "utf8")).transforms[role];
      assert.equal(record.sourceHash, createHash("sha256").update(source).digest("hex"));
      assert.equal(record.transformedHash, createHash("sha256").update(emitted).digest("hex"));
      assert.equal(record.ambiguous, false);
    }
    browser.test.browser.commands.writePostmessageDiagnostic(null, { synthetic: true });
    assert.equal(JSON.parse(readFileSync(output, "utf8")).runId, runId);
    reporter.onTestModuleCollected({
      children: {
        allTests: function* () {
          yield {
            name: "message: send + worklet onReceive reflects state, observable on main thread",
          };
          yield { name: "unselected" };
        },
      },
    });
    reporter.onTestRunEnd([], [], "failed");
    const result = JSON.parse(readFileSync(output + ".runner.json", "utf8"));
    assert.equal(result.runId, runId);
    assert.equal(result.traceStatus, "incomplete");
    assert.equal(result.caseResult, null);
    assert.deepEqual(result.collection, { modules: 1, tests: 2, target: 1, results: 0 });
    const preserved = readFileSync(output, "utf8");
    await assert.rejects(load(), /finished/);
    assert.equal(readFileSync(output, "utf8"), preserved);
    assert.equal(existsSync(output + ".manifest.json.pending"), false);
  } finally {
    if (priorOutput === undefined) delete process.env.UWK_DIAG_OUTPUT;
    else process.env.UWK_DIAG_OUTPUT = priorOutput;
    process.exitCode = priorExit;
    rmSync(directory, { recursive: true });
  }
});
