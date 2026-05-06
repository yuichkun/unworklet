// Verifies that the Layer-3 static-analysis checks added per docs/03-compiler
// §2.4 actually fire on the patterns they're meant to catch.
import { describe, expect, test } from "vite-plus/test";
import { compileToWasm } from "@unworklet/compiler";
import { analyze } from "@unworklet/compiler";
import {
  defineProcessor,
  audioOutput,
  state,
  forSample,
  add,
  mul,
  abs,
} from "@unworklet/core";

const SR = 48000;

describe("Layer-3 diagnostics", () => {
  test("emits allocation-free attestation", () => {
    const proc = defineProcessor(() => {
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          forSample((i) => out.set(0, i, 0));
        },
      };
    });
    const r = compileToWasm(proc, { sampleRate: SR });
    const a = analyze(r.graph, r.layout);
    const codes = a.diagnostics.map((d) => d.code);
    expect(codes).toContain("allocation-free");
  });

  test("warns on forSample.byN stride that does not divide renderQuantum", () => {
    const proc = defineProcessor(() => {
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          forSample.byN(7, (i) => out.set(0, i, 0));
        },
      };
    });
    const r = compileToWasm(proc, { sampleRate: SR, renderQuantum: 128 });
    const a = analyze(r.graph, r.layout);
    const codes = a.diagnostics.map((d) => d.code);
    expect(codes).toContain("loop-stride-not-divisor");
  });

  test("flags state slot that looks like a denormal-prone one-pole filter", () => {
    // env = env + 0.95 * (input - env)  → coefficient 0.95 in (0.9, 1.0)
    const proc = defineProcessor(() => {
      const out = audioOutput({ channels: 1, name: "main" });
      const env = state.f32(0, { name: "env" });
      return {
        process: () => {
          forSample((i) => {
            const x = abs(env.load());
            // contrived: env = env * 0.95 + something — triggers the heuristic
            env.store(add(mul(env.load(), 0.95), x));
            out.set(0, i, env.load());
          });
        },
      };
    });
    const r = compileToWasm(proc, { sampleRate: SR });
    const a = analyze(r.graph, r.layout);
    const codes = a.diagnostics.map((d) => d.code);
    expect(codes).toContain("denormal-prone-filter");
  });
});
