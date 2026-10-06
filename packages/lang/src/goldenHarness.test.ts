import { expect, test, vi } from "vite-plus/test";

import { expectSameLoweredText, renderLoweredText } from "./goldenHarness.ts";

const counter = `import { add, audioOutput, defineProcessor, forSample, state } from "@unworklet/core";
let captures = 0;
export default defineProcessor(() => {
  captures++;
  const out = audioOutput({ channels: 1, name: "main" });
  const count = state.f32(0).named("count");
  return { process: () => forSample(i => {
    count.write(add(count.read(), 1));
    out.ch(0).at(i).write(add(count.read(), captures));
  }) };
});`;
const config = { sampleRate: 48000, duration: 128 / 48000 };

type WasmCompile = (bytes: ArrayBuffer | ArrayBufferView) => Promise<WebAssembly.Module>;
const wasm = (globalThis as unknown as { WebAssembly: { compile: WasmCompile } }).WebAssembly;

test.each(["sequential", "concurrent"])(
  "prepared text keeps %s renders independently compiled and initialized",
  async (mode) => {
    const baseline = await renderLoweredText(counter, config);
    const samples = baseline.outputs.main![0]!;
    expect([...samples]).toEqual(Array.from({ length: 128 }, (_, i) => samples[0]! + i));
    const compile = vi.spyOn(wasm, "compile");
    try {
      const results =
        mode === "concurrent"
          ? await Promise.all([
              renderLoweredText(counter, config),
              renderLoweredText(counter, config),
            ])
          : [await renderLoweredText(counter, config), await renderLoweredText(counter, config)];
      expect(compile).toHaveBeenCalledTimes(2);
      for (const result of results) {
        expect(result.outputs.main![0]).toEqual(samples);
        expect(result.diagnostics.scrubbedSamples).toBe(0);
      }
    } finally {
      compile.mockRestore();
    }
  },
);

test("prepared fingerprints evaluate independent capture closures for identical text", async () => {
  await expect(expectSameLoweredText(counter, counter)).resolves.toBeUndefined();
});
