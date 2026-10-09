import path from "node:path";
import { createHash } from "node:crypto";

export const title = "message: send + worklet onReceive reflects state, observable on main thread";
export const testPath = "src/__tests__/browser/postmessage/message-counter.test.ts";

function once(source, needle, replacement) {
  if (source.split(needle).length !== 2) throw new Error(`Diagnostic anchor mismatch: ${needle}`);
  return source.replace(needle, replacement);
}

function mark(source, runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(runId))
    throw new Error("Invalid diagnostic run ID");
  return source.replace(/uwk-diag-(test|client|worklet)-v2/g, (marker) => `${marker}:${runId}`);
}

export function instrumentWorklet(source, record = true, runId = "preflight") {
  const prelude = `
const __diagTrace = new Float32Array(128);
__diagTrace[0] = 54124;
let __diagState: Float32Array;
let __diagInjected = false;
function __diagRecord(code: number, value = 0, version = 0, a = 0, b = 0, c = 0, d = 0) {
  if (!${record}) return;
  const n = __diagTrace[1];
  if (n >= 15) { __diagTrace[2]++; return; }
  const p = 8 + n * 8;
  __diagTrace[p] = code;
  __diagTrace[p + 1] = (globalThis as unknown as { currentFrame: number }).currentFrame;
  __diagTrace[p + 2] = value;
  __diagTrace[p + 3] = version;
  __diagTrace[p + 4] = a;
  __diagTrace[p + 5] = b;
  __diagTrace[p + 6] = c;
  __diagTrace[p + 7] = d;
  __diagTrace[1] = n + 1;
}
`;
  source = once(
    source,
    "const publishBuffer = opts.processorOptions?.publishBuffer ?? null;",
    '__diagState = new Float32Array(memory.buffer, lay.regions.states.slots["counter"]!, 1);\n      const publishBuffer = opts.processorOptions?.publishBuffer ?? null;',
  );
  source = once(
    source,
    'self.port.postMessage({ kind: "ready" });',
    '__diagRecord(1);\n      self.port.postMessage({ kind: "ready", diagMarker: "uwk-diag-worklet-v2", diagTrace: __diagTrace });',
  );
  source = once(
    source,
    'kind: "init-error",',
    'kind: "init-error",\n        diagMarker: "uwk-diag-worklet-v2", diagTrace: __diagTrace,',
  );
  const compactStart = 'if (typeof port.start === "function") port.start();';
  if (source.includes(compactStart)) {
    source = once(
      source,
      compactStart,
      '__diagRecord(2);\n        if (typeof port.start === "function") { port.start(); __diagRecord(3); }',
    );
  } else {
    source = once(
      source,
      'if (typeof port.start === "function") {\n          port.start();\n        }',
      '__diagRecord(2);\n        if (typeof port.start === "function") { port.start(); __diagRecord(3); }',
    );
  }
  source = once(
    source,
    "queue.push(data.payload as Record<string, unknown>);",
    "queue.push(data.payload as Record<string, unknown>);\n            __diagRecord(4, Number((data.payload as { value: number }).value), 0, ringIndex, queue.length);",
  );
  source = once(
    source,
    "wasmH[0] = head + 1;\n          }\n          queue.length = 0;\n        }\n      }\n    }\n\n    if (state.midiRings.length > 0)",
    "wasmH[0] = head + 1;\n            __diagRecord(5, Number(payload.value), 0, i, wasmH[0]!, wasmH[1]!);\n            __diagInjected = true;\n          }\n          queue.length = 0;\n        }\n      }\n    }\n\n    if (state.midiRings.length > 0)",
  );
  source = once(
    source,
    "state.process();",
    "state.process();\n      __diagTrace[3]++;\n      if (__diagInjected) {\n        __diagRecord(6, __diagState[0], 0, state.messageRingsWasmHeaderViews[0]![0]!, state.messageRingsWasmHeaderViews[0]![1]!);\n        __diagInjected = false;\n      }",
  );
  source = once(
    source,
    "version: currentVersion,\n          });",
    "version: currentVersion,\n          });\n          __diagRecord(7, __diagState[0], currentVersion, sampleCounter, valueBits & 65535, valueBits >>> 16, i);",
  );
  source = once(
    source,
    "    return true;\n  };\n\n  return {\n    initialize,",
    `    if ((globalThis as unknown as { currentFrame: number }).currentFrame === 3968) {
      __diagRecord(8, __diagState[0], state.lastVersions[0], state.messageQueueMirrors[0]!.length,
        state.messageRingsWasmHeaderViews[0]![0]!, state.messageRingsWasmHeaderViews[0]![1]!);
      outputs[0]![0]!.set(__diagTrace);
    }
    return true;
  };

  return {
    initialize,`,
  );
  return mark(prelude + source, runId);
}

