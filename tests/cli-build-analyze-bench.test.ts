// CLI subcommand smoke tests: build, analyze, bench.
import { expect, test, describe } from "vite-plus/test";
import { cmdBuild, cmdAnalyze, cmdBench } from "@unworklet/cli";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const examplePath = path.resolve("examples/src/01-stereo-gain.ts");

describe("cmdBuild", () => {
  test("emits .wasm + .worklet.js + .meta.json + .wat for stereoGain", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uw-build-"));
    try {
      const arts = await cmdBuild({
        modulePath: examplePath,
        exportName: "stereoGain",
        outDir: dir,
      });
      const wasm = await fs.readFile(arts.wasmPath);
      expect(wasm.byteLength).toBeGreaterThan(20);
      // WASM magic number 0x00 0x61 0x73 0x6d (\\0asm)
      expect(wasm[0]).toBe(0x00);
      expect(wasm[1]).toBe(0x61);
      expect(wasm[2]).toBe(0x73);
      expect(wasm[3]).toBe(0x6d);

      const worklet = await fs.readFile(arts.workletPath, "utf-8");
      expect(worklet).toContain("registerProcessor");

      const meta = JSON.parse(await fs.readFile(arts.metaPath, "utf-8"));
      expect(meta.name).toBe("stereoGain");
      expect(meta.declarations.params.length).toBe(1);
      expect(meta.schemaHash).toBeDefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cmdAnalyze", () => {
  test("reports metrics + diagnostics for stereoGain (human format)", async () => {
    const r = await cmdAnalyze({
      modulePath: examplePath,
      exportName: "stereoGain",
      format: "human",
    });
    expect(r.formatted).toContain("Analysis of stereoGain");
    expect(r.formatted).toContain("metrics");
    expect(r.exitCode).toBe(0);
  });

  test("emits JSON when --format json", async () => {
    const r = await cmdAnalyze({
      modulePath: examplePath,
      exportName: "stereoGain",
      format: "json",
    });
    const j = JSON.parse(r.formatted);
    expect(j.name).toBe("stereoGain");
    expect(j.metrics).toBeDefined();
    expect(Array.isArray(j.diagnostics)).toBe(true);
  });
});

describe("cmdBench", () => {
  test("measures P50/P95/P99 latency for stereoGain", async () => {
    const r = await cmdBench({
      modulePath: examplePath,
      exportName: "stereoGain",
      durationSec: 0.05, // tiny
      sampleRate: 48000,
      blockSize: 128,
    });
    expect(r.measurements.blocks).toBeGreaterThan(0);
    expect(r.measurements.perBlockNs.p50).toBeGreaterThan(0);
    expect(r.measurements.perBlockNs.p95).toBeGreaterThanOrEqual(r.measurements.perBlockNs.p50);
    expect(r.measurements.perBlockNs.p99).toBeGreaterThanOrEqual(r.measurements.perBlockNs.p95);
    expect(r.measurements.hasNaN).toBe(false);
    expect(r.measurements.hasInf).toBe(false);
    expect(r.formatted).toContain("Bench stereoGain");
  });
});
