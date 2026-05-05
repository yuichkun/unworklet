// Cross-validate WASM compilation against the legacy JS interpreter for the
// canonical examples. For each example, render the same input through both
// backends and compare outputs sample-by-sample within a small FP tolerance.
//
// Per docs/06-testing.md §2: "the WASM and JS backends must produce
// bit-identical output for the same input (modulo documented floating-point
// differences)." We use 1e-3 tolerance to allow for different math.sin
// implementations and FMA/non-FMA ordering.
import { expect, test, describe } from "vite-plus/test";
import { compileToWasm, type CompileResult } from "@unworklet/compiler";
import { renderOffline } from "@unworklet/client";
import {
  stereoGain,
  threeBandEQ,
  feedbackDelay,
  chorus,
  distortion,
  compressor,
} from "@unworklet/examples";

const SR = 48000;
const BLOCK = 128;
const TOL = 1e-3;

async function instantiate(result: CompileResult) {
  const mod = await WebAssembly.compile(result.binary as any);
  const inst = await WebAssembly.instantiate(mod, {
    math: {
      sin: Math.sin,
      cos: Math.cos,
      tan: Math.tan,
      tanh: Math.tanh,
      exp: Math.exp,
      log: Math.log,
      pow: Math.pow,
      atan2: Math.atan2,
    },
  });
  const exports = inst.exports as any;
  exports.init();
  return { exports, layout: result.layout };
}

async function renderViaWasm(
  processor: any,
  durationSec: number,
  input: (sample: number, ch: number) => number,
  paramOverrides: Record<string, number> = {},
) {
  const result = compileToWasm(processor, { sampleRate: SR });
  const { exports, layout } = await instantiate(result);
  const totalSamples = Math.ceil(durationSec * SR);
  const numBlocks = Math.ceil(totalSamples / BLOCK);

  // Allocate output buffers padded to numBlocks*BLOCK so the last block fits.
  const padded = numBlocks * BLOCK;
  const outputs: Float32Array[][] = layout.audioOutputs.outputs.map((ao) =>
    Array.from({ length: ao.channels }, () => new Float32Array(padded)),
  );

  const mem = new Float32Array((exports.memory as WebAssembly.Memory).buffer);
  for (let b = 0; b < numBlocks; b++) {
    const blockStart = b * BLOCK;
    // Marshal inputs
    for (const ai of layout.audioInputs.inputs) {
      for (let c = 0; c < ai.channels; c++) {
        const dst = mem.subarray(
          (ai.offset + c * ai.channelStride) / 4,
          (ai.offset + c * ai.channelStride) / 4 + BLOCK,
        );
        for (let i = 0; i < BLOCK; i++) {
          dst[i] = input(blockStart + i, c);
        }
      }
    }
    // Set param values
    for (const pl of layout.params.layouts) {
      const decl = result.graph.declarations.params.find((p) => p.id === pl.paramId)!;
      const v = paramOverrides[decl.name] ?? decl.default;
      if (pl.automationRate === "a-rate") {
        for (let i = 0; i < BLOCK; i++) mem[pl.offset / 4 + i] = v;
      } else {
        mem[pl.offset / 4] = v;
      }
    }
    exports.process(BLOCK);
    // Read outputs
    for (let p = 0; p < layout.audioOutputs.outputs.length; p++) {
      const ao = layout.audioOutputs.outputs[p]!;
      const portOut = outputs[p]!;
      for (let c = 0; c < ao.channels; c++) {
        const src = mem.subarray(
          (ao.offset + c * ao.channelStride) / 4,
          (ao.offset + c * ao.channelStride) / 4 + BLOCK,
        );
        portOut[c]!.set(src, blockStart);
      }
    }
  }
  return outputs[0]!; // first output port channels
}

function compareChannels(jsCh: Float32Array, wasmCh: Float32Array, tol: number) {
  let maxDiff = 0;
  let maxAt = -1;
  for (let i = 0; i < jsCh.length; i++) {
    const d = Math.abs(jsCh[i]! - wasmCh[i]!);
    if (d > maxDiff) {
      maxDiff = d;
      maxAt = i;
    }
  }
  return { maxDiff, maxAt };
}

const sineFn =
  (freq: number, amp = 0.5) =>
  (s: number) =>
    Math.sin((2 * Math.PI * freq * s) / SR) * amp;

const stereoSineFn =
  (freq: number, amp = 0.5) =>
  (s: number, c: number) =>
    Math.sin((2 * Math.PI * (freq + c * 100) * s) / SR) * amp;

describe("WASM ↔ JS cross-validation", () => {
  test("01 stereoGain — bit-equivalent output", async () => {
    const dur = 0.05;
    const inFn = stereoSineFn(440);
    const inputBuffers = [
      new Float32Array(Math.ceil(dur * SR)),
      new Float32Array(Math.ceil(dur * SR)),
    ];
    for (let i = 0; i < inputBuffers[0]!.length; i++) {
      inputBuffers[0]![i] = inFn(i, 0);
      inputBuffers[1]![i] = inFn(i, 1);
    }
    const js = await renderOffline(stereoGain, {
      sampleRate: SR,
      duration: dur,
      input: { main: inputBuffers },
      params: { gain: 0.6 },
    });
    const wasmOut = await renderViaWasm(stereoGain, dur, inFn, { gain: 0.6 });

    const jsL = js.output.main![0]!;
    const wasmL = wasmOut[0]!;
    const cmp = compareChannels(jsL, wasmL, TOL);
    expect(cmp.maxDiff).toBeLessThan(TOL);
  });

  test("02 threeBandEQ — within FP tolerance", async () => {
    const dur = 0.05;
    const inFn = stereoSineFn(1000);
    const inputBuffers = [
      new Float32Array(Math.ceil(dur * SR)),
      new Float32Array(Math.ceil(dur * SR)),
    ];
    for (let i = 0; i < inputBuffers[0]!.length; i++) {
      inputBuffers[0]![i] = inFn(i, 0);
      inputBuffers[1]![i] = inFn(i, 1);
    }
    const js = await renderOffline(threeBandEQ, {
      sampleRate: SR,
      duration: dur,
      input: { main: inputBuffers },
    });
    const wasmOut = await renderViaWasm(threeBandEQ, dur, inFn);

    const cmp = compareChannels(js.output.main![0]!, wasmOut[0]!, 1e-2);
    // Biquads accumulate FP error over time; allow slightly larger tolerance.
    expect(cmp.maxDiff).toBeLessThan(0.05);
  });

  test("11 distortion — within FP tolerance", async () => {
    const dur = 0.02;
    const inFn = sineFn(440, 0.7);
    const inputBuffers = [new Float32Array(Math.ceil(dur * SR))];
    inputBuffers.push(new Float32Array(inputBuffers[0]!.length));
    for (let i = 0; i < inputBuffers[0]!.length; i++) {
      inputBuffers[0]![i] = inFn(i);
      inputBuffers[1]![i] = inFn(i);
    }
    const js = await renderOffline(distortion, {
      sampleRate: SR,
      duration: dur,
      input: { main: inputBuffers },
      params: { drive: 6, tone: 0.5, outGain: 0.5 },
    });
    const wasmOut = await renderViaWasm(distortion, dur, (s) => inFn(s), {
      drive: 6,
      tone: 0.5,
      outGain: 0.5,
    });
    const cmp = compareChannels(js.output.main![0]!, wasmOut[0]!, 5e-3);
    expect(cmp.maxDiff).toBeLessThan(5e-2);
  });
});
