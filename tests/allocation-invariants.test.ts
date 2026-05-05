// Allocation invariant verification per docs/00-foundations.md §5 + draft_spec §10.1.
//
// The realtime-safety contract is:
//   - No heap allocation on the audio thread.
//   - No GC-triggering operations.
//
// In Node, we run many process() invocations and verify heap-used does not
// grow unboundedly. WASM linear memory is fixed at instantiation; the only
// allocation that can leak is JS-side wrapper code (which the WASM-backed
// path keeps minimal: it passes ints + linear-memory buffers, no per-block
// object literals).
import { expect, test } from "vite-plus/test";
import { compileToWasm } from "@unworklet/compiler";
import { stereoGain, polySynth, threeBandEQ } from "@unworklet/examples";

async function instantiate(processor: any) {
  const result = compileToWasm(processor, { sampleRate: 48000 });
  const mod = await WebAssembly.compile(result.binary as any);
  const inst = await WebAssembly.instantiate(mod, {
    math: {
      sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh,
      exp: Math.exp, log: Math.log, pow: Math.pow, atan2: Math.atan2,
    },
  });
  const exports = inst.exports as any;
  exports.init();
  return { exports, layout: result.layout };
}

test("stereoGain process() does not grow heap unboundedly", async () => {
  const { exports } = await instantiate(stereoGain);
  // Pre-warm to stabilize JIT
  exports.prewarm(256);
  if (typeof globalThis.gc === "function") globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  // 10000 blocks ≈ 26 seconds of audio at 48kHz
  for (let i = 0; i < 10000; i++) exports.process(128);
  if (typeof globalThis.gc === "function") globalThis.gc();
  const after = process.memoryUsage().heapUsed;
  const growthBytes = after - before;
  // Tolerate a small fluctuation; the audio thread should NOT allocate per
  // block. In practice the WASM call boundary may produce sub-KiB noise.
  expect(growthBytes).toBeLessThan(2 * 1024 * 1024); // < 2 MiB across 10k blocks
});

test("polySynth process() under sustained load: no heap growth", async () => {
  const { exports, layout } = await instantiate(polySynth);
  exports.prewarm(256);
  // Inject a noteOn into the MIDI ring buffer so the synth is actively
  // generating sound during the test (worst case for allocations).
  const mem = new Float32Array((exports.memory as WebAssembly.Memory).buffer);
  const memU8 = new Uint8Array((exports.memory as WebAssembly.Memory).buffer);
  const memI32 = new Int32Array((exports.memory as WebAssembly.Memory).buffer);
  const midiIn = layout.midiInputs.layouts[0]!;
  const slotPtr = midiIn.slotsOffset;
  memU8[slotPtr] = 0x90;       // status
  memU8[slotPtr + 1] = 60;     // note
  memU8[slotPtr + 2] = 100;    // velocity
  memI32[(slotPtr + 4) >> 2] = 0; // atSample
  memI32[midiIn.headerOffset >> 2] = 1; // head = 1
  if (typeof globalThis.gc === "function") globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 5000; i++) exports.process(128);
  if (typeof globalThis.gc === "function") globalThis.gc();
  const after = process.memoryUsage().heapUsed;
  expect(after - before).toBeLessThan(2 * 1024 * 1024);
});

test("threeBandEQ memory pages bounded", async () => {
  const result = compileToWasm(threeBandEQ, { sampleRate: 48000 });
  // 12 state slots + I/O scratch + ring buffers should fit comfortably.
  expect(result.layout.totalBytes).toBeLessThan(64 * 1024); // < 64 KiB
  expect(result.layout.initialPages).toBe(1);
});
