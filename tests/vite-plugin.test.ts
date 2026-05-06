// Smoke-test the @unworklet/vite-plugin: exercise its resolveId and load
// hooks against an in-tree processor module and verify the returned
// source produces a JS chunk that registers a worklet processor.
import { describe, expect, test } from "vite-plus/test";
import unworkletPlugin from "@unworklet/vite-plugin";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const procFile = path.resolve(__dirname, "..", "examples", "src", "01-stereo-gain.ts");

describe("@unworklet/vite-plugin", () => {
  test("?unworklet suffix resolves and produces JS that registers the processor", async () => {
    const plugin: any = unworkletPlugin();
    const resolveCtx = {
      resolve: async (id: string, _imp: string) => ({ id }),
    };
    const resolved = await plugin.resolveId.call(
      resolveCtx,
      procFile + "?unworklet",
      "/fake/importer.ts",
    );
    expect(resolved).toMatch(/01-stereo-gain\.ts\?unworklet$/);
    // No emitFile available in this fake load ctx → dev path: expect a Blob-URL JS.
    const loaded = await plugin.load.call({}, resolved);
    expect(typeof loaded).toBe("string");
    expect(loaded).toMatch(/processorName/);
    expect(loaded).toMatch(/atob|Blob|URL\.createObjectURL/);
  });
});