export function instrumentClient(source, record = true, runId = "preflight") {
  const prelude = `
const __diagMain = new Float64Array(128);
function __diagMainRecord(code: number, value = 0, version = 0, a = 0) {
  if (!${record}) return;
  const n = __diagMain[0];
  if (n >= 24) { __diagMain[1]++; return; }
  const p = 8 + n * 5;
  __diagMain[p] = code;
  __diagMain[p + 1] = value;
  __diagMain[p + 2] = version;
  __diagMain[p + 3] = a;
  __diagMain[p + 4] = n;
  __diagMain[0] = n + 1;
}
const __diagClient = {
  marker: "uwk-diag-client-v2", data: __diagMain, record: __diagMainRecord,
  workletMarker: null as string | null, handshake: new Float32Array(128),
};
function __diagHandshake(data: any) {
  if (data.diagMarker === "uwk-diag-worklet-v2" && data.diagTrace instanceof Float32Array && data.diagTrace.length === 128) {
    __diagClient.workletMarker = data.diagMarker;
    __diagClient.handshake.set(data.diagTrace);
  }
}
(globalThis as any).__uwkDiagnostic = __diagClient;
`;
  source = once(
    source,
    'if (data.kind === "ready") {',
    'if (data.kind === "ready") {\n        __diagHandshake(event.data);\n        __diagMainRecord(1);',
  );
  source = once(
    source,
    'if (data.kind === "init-error") {',
    'if (data.kind === "init-error") {\n        __diagHandshake(event.data);',
  );
  source = once(
    source,
    'node.port.postMessage({ kind: "message", ringIndex, payload });',
    '__diagMainRecord(2, Number((payload as { value: number }).value), 0, ringIndex);\n          node.port.postMessage({ kind: "message", ringIndex, payload });',
  );
  source = once(
    source,
    "postMessageMirrorBits[slotIndex] = data.valueBits;",
    "__diagMainRecord(3, data.valueBits, data.version, slotIndex);\n    postMessageMirrorBits[slotIndex] = data.valueBits;",
  );
  source = once(
    source,
    "postMessageMirrorVersions[slotIndex] = data.version;",
    "postMessageMirrorVersions[slotIndex] = data.version;\n    __diagMainRecord(4, postMessageMirrorBits[slotIndex], postMessageMirrorVersions[slotIndex], slotIndex);",
  );
  return mark(prelude + source, runId);
}

export function instrumentTest(source, runId = "preflight") {
  const start = source.indexOf(`test("${title}",`);
  if (start < 0) throw new Error("Missing target scenario");
  const end = source.indexOf("\n});", start) + 4;
  let scenario = source.slice(start, end);
  scenario = once(
    scenario,
    `test("${title}", async () => {`,
    `test("${title}", async ({ task: __diagTask }) => {`,
  );
  scenario = once(
    scenario,
    "  const ctx = buildContext(32);",
    `  const __diagRun = __diagCreateRetention({
    testMarker: "uwk-diag-test-v2",
    taskMeta: __diagTask.meta,
    readClient: () => (globalThis as any).__uwkDiagnostic,
    write: (artifact: unknown) => __diagCommands.writePostmessageDiagnostic(artifact),
    report: (message: string) => console.error(message),
  });
  let __diagFailed = false;
  let __diagError: unknown;
  __diagOnFailed(async ({ errors }) => {
    await __diagRun.finish(true, errors?.[0], "runner-failure");
  });
  try {
  __diagRun.stage = "create";
  const ctx = buildContext(32);
  __diagRun.context = ctx;`,
  );
  scenario = once(
    scenario,
    "  const node = await createNode(ctx, messageCounter);",
    "  const node = await createNode(ctx, messageCounter);\n  if (!__diagRun.adoptNode(node)) return;\n  (globalThis as any).__uwkDiagnostic?.record(7);",
  );
  scenario = once(
    scenario,
    "  await ctx.startRendering();",
    '  __diagRun.stage = "render";\n  const __diagRendered = await ctx.startRendering();\n  if (__diagRun.closed) return;\n  __diagRun.rendered = __diagRendered;\n  (globalThis as any).__uwkDiagnostic?.record(5);',
  );
  scenario = once(
    scenario,
    "  await waitRAF(2);",
    '  __diagRun.stage = "raf";\n  await waitRAF(2);\n  if (__diagRun.closed) return;',
  );
  scenario = once(
    scenario,
    "  expect(observed).toBe(42);\n  node.dispose();",
    `  __diagRun.freezeObservation(observed);
  __diagRun.stage = "assert";
    expect(observed).toBe(42);
  } catch (error) {
    __diagFailed = true;
    __diagError = error;
    throw error;
  } finally {
    await __diagRun.finish(__diagFailed, __diagError);
  }`,
  );
  return mark(
    'import { commands as __diagCommands } from "vite-plus/test/browser";\n' +
      'import { onTestFailed as __diagOnFailed } from "vite-plus/test";\n' +
      'import { createRetention as __diagCreateRetention } from "../../../../../../scripts/postmessage-diagnostic/retention.mjs";\n' +
      source.slice(0, start) +
      scenario +
      source.slice(end),
    runId,
  );
}

export function diagnosticPlugin(coreRoot, record, runId, recordTransform) {
  const handlers = new Map(
    [
      ["worklet", "src/worklet.ts", (s) => instrumentWorklet(s, record, runId)],
      ["client", "src/client.ts", (s) => instrumentClient(s, record, runId)],
      ["test", testPath, (s) => instrumentTest(s, runId)],
    ].map(([role, sourcePath, transform]) => [
      path.join(coreRoot, sourcePath),
      { role, sourcePath, transform },
    ]),
  );
  const hash = (source) => createHash("sha256").update(source).digest("hex");
  return {
    name: "single-postmessage-diagnostic",
    enforce: "pre",
    transform(source, id) {
      const handler = handlers.get(id.split("?")[0]);
      if (handler) {
        const code = handler.transform(source);
        recordTransform({
          role: handler.role,
          runId,
          sourcePath: handler.sourcePath,
          sourceHash: hash(source),
          transformedHash: hash(code),
        });
        return { code, map: null };
      }
    },
  };
}
