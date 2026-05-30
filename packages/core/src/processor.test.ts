/**
 * Behavioral tests for `defineProcessor` (= Step 3.1 implementation in
 * `./processor.ts`) and the subgraph stubs (= Phase 8 placeholder).
 *
 * Covers: body lambda invocation with the placeholder `ProcessorContext`,
 * the single `process()` invocation during capture, propagation of throws
 * from both the body and the `process` lambda, the shape of the returned
 * `CompiledProcessor`, and the worklet-namespace stubs.
 */

import { expect, test } from "vite-plus/test";

import { defineProcessor } from "./processor.ts";

test("`defineProcessor` invokes the body lambda with a `ProcessorContext`", () => {
  let observedSampleRate: number | null = null;
  defineProcessor((ctx) => {
    observedSampleRate = ctx.sampleRate;
    return { process: () => {} };
  });
  expect(observedSampleRate).toBe(0);
});

test("`defineProcessor` runs the returned `process` lambda exactly once during capture", () => {
  let processCalls = 0;
  defineProcessor(() => ({
    process: () => {
      processCalls += 1;
    },
  }));
  expect(processCalls).toBe(1);
});

test("`defineProcessor` returns a `CompiledProcessor` shape (= graph + schemaHash + worklet)", () => {
  const cp = defineProcessor(() => ({ process: () => {} }));
  expect(cp.schemaHash).toBe("phase-3-stub");
  expect(cp.graph).toBeDefined();
  expect(cp.worklet.parameterDescriptors).toEqual([]);
  expect(typeof cp.worklet.initialize).toBe("function");
  expect(typeof cp.worklet.process).toBe("function");
});

test("`defineProcessor` propagates throws from the body lambda", () => {
  expect(() =>
    defineProcessor(() => {
      throw new Error("body fail");
    }),
  ).toThrow("body fail");
});

test("`defineProcessor` propagates throws from the `process` lambda", () => {
  expect(() =>
    defineProcessor(() => ({
      process: () => {
        throw new Error("process fail");
      },
    })),
  ).toThrow("process fail");
});
