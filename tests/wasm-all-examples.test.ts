// Compile each of the 14 canonical examples to WASM via the capture backend.
// Each test verifies: (a) compilation succeeds, (b) WASM module instantiates,
// (c) processing one block does not throw or produce NaN.
import { expect, test } from "vite-plus/test";
import { compileToWasm } from "@unworklet/compiler";
import {
  stereoGain,
  threeBandEQ,
  linearPhaseEQ,
  lookaheadLimiter,
  granularSampler,
  arpeggiator,
  convolutionReverb,
  polySynth,
  feedbackDelay,
  chorus,
  distortion,
  drumSampler,
  compressor,
  fmSynth,
} from "@unworklet/examples";

const SR = 48000;
const BLOCK = 128;

async function instantiate(binary: Uint8Array) {
  const mod = await WebAssembly.compile(binary as any);
  return WebAssembly.instantiate(mod, {
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
}

async function compileAndProcess(processor: any, name: string) {
  let result;
  try {
    result = compileToWasm(processor, { sampleRate: SR });
  } catch (e: any) {
    throw new Error(`[${name}] compilation failed: ${e.message}`);
  }
  let inst;
  try {
    inst = await instantiate(result.binary);
  } catch (e: any) {
    throw new Error(`[${name}] instantiation failed: ${e.message}\n${result.text}`);
  }
  const exports = inst.exports as any;
  exports.init();
  // Run a few blocks to trigger any latent bugs
  for (let b = 0; b < 4; b++) {
    try {
      exports.process(BLOCK);
    } catch (e: any) {
      throw new Error(`[${name}] process(${b}) trapped: ${e.message}`);
    }
  }
  // Check no NaN in output
  const mem = new Float32Array((exports.memory as WebAssembly.Memory).buffer);
  for (const ao of result.layout.audioOutputs.outputs) {
    for (let c = 0; c < ao.channels; c++) {
      const start = (ao.offset + c * ao.channelStride) / 4;
      for (let i = 0; i < BLOCK; i++) {
        if (Number.isNaN(mem[start + i]!)) {
          throw new Error(`[${name}] NaN in output channel ${c} at sample ${i}`);
        }
      }
    }
  }
  return { result, exports };
}

test("01 stereoGain", async () => {
  await compileAndProcess(stereoGain, "stereoGain");
});

test("02 threeBandEQ", async () => {
  await compileAndProcess(threeBandEQ, "threeBandEQ");
});

test("03 linearPhaseEQ", async () => {
  await compileAndProcess(linearPhaseEQ, "linearPhaseEQ");
});

test("04 lookaheadLimiter", async () => {
  await compileAndProcess(lookaheadLimiter, "lookaheadLimiter");
});

test("05 granularSampler", async () => {
  await compileAndProcess(granularSampler, "granularSampler");
});

test("06 arpeggiator", async () => {
  await compileAndProcess(arpeggiator, "arpeggiator");
});

test("07 convolutionReverb", async () => {
  await compileAndProcess(convolutionReverb, "convolutionReverb");
});

test("08 polySynth", async () => {
  await compileAndProcess(polySynth, "polySynth");
});

test("09 feedbackDelay", async () => {
  await compileAndProcess(feedbackDelay, "feedbackDelay");
});

test("10 chorus", async () => {
  await compileAndProcess(chorus, "chorus");
});

test("11 distortion", async () => {
  await compileAndProcess(distortion, "distortion");
});

test("12 drumSampler", async () => {
  await compileAndProcess(drumSampler, "drumSampler");
});

test("13 compressor", async () => {
  await compileAndProcess(compressor, "compressor");
});

test("14 fmSynth", async () => {
  await compileAndProcess(fmSynth, "fmSynth");
});
