import assert from "node:assert/strict";
import { test } from "node:test";
import { createRetention } from "./retention.mjs";

function fixture({ disposeError, exportError } = {}) {
  const writes = [];
  const warnings = [];
  let disposed = 0;
  const client = { marker: "uwk-diag-client-v2:unit-run", data: new Float64Array(128) };
  const run = createRetention({
    testMarker: "uwk-diag-test-v2:unit-run",
    readClient: () => client,
    write: async (artifact) => {
      writes.push(artifact);
      if (exportError) throw exportError;
    },
    report: (message) => warnings.push(message),
  });
  const node = {
    diagnostics: { transport: "postMessage" },
    dispose() {
      disposed++;
      if (disposeError) throw disposeError;
    },
  };
  return { run, node, client, writes, warnings, disposed: () => disposed };
}

await test("observation freezes the main trace before later asynchronous deliveries", async () => {
  const f = fixture();
  f.client.record = () => {};
  f.client.data[0] = 1;
  f.client.data[8] = 6;
  f.run.freezeObservation(42);
  await Promise.resolve();
  f.client.data[0] = 2;
  f.client.data[8] = 3;
  await f.run.finish(false);
  assert.equal(f.writes[0].main[0], 1);
  assert.equal(f.writes[0].main[8], 6);
  assert.equal(Object.isFrozen(f.writes[0].main), true);
});

for (const stage of ["create", "render", "raf", "assert"]) {
  await test(`retains available bounded data on ${stage} rejection`, async () => {
    const f = fixture();
    f.run.stage = stage;
    if (stage !== "create") f.run.adoptNode(f.node);
    const error = new Error(stage);
    await f.run.finish(true, error);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].stage, stage);
    assert.equal(f.writes[0].failures.primary.message, stage);
    assert.equal(f.writes[0].main.length, 128);
    assert.equal(f.writes[0].worklet, null);
    assert.equal(f.writes[0].markers.test, "uwk-diag-test-v2:unit-run");
    assert.equal(f.writes[0].markers.client, "uwk-diag-client-v2:unit-run");
  });
}

await test("dispose failure does not prevent export or replace primary error", async () => {
  const f = fixture({ disposeError: new Error("dispose") });
  f.run.adoptNode(f.node);
  await f.run.finish(true, new Error("assert"));
  assert.equal(f.writes[0].failures.primary.message, "assert");
  assert.equal(f.writes[0].failures.dispose.message, "dispose");
});

await test("export failure cannot replace primary failure, including thrown undefined", async () => {
  const f = fixture({ exportError: new Error("write") });
  await f.run.finish(true, undefined);
  assert.equal(f.writes[0].primaryFailed, true);
  assert.equal(f.warnings.length, 1);
});

await test("success path exposes export failure", async () => {
  const error = new Error("write");
  const f = fixture({ exportError: error });
  await assert.rejects(f.run.finish(false), (actual) => actual === error);
});

await test("cleanup failure remains primary over export failure after a passing assertion", async () => {
  const error = new Error("dispose");
  const f = fixture({ disposeError: error, exportError: new Error("write") });
  f.run.adoptNode(f.node);
  await assert.rejects(f.run.finish(false), (actual) => actual === error);
  assert.equal(f.writes.length, 1);
});

await test("runner-timeout fallback captures once and disposes a late-created node", async () => {
  const f = fixture();
  f.run.stage = "create";
  await f.run.finish(true, new Error("runner timeout"), "runner-failure");
  assert.equal(f.run.adoptNode(f.node), false);
  await f.run.finish(false);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].origin, "runner-failure");
  assert.equal(f.disposed(), 1);
});

await test("snapshot failure is recorded and does not stop cleanup or export", async () => {
  const f = fixture();
  f.run.adoptNode(f.node);
  f.run.rendered = {
    getChannelData() {
      throw new Error("snapshot");
    },
  };
  await f.run.finish(true, new Error("assert"));
  assert.equal(f.writes[0].failures.capture.message, "snapshot");
  assert.equal(f.disposed(), 1);
});

await test("error strings and externally supplied arrays are bounded", async () => {
  const writes = [];
  const run = createRetention({
    testMarker: "uwk-diag-test-v2:unit-run",
    readClient: () => ({ data: new Float64Array(4096), handshake: new Float32Array(4096) }),
    write: async (artifact) => writes.push(artifact),
    report() {},
  });
  await run.finish(true, new Error("x".repeat(100_000)));
  assert.equal(writes[0].main.length, 128);
  assert.equal(writes[0].workletHandshake.length, 128);
  assert.ok(JSON.stringify(writes[0]).length < 16_384);
});

await test("a failing warning sink cannot replace the original error", async () => {
  const run = createRetention({
    testMarker: "uwk-diag-test-v2:unit-run",
    readClient: () => null,
    write: async () => {
      throw new Error("write");
    },
    report() {
      throw new Error("console");
    },
  });
  await run.finish(true, new Error("primary"));
});

await test("pending export completes finitely, preserves primary identity and retains secondary timeout", async (t) => {
  const taskMeta = {};
  const primary = new Error("original assertion");
  const clear = globalThis.clearTimeout;
  const cleared = [];
  t.mock.method(globalThis, "clearTimeout", (id) => {
    cleared.push(id);
    return clear(id);
  });
  const run = createRetention({
    taskMeta,
    exportTimeoutMs: 5,
    testMarker: "uwk-diag-test-v2:unit-run",
    readClient: () => null,
    write: () => new Promise(() => {}),
    report() {},
  });
  const started = performance.now();
  const scenario = async () => {
    try {
      throw primary;
    } finally {
      await run.finish(true, primary);
    }
  };
  await assert.rejects(scenario(), (error) => error === primary);
  assert.ok(performance.now() - started < 500);
  assert.equal(taskMeta.uwkDiagnosticExportFailure.name, "DiagnosticExportTimeout");
  assert.equal(cleared.length, 1);
});

await test("pending export fails a successful scenario and clears its timer", async (t) => {
  const taskMeta = {};
  const clear = globalThis.clearTimeout;
  const cleared = [];
  t.mock.method(globalThis, "clearTimeout", (id) => {
    cleared.push(id);
    return clear(id);
  });
  const run = createRetention({
    taskMeta,
    exportTimeoutMs: 5,
    readClient: () => null,
    write: () => new Promise(() => {}),
    report() {},
  });
  await assert.rejects(run.finish(false), { name: "DiagnosticExportTimeout" });
  assert.equal(cleared.length, 1);
});

await test("successful export also clears its pending timeout", async (t) => {
  const clear = globalThis.clearTimeout;
  let cleared = 0;
  t.mock.method(globalThis, "clearTimeout", (id) => {
    cleared++;
    return clear(id);
  });
  const run = createRetention({ readClient: () => null, write: async () => {}, report() {} });
  await run.finish(false);
  assert.equal(cleared, 1);
});
