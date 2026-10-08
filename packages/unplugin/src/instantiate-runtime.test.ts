/// <reference lib="dom" />

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { build, type Plugin } from "vite-plus";
import { expect, test } from "vite-plus/test";

import unworklet from "./index.ts";

test("a real Vite worklet build renders scalar arguments imported through a subgraph barrel", async () => {
  const root = mkdtempSync(path.resolve(import.meta.dirname, "../.instantiate-vite-"));
  try {
    writeFileSync(
      path.join(root, "gain.uwk.ts"),
      `
export const gain = defineSubgraph((value: Node<"f32">, precise: Node<"f64">, count: Node<"i32">, enabled: Node<"bool">) => ({
  tick: () => value.mul(f32(precise.sub(f64(16777216)))).add(f32(count)).mul(select(enabled.not(), 0, 1)),
}));`,
    );
    writeFileSync(
      path.join(root, "barrel.uwk.ts"),
      'export { gain as amplitude } from "./gain.uwk.ts";',
    );
    writeFileSync(
      path.join(root, "tone.uwk.ts"),
      `
import { amplitude as graph } from "./barrel.uwk.ts";
import { instantiate as create } from "@unworklet/core";
const instance = create(graph, 0.25, 16777217, 4294967299.75, true);
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample(i => { out.ch(0).at(i).write(instance.tick()); }); });`,
    );
    writeFileSync(path.join(root, "main.ts"), 'export { default } from "./tone.uwk.ts?worklet";');

    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [unworklet({ emitAnalysisArtifacts: true }) as Plugin],
      build: {
        write: false,
        minify: false,
        lib: { entry: path.join(root, "main.ts"), formats: ["es"] },
        rollupOptions: { external: ["@unworklet/core"] },
      },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((bundle) => {
      if (!("output" in bundle)) throw new Error("unexpected build watcher");
      return bundle.output;
    });
    const wasm = outputs.find(
      (output) => output.type === "asset" && output.fileName.endsWith(".wasm"),
    );
    const memory = outputs.find(
      (output) => output.type === "asset" && /\.memory(?:-[\w-]+)?\.json$/.test(output.fileName),
    );
    expect(wasm?.type).toBe("asset");
    expect(memory?.type).toBe("asset");
    if (wasm?.type !== "asset" || memory?.type !== "asset")
      throw new Error("missing build artifacts");
    const layout = JSON.parse(
      typeof memory.source === "string" ? memory.source : new TextDecoder().decode(memory.source),
    ) as {
      regions: { ioScratch: { outputs: Record<string, number> } };
    };
    const bytes =
      typeof wasm.source === "string" ? new TextEncoder().encode(wasm.source) : wasm.source;
    const module = await WebAssembly.compile(new Uint8Array(bytes).buffer);
    const instance = await WebAssembly.instantiate(module);
    const processBlock = instance.exports.process as () => void;
    processBlock();
    const samples = new Float32Array(
      (instance.exports.memory as WebAssembly.Memory).buffer,
      layout.regions.ioScratch.outputs.main,
      128,
    );
    expect([...samples]).toEqual(Array.from({ length: 128 }, () => 3.25));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
