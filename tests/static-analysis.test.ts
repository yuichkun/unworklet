// Static analysis pass tests.
import { expect, test, describe } from "vite-plus/test";
import { compileToWasm, capture, planLayout, analyze, formatDiagnostic } from "@unworklet/compiler";
import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  forSample,
  mul,
  abs,
  max,
} from "@unworklet/core";
import { setCaptureBackend } from "@unworklet/core/internal";
import { captureBackend } from "@unworklet/compiler";
import { stereoGain, threeBandEQ } from "@unworklet/examples";

test("metrics for stereoGain are sensible", () => {
  const result = compileToWasm(stereoGain, { sampleRate: 48000 });
  const a = analyze(result.graph, result.layout);
  expect(a.metrics.audioInputs).toBe(1);
  expect(a.metrics.audioOutputs).toBe(1);
  expect(a.metrics.paramsDeclared).toBe(1);
  // 2 state slots: meterL, meterR
  expect(a.metrics.statesDeclared).toBe(2);
  expect(a.metrics.estInstructionsPerBlock).toBeGreaterThan(0);
});

test("warns on unused parameter", () => {
  setCaptureBackend(captureBackend);
  let graph;
  try {
    graph = capture(
      () => {
        const out = audioOutput({ channels: 1, name: "main" });
        // declared but never read
        param({
          default: 1,
          min: 0,
          max: 10,
          automationRate: "k-rate",
          name: "unused",
        });
        return {
          process: () => {
            forSample((i: any) => {
              out.set(0, i, 0.5);
            });
          },
        };
      },
      { sampleRate: 48000 },
    );
  } finally {
    setCaptureBackend(null);
  }
  const layout = planLayout(graph, { renderQuantum: 128 });
  const a = analyze(graph, layout);
  const unusedDiag = a.diagnostics.find((d) => d.code === "param-unused");
  expect(unusedDiag).toBeDefined();
  expect(unusedDiag?.level).toBe("warning");
});

test("rejects processor that never writes its declared output", () => {
  setCaptureBackend(captureBackend);
  let graph;
  try {
    graph = capture(
      () => {
        // Stereo output declared, but only channel 0 is written
        const out = audioOutput({ channels: 2, name: "main" });
        return {
          process: () => {
            forSample((i: any) => {
              out.set(0, i, 0);
              // channel 1 intentionally not written
            });
          },
        };
      },
      { sampleRate: 48000 },
    );
  } finally {
    setCaptureBackend(null);
  }
  const layout = planLayout(graph, { renderQuantum: 128 });
  const a = analyze(graph, layout);
  const errs = a.diagnostics.filter(
    (d) => d.level === "error" && d.code === "audio-output-not-written",
  );
  expect(errs.length).toBeGreaterThan(0);
});

test("threeBandEQ analysis: cycle estimate is in informational range", () => {
  const result = compileToWasm(threeBandEQ, { sampleRate: 48000 });
  const a = analyze(result.graph, result.layout);
  expect(a.metrics.statesDeclared).toBeGreaterThanOrEqual(12);
  // Six biquad subgraphs × ~12 ops each + per-sample loop ~ at least 100 ops per sample
  expect(a.metrics.estInstructionsPerSample).toBeGreaterThan(50);
  // Memory should be reasonable
  expect(a.metrics.memoryBytes).toBeLessThan(1024 * 1024); // < 1 MiB
});

test("formatDiagnostic includes refactor hint", () => {
  const d = {
    level: "error" as const,
    code: "x",
    message: "msg",
    refactorHint: "do X",
  };
  const s = formatDiagnostic(d);
  expect(s).toContain("ERROR");
  expect(s).toContain("msg");
  expect(s).toContain("hint");
});
