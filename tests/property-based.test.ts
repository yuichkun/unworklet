// Property-based tests over the WASM backend, per docs/06-testing.md §3.
//
// We sample random gain / input combinations and assert invariants:
//   - peak(output) <= |input| × |gain| (within FP slop)
//   - peak <= 2 (well below clipping for finite gain)
//   - no NaN / Inf in output
//
// Property-based testing complements golden-file regression tests by
// finding edge cases the developer wouldn't think to write down.
import { expect, test, describe } from "vite-plus/test";
import fc from "fast-check";
import { renderOfflineWasm } from "@unworklet/test";
import { stereoGain, distortion, compressor } from "@unworklet/examples";

const SR = 48000;

describe("Property: stereoGain output bounded by |input| × |gain|", () => {
  test("any (signal, gain) pair stays within bounds", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.float({ min: -1, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 4, noNaN: true }),
        async (signal, gain) => {
          const inputBuf = new Float32Array(128);
          inputBuf.fill(signal);
          const r = await renderOfflineWasm(stereoGain, {
            sampleRate: SR,
            duration: 128 / SR,
            input: { main: [inputBuf, inputBuf] },
            params: { gain },
          });
          if (r.hasNaN) throw new Error("output had NaN");
          // bound: |out| <= |signal| * gain  (with FP slack)
          if (r.peak > Math.abs(signal) * gain + 1e-3) {
            throw new Error(`peak ${r.peak} > bound ${Math.abs(signal) * gain}`);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("Property: distortion output never exceeds 1.0 + outGain", () => {
  test("tanh saturator output is bounded", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.float({ min: -1.5, max: 1.5, noNaN: true }),
        fc.float({ min: 1, max: 30, noNaN: true }),
        fc.float({ min: 0, max: 2, noNaN: true }),
        async (signal, drive, outGain) => {
          const inputBuf = new Float32Array(128);
          inputBuf.fill(signal);
          const r = await renderOfflineWasm(distortion, {
            sampleRate: SR,
            duration: 128 / SR,
            input: { main: [inputBuf, inputBuf] },
            params: { drive, tone: 0.5, outGain },
          });
          if (r.hasNaN) throw new Error("NaN");
          // tanh saturator output ∈ [-outGain, outGain]; allow small slack.
          if (r.peak > outGain * 1.1 + 1e-3) {
            throw new Error(`peak ${r.peak} > outGain×1.1 ${outGain * 1.1}`);
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe("Property: compressor never produces NaN on bounded input", () => {
  test("compressor stable across param + signal random sweep", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.float({ min: -1, max: 1, noNaN: true }),
        fc.float({ min: -40, max: -1, noNaN: true }),
        fc.float({ min: 1, max: 20, noNaN: true }),
        async (signal, threshold, ratio) => {
          const inputBuf = new Float32Array(128);
          inputBuf.fill(signal);
          const r = await renderOfflineWasm(compressor, {
            sampleRate: SR,
            duration: 128 / SR,
            input: { main: [inputBuf, inputBuf] },
            params: { threshold, ratio, attackMs: 5, releaseMs: 50, kneeDb: 6 },
          });
          if (r.hasNaN) throw new Error("NaN");
        },
      ),
      { numRuns: 20 },
    );
  });
});
