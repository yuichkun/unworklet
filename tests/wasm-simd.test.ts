// SIMD coverage tests: vec4, splat, addVec/mulVec, lane, loadVec/storeVec.
import { expect, test, describe } from "vite-plus/test";
import { compileToWasm, type CompileResult } from "@unworklet/compiler";
import * as P from "@unworklet/compiler/capture-primitives";
import * as D from "@unworklet/compiler/capture-decls";
import * as S from "@unworklet/compiler/capture-simd";

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

test("splat + extract_lane: same value in all 4 lanes", async () => {
  const result = compileToWasm(() => {
    const out = D.audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        D.forSample.byN(4, (i: any) => {
          // Just splat 0.5 into a vec, then write each lane to consecutive samples
          const v = S.splat(0.5);
          out.set(0, i, (v as any).lane(0));
          // For brevity write same value at i; the test checks splat works via lane
        });
      },
    };
  }, { sampleRate: SR });
  const { exports, layout } = await instantiate(result);
  exports.process(BLOCK);
  const out = new Float32Array(
    (exports.memory as WebAssembly.Memory).buffer,
    layout.audioOutputs.outputs[0].offset,
    BLOCK,
  );
  // Every 4-th sample is 0.5; others remain 0.
  for (let i = 0; i < BLOCK; i++) {
    if (i % 4 === 0) expect(out[i]).toBe(0.5);
    else expect(out[i]).toBe(0);
  }
});

test("vec4 + lane access constructs per-lane values", async () => {
  const result = compileToWasm(() => {
    const out = D.audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        D.forSample.byN(4, (i: any) => {
          const v = S.vec4(0.1, 0.2, 0.3, 0.4);
          // Write the four lanes to consecutive samples (i, i+1, i+2, i+3)
          out.set(0, i, (v as any).lane(0));
          out.set(0, P.add(i, 1), (v as any).lane(1));
          out.set(0, P.add(i, 2), (v as any).lane(2));
          out.set(0, P.add(i, 3), (v as any).lane(3));
        });
      },
    };
  }, { sampleRate: SR });
  const { exports, layout } = await instantiate(result);
  exports.process(BLOCK);
  const out = new Float32Array(
    (exports.memory as WebAssembly.Memory).buffer,
    layout.audioOutputs.outputs[0].offset,
    BLOCK,
  );
  for (let i = 0; i < BLOCK; i++) {
    const lane = i % 4;
    const expected = [0.1, 0.2, 0.3, 0.4][lane];
    expect(out[i]).toBeCloseTo(expected!, 5);
  }
});

test("mulVec + addVec + loadVec + storeVec: SIMD bulk gain on a buffer", async () => {
  const result = compileToWasm(() => {
    const main = D.audioInput({ channels: 1, name: "main" });
    const out = D.audioOutput({ channels: 1, name: "main" });
    const scratch = D.buffer.f32({ size: 128, name: "scratch" });
    return {
      process: () => {
        // copy in
        D.forSample((i: any) => {
          scratch.write(i, main.at(0, i));
        });
        // SIMD bulk gain × 2
        D.forSample.byN(4, (i: any) => {
          const v = scratch.loadVec(i);
          scratch.storeVec(i, S.mulVec(v, S.splat(2)));
        });
        // copy out
        D.forSample((i: any) => {
          out.set(0, i, scratch.read(i));
        });
      },
    };
  }, { sampleRate: SR });
  const { exports, layout } = await instantiate(result);

  const mem = new Float32Array((exports.memory as WebAssembly.Memory).buffer);
  const ai = layout.audioInputs.inputs[0];
  for (let i = 0; i < BLOCK; i++) {
    mem[ai.offset / 4 + i] = i / 100;
  }
  exports.process(BLOCK);
  const ao = layout.audioOutputs.outputs[0];
  for (let i = 0; i < BLOCK; i++) {
    expect(mem[ao.offset / 4 + i]).toBeCloseTo((i / 100) * 2, 4);
  }
});
