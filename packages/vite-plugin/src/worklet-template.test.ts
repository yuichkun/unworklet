/**
 * Behavioral tests for `emitWorkletTemplate(...)` — the JS source emitter that
 * vite-plugin uses to construct the worklet runtime entry (= the file loaded
 * via `audioWorklet.addModule(url)` in the worklet realm)。
 *
 * `01-dsl.md` §11 + Q80 で `def.worklet` namespace を 共通 基盤 と し て
 * 経由 する 規約。 template の 中身 = user source の 再 import + class extends
 * AudioWorkletProcessor + registerProcessor の 小さな wrapper。 関数 本体 は
 * import を 経由 し て worklet realm 内 で 新規 生成 さ れる (= main realm の
 * closure を 移送 する 経路 は ナ シ)。
 */

import { expect, test } from "vite-plus/test";

import { emitWorkletTemplate } from "./worklet-template.ts";

test("emits a JS module that imports the user source by absolute path", () => {
  const out = emitWorkletTemplate({
    userSourcePath: "/abs/path/to/x.processor.ts",
    processorExportName: "stereoGain",
    processorName: "stereoGain",
  });
  expect(out).toContain('"/abs/path/to/x.processor.ts"');
  expect(out).toContain("import");
});

test("imports the user's processor under the declared export name", () => {
  const out = emitWorkletTemplate({
    userSourcePath: "/abs/foo.ts",
    processorExportName: "myProcessor",
    processorName: "myProcessor",
  });
  expect(out).toContain("myProcessor");
});

test("emits a class extending AudioWorkletProcessor + registerProcessor call", () => {
  const out = emitWorkletTemplate({
    userSourcePath: "/abs/foo.ts",
    processorExportName: "stereoGain",
    processorName: "stereoGain",
  });
  expect(out).toContain("extends AudioWorkletProcessor");
  expect(out).toContain("registerProcessor");
  expect(out).toContain('"stereoGain"');
});

test("wires class methods to the worklet namespace 3 entries", () => {
  const out = emitWorkletTemplate({
    userSourcePath: "/abs/foo.ts",
    processorExportName: "stereoGain",
    processorName: "stereoGain",
  });
  expect(out).toContain("worklet.parameterDescriptors");
  expect(out).toContain("worklet.initialize");
  expect(out).toContain("worklet.process");
});

test("the registered processor name can differ from the export identifier", () => {
  const out = emitWorkletTemplate({
    userSourcePath: "/abs/foo.ts",
    processorExportName: "stereoGain",
    processorName: "unworklet:stereoGain__abc",
  });
  expect(out).toContain('"unworklet:stereoGain__abc"');
});

test("JSON-escapes special characters in the source path and processor name", () => {
  const out = emitWorkletTemplate({
    userSourcePath: '/abs/with "quote".ts',
    processorExportName: "x",
    processorName: 'name "with quote"',
  });
  expect(out).toContain('"/abs/with \\"quote\\".ts"');
  expect(out).toContain('"name \\"with quote\\""');
});

test("returns deterministic output for the same input", () => {
  const a = emitWorkletTemplate({
    userSourcePath: "/abs/foo.ts",
    processorExportName: "x",
    processorName: "x",
  });
  const b = emitWorkletTemplate({
    userSourcePath: "/abs/foo.ts",
    processorExportName: "x",
    processorName: "x",
  });
  expect(a).toBe(b);
});
