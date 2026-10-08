import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";
import { expect, test } from "vite-plus/test";

import {
  compile,
  emitWorkletModuleSource,
  extractWorkletMeta,
} from "../packages/core/src/index.ts";
import type { CapturedGraph } from "../packages/core/src/compile/ast.ts";
import processor from "../packages/core/src/__tests__/browser/fixtures/native-rate.processor.ts";
import { nativeRateWorklet } from "./native-rate-worklet.ts";

test("serves a real 44100 artifact and resolves its generated worklet runtime through Vite", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("../packages/core", import.meta.url)),
    configFile: false,
    plugins: [nativeRateWorklet()],
    server: { host: "127.0.0.1", port: 0 },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    await server.listen();
    const base = server.resolvedUrls!.local[0]!;
    const namespace = await server.transformRequest("virtual:native-rate-worklet");
    expect(namespace!.code).toContain("bakedSampleRate: 44100");
    expect(namespace!.code).toContain('processorName: "native-rate"');
    expect(namespace!.code).toContain("/__native-rate-worklet.wasm");
    expect(namespace!.code).toContain("/@id/__x00__native-rate-worklet-entry");

    const compilation = await compile(processor, { sampleRate: 44100 });
    const expected = emitWorkletModuleSource(
      extractWorkletMeta(compilation.graph as unknown as CapturedGraph),
      { processorName: "native-rate", runtime: { kind: "import" } },
    );
    const generated = await server.pluginContainer.load("\0native-rate-worklet-entry");
    expect(generated).toBe(expected);
    const entry = await fetch(new URL("/@id/__x00__native-rate-worklet-entry", base));
    expect(entry.status).toBe(200);
    const source = await entry.text();
    expect(source).toContain('registerProcessor("native-rate"');
    expect(source).not.toContain('from "@unworklet/core/worklet"');
    expect(source).toContain("makeWorkletNamespaceFromMeta");

    const wasm = await fetch(new URL("/__native-rate-worklet.wasm", base));
    expect(wasm.status).toBe(200);
    expect(wasm.headers.get("Content-Type")).toBe("application/wasm");
    const bytes = new Uint8Array(await wasm.arrayBuffer());
    expect(bytes).toEqual(compilation.wasm);
    expect(WebAssembly.validate(bytes)).toBe(true);
    expect((await fetch(new URL("/__native-rate-worklet.wasm-other", base))).status).toBe(404);
  } finally {
    await server.close();
  }
});
