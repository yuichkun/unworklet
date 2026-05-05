// Verify that `process()` accepts a runtime block-size parameter and that
// emitted code uses it as the loop bound — i.e. render quantum is not
// hard-coded to 128 (per docs/04-worklet-runtime.md §3 / draft_spec §12.13).
import { expect, test } from "vite-plus/test";
import { compileToWasm } from "@unworklet/compiler";
import { stereoGain } from "@unworklet/examples";

async function instantiate(binary: Uint8Array) {
  const mod = await WebAssembly.compile(binary as any);
  const inst = await WebAssembly.instantiate(mod, {
    math: {
      sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh,
      exp: Math.exp, log: Math.log, pow: Math.pow, atan2: Math.atan2,
    },
  });
  const exports = inst.exports as any;
  exports.init();
  return { exports };
}

test("processes 128-sample blocks", async () => {
  const result = compileToWasm(stereoGain, { sampleRate: 48000 });
  const { exports } = await instantiate(result.binary);
  const mem = new Float32Array((exports.memory as WebAssembly.Memory).buffer);
  // Fill input
  const ai = result.layout.audioInputs.inputs[0]!;
  for (let i = 0; i < 128; i++) mem[(ai.offset >> 2) + i] = 1;
  exports.process(128);
  // Output should equal input (gain default = 1)
  const ao = result.layout.audioOutputs.outputs[0]!;
  for (let i = 0; i < 128; i++) {
    expect(mem[(ao.offset >> 2) + i]).toBeCloseTo(1, 5);
  }
});

test("processes 64-sample blocks (smaller render quantum)", async () => {
  const result = compileToWasm(stereoGain, { sampleRate: 48000 });
  const { exports } = await instantiate(result.binary);
  const mem = new Float32Array((exports.memory as WebAssembly.Memory).buffer);
  const ai = result.layout.audioInputs.inputs[0]!;
  for (let i = 0; i < 64; i++) mem[(ai.offset >> 2) + i] = 0.5;
  // Zero out positions 64..127 to confirm only 64 samples are written
  for (let i = 64; i < 128; i++) {
    mem[(ai.offset >> 2) + i] = 0;
    mem[((result.layout.audioOutputs.outputs[0]!.offset) >> 2) + i] = -1; // sentinel
  }
  exports.process(64);
  const ao = result.layout.audioOutputs.outputs[0]!;
  for (let i = 0; i < 64; i++) {
    expect(mem[(ao.offset >> 2) + i]).toBeCloseTo(0.5, 5);
  }
  // Samples 64..127 were not written by this 64-sample block (sentinel preserved)
  for (let i = 64; i < 128; i++) {
    expect(mem[(ao.offset >> 2) + i]).toBe(-1);
  }
});

test("processes 256-sample blocks (larger render quantum)", async () => {
  // Compile with renderQuantum=256
  const result = compileToWasm(stereoGain, { sampleRate: 48000, renderQuantum: 256 });
  const { exports } = await instantiate(result.binary);
  const mem = new Float32Array((exports.memory as WebAssembly.Memory).buffer);
  const ai = result.layout.audioInputs.inputs[0]!;
  for (let i = 0; i < 256; i++) mem[(ai.offset >> 2) + i] = 0.7;
  exports.process(256);
  const ao = result.layout.audioOutputs.outputs[0]!;
  for (let i = 0; i < 256; i++) {
    expect(mem[(ao.offset >> 2) + i]).toBeCloseTo(0.7, 5);
  }
});
