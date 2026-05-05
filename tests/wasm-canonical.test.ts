// Compile the existing canonical examples (which import from @unworklet/core)
// to WASM via the capture backend dispatch and verify they render correct audio.
import { expect, test, describe } from "vite-plus/test";
import { compileToWasm, type CompileResult } from "@unworklet/compiler";
import { stereoGain, threeBandEQ } from "@unworklet/examples";

const SR = 48000;
const BLOCK = 128;

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

test("Example 01 stereoGain compiles to WASM and renders correct audio", async () => {
  const result = compileToWasm(stereoGain, { sampleRate: SR });
  const { exports, layout } = await instantiate(result);

  // Fill stereo input with sines, set gain a-rate at 0.5
  const mem = new Float32Array((exports.memory as WebAssembly.Memory).buffer);
  const ai = layout.audioInputs.inputs[0]!;
  const ao = layout.audioOutputs.outputs[0]!;
  const pl = layout.params.layouts.find((p) => true)!; // gain
  for (let i = 0; i < BLOCK; i++) {
    mem[(ai.offset + 0 * ai.channelStride) / 4 + i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.7;
    mem[(ai.offset + 1 * ai.channelStride) / 4 + i] = Math.sin((2 * Math.PI * 660 * i) / SR) * 0.7;
    mem[pl.offset / 4 + i] = 0.5;
  }
  exports.process(BLOCK);

  let peakL = 0;
  let peakR = 0;
  for (let i = 0; i < BLOCK; i++) {
    peakL = Math.max(peakL, Math.abs(mem[(ao.offset + 0 * ao.channelStride) / 4 + i]!));
    peakR = Math.max(peakR, Math.abs(mem[(ao.offset + 1 * ao.channelStride) / 4 + i]!));
  }
  expect(peakL).toBeGreaterThan(0.3);
  expect(peakL).toBeLessThan(0.36);
  expect(peakR).toBeGreaterThan(0.3);
  expect(peakR).toBeLessThan(0.36);

  // Verify output exactly equals input × gain
  for (let i = 0; i < BLOCK; i++) {
    const expectedL = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.7 * 0.5;
    expect(mem[(ao.offset + 0 * ao.channelStride) / 4 + i]).toBeCloseTo(expectedL, 5);
  }
});

test("Example 02 threeBandEQ compiles to WASM (with subgraph instances) and renders audio", async () => {
  const result = compileToWasm(threeBandEQ, { sampleRate: SR });
  expect(result.binary.byteLength).toBeGreaterThan(100);
  // Schema: 6 subgraph instances × 2 state slots each = 12 state slots
  expect(result.layout.stateRegion.slots.length).toBeGreaterThanOrEqual(12);

  const { exports, layout } = await instantiate(result);
  const mem = new Float32Array((exports.memory as WebAssembly.Memory).buffer);

  // Find input port
  const ai = layout.audioInputs.inputs[0]!;
  for (let i = 0; i < BLOCK; i++) {
    mem[(ai.offset + 0 * ai.channelStride) / 4 + i] = Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.5;
    mem[(ai.offset + 1 * ai.channelStride) / 4 + i] = Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.5;
  }
  // All 9 params: set defaults
  // (init() should already have done this; if k-rate, we need to write to offset 0.)

  exports.process(BLOCK);
  const ao = layout.audioOutputs.outputs[0]!;
  let peak = 0;
  let nan = false;
  for (let i = 0; i < BLOCK; i++) {
    const v = mem[(ao.offset + 0 * ao.channelStride) / 4 + i]!;
    if (Number.isNaN(v)) nan = true;
    peak = Math.max(peak, Math.abs(v));
  }
  expect(nan).toBe(false);
  // At flat (gain=0), the peaking biquad approximates pass-through.
  expect(peak).toBeGreaterThan(0);
});
