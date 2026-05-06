// Verifies that /precise and /table import paths actually flow through to
// the WASM emitter — precise = same as default; table = different lowering
// (lookup table embedded in linear memory).
import { describe, expect, test } from "vite-plus/test";
import { compileToWasm } from "@unworklet/compiler";
import {
  defineProcessor,
  audioInput,
  audioOutput,
  forSample,
} from "@unworklet/core";
import { sin as sinPrecise } from "@unworklet/dsp/precise";
import { sin as sinTable } from "@unworklet/dsp/table";

const SR = 48000;

function buildProcessor(sinFn: (x: any) => any) {
  return defineProcessor(() => {
    const inp = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          out.set(0, i, sinFn(inp.at(0, i)));
        });
      },
    };
  });
}

describe("precise / table math import paths", () => {
  test("table emits a sin lookup table region in linear memory", () => {
    const proc = buildProcessor(sinTable);
    const r = compileToWasm(proc, { sampleRate: SR });
    const tables = (r.layout as any).mathTables ?? [];
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.some((t: any) => t.kind === "sin")).toBe(true);
    // The text format should not contain a `call $math_sin` for table mode
    // — it should be all loads + arithmetic.
    expect(r.text.includes("call $math_sin")).toBe(false);
  });

  test("precise lowers via JS Math import (no table region)", () => {
    const proc = buildProcessor(sinPrecise);
    const r = compileToWasm(proc, { sampleRate: SR });
    const tables = (r.layout as any).mathTables ?? [];
    expect(tables.length).toBe(0);
    // `call $math_sin` is the JS Math import — present in precise mode.
    expect(r.text.includes("call $math_sin")).toBe(true);
  });
});
