/**
 * Behavioral tests for `emitWorkletModuleSource(...)` — the single source-string
 * emitter for an `addModule()`'d worklet entry, shared by the build-time
 * `?worklet` path (vite-plugin, `import` runtime) and the runtime in-browser
 * compile path (`@unworklet/lang/browser`, `inline` runtime — Safari can't
 * resolve imports inside a Blob module).
 */

import {
  audioOutput,
  compile,
  defineProcessor,
  extractWorkletMeta,
  forSample,
  i64,
  state,
} from "./index.ts";
import { emitWorkletModuleSource } from "./worklet-module.ts";
import { expect, test } from "vite-plus/test";

const META_FIXTURE = {
  layout: {
    regions: {
      ioScratch: { inputs: { main: 0 }, outputs: { main: 1024 }, params: { gain: 2048 } },
    },
  },
  audioInputs: [{ kind: "audioInput", name: "main", channels: 2 }],
  audioOutputs: [{ kind: "audioOutput", name: "main", channels: 2 }],
  params: [{ kind: "param", name: "gain", default: 1, min: 0, max: 4, automationRate: "a-rate" }],
} as unknown as Parameters<typeof emitWorkletModuleSource>[0];

test("import runtime: boots via a `@unworklet/core/worklet` import, no authoring source", () => {
  const out = emitWorkletModuleSource(META_FIXTURE, {
    processorName: "stereoGain__abcd1234",
    runtime: { kind: "import" },
  });
  expect(out).toContain('from "@unworklet/core/worklet"');
  expect(out).toContain("makeWorkletNamespaceFromMeta(__unworkletMeta)");
  expect(out).toContain(JSON.stringify(META_FIXTURE)); // meta inlined as JSON
  expect(out).toContain("extends AudioWorkletProcessor");
  expect(out).toContain("__unworkletNs.parameterDescriptors");
  expect(out).toContain("__unworkletNs.initialize");
  expect(out).toContain("__unworkletNs.process");
  expect(out).toContain('registerProcessor("stereoGain__abcd1234"');
  expect(out).not.toContain("defineProcessor");
});

test("inline runtime: prepends the self-contained bundle, no `import` (Safari-safe)", () => {
  const out = emitWorkletModuleSource(META_FIXTURE, {
    processorName: "uwk-runtime-0",
    runtime: { kind: "inline", code: "globalThis.__uwkMakeNs = (m) => ({});" },
  });
  expect(out).toContain("globalThis.__uwkMakeNs = (m) => ({});"); // the inlined runtime
  expect(out).toContain("globalThis.__uwkMakeNs(__unworkletMeta)");
  expect(out).not.toMatch(/(^|\n)\s*import[\s{]/); // no ESM import — Blob/Safari-safe
  expect(out).toContain("extends AudioWorkletProcessor");
  expect(out).toContain('registerProcessor("uwk-runtime-0"');
});

test("JSON-escapes the processor name", () => {
  const out = emitWorkletModuleSource(META_FIXTURE, {
    processorName: 'name "with quote"',
    runtime: { kind: "import" },
  });
  expect(out).toContain('"name \\"with quote\\""');
});

test("deterministic for the same input", () => {
  const a = emitWorkletModuleSource(META_FIXTURE, {
    processorName: "x",
    runtime: { kind: "import" },
  });
  const b = emitWorkletModuleSource(META_FIXTURE, {
    processorName: "x",
    runtime: { kind: "import" },
  });
  expect(a).toBe(b);
});

test("round-trips an i64 state's bigint `initial` as a `0n` literal (no JSON.stringify crash)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const count = state.i64(0n).named("count");
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(0);
          count.write(count.read().add(i64(1n)));
        });
      },
    };
  });
  await compile(proc);
  const meta = extractWorkletMeta(
    proc.graph as unknown as Parameters<typeof extractWorkletMeta>[0],
  );
  const emitted = emitWorkletModuleSource(meta, {
    processorName: "i64Counter",
    runtime: { kind: "import" },
  });
  expect(emitted).toContain('"initial":0n');
});
