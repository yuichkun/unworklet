import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { createRetention } from "./retention.mjs";
import { instrumentTest, title } from "./instrument.mjs";

const requireCore = createRequire(new URL("../../packages/core/package.json", import.meta.url));
const ts = requireCore("typescript");
const source = readFileSync(
  new URL(
    "../../packages/core/src/__tests__/browser/postmessage/message-counter.test.ts",
    import.meta.url,
  ),
  "utf8",
);
const emitted = ts.transpileModule(instrumentTest(source, "unit-run"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

for (const failureStage of [null, "create", "render", "raf", "assert", "dispose"]) {
  await test(`synthetic wrapper preserves ordering and primary identity: ${failureStage}`, async () => {
    const primary = new Error(String(failureStage));
    const saveError = new Error("export");
    const order = [];
    const artifacts = [];
    let callback;
    let failedHook;
    const fail = (stage) => {
      if (stage === failureStage) throw primary;
    };
    const client = {
      marker: "uwk-diag-client-v2:unit-run",
      data: new Float64Array(128),
      record() {},
    };
    const node = {
      outputs: { main: { connect() {} } },
      events: {
        setCount: {
          emit(payload) {
            order.push("send");
            assert.equal(payload.value, 42);
          },
        },
      },
      state: { counter: { value: failureStage === "assert" ? 0 : 42 } },
      diagnostics: { transport: "postMessage" },
      dispose() {
        order.push("dispose");
        fail("dispose");
      },
    };
    const scope = {
      exports: {},
      console: { error() {} },
      __uwkDiagnostic: client,
      OfflineAudioContext: class {
        constructor(options) {
          assert.equal(options.length, 4096);
          assert.equal(options.sampleRate, 48000);
        }
        async startRendering() {
          order.push("render");
          fail("render");
          return { length: 4096, getChannelData: () => new Float32Array(4096) };
        }
      },
      requestAnimationFrame(fn) {
        order.push("raf");
        fail("raf");
        queueMicrotask(fn);
      },
      require(id) {
        if (id === "vite-plus/test")
          return {
            test(name, fn) {
              if (name === title) callback = fn;
            },
            onTestFailed(fn) {
              failedHook = fn;
            },
            expect(value) {
              return {
                toBe(expected) {
                  order.push("assert");
                  assert.equal(expected, 42);
                  fail("assert");
                  assert.equal(value, 42);
                },
              };
            },
          };
        if (id === "vite-plus/test/browser")
          return {
            commands: {
              async writePostmessageDiagnostic(artifact) {
                order.push("export");
                artifacts.push(artifact);
                if (failureStage) throw saveError;
              },
            },
          };
        if (id.endsWith("retention.mjs")) return { createRetention };
        if (id === "../../../index.ts")
          return {
            async createNode() {
              order.push("create");
              fail("create");
              return node;
            },
          };
        if (id.includes("message-counter.processor")) return { default: {} };
        throw new Error(`Unexpected import ${id}`);
      },
    };
    vm.runInNewContext(emitted, scope);
    if (failureStage) {
      await assert.rejects(callback({ task: { meta: {} } }), (error) => error === primary);
      await failedHook({ errors: [primary] });
    } else {
      await callback({ task: { meta: {} } });
      assert.deepEqual(order, [
        "create",
        "send",
        "render",
        "raf",
        "raf",
        "assert",
        "dispose",
        "export",
      ]);
    }
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].markers.test, "uwk-diag-test-v2:unit-run");
    assert.equal(artifacts[0].markers.client, "uwk-diag-client-v2:unit-run");
  });
}
