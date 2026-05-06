// Verify the SIMD codegen path produces bit-equivalent output to a scalar
// reference implementation within FP tolerance — and that f32x4 ops are
// actually present in the emitted binary (so a regression that silently
// disables SIMD doesn't go unnoticed).
import { describe, expect, test } from "vite-plus/test";
import { compileToWasm } from "@unworklet/compiler";
import {
  defineProcessor,
  audioInput,
  audioOutput,
  buffer,
  forSample,
  add,
  mul,
} from "@unworklet/core";
import { splat, mulVec, addVec } from "@unworklet/core/simd";

const SR = 48000;
const BLOCK = 128;
const TAP = 16;

function buildSIMD() {
  return defineProcessor(() => {
    const inp = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const hist = buffer.f32({ size: TAP, name: "hist" });
    const coef = buffer.f32({ size: TAP, name: "coef" });
    return {
      process: () => {
        forSample.byN(4, (i) => {
          let acc = splat(0);
          for (let k = 0; k < TAP; k += 4) {
            const h = hist.loadVec(k);
            const c = coef.loadVec(k);
            acc = addVec(acc, mulVec(h, c));
          }
          const s = add(
            add((acc as any).lane(0), (acc as any).lane(1)),
            add((acc as any).lane(2), (acc as any).lane(3)),
          );
          out.set(0, i, s);
          // Shift hist by 4 — we do it by writing the new sample as the head.
          hist.write(0, inp.at(0, i));
        });
      },
    };
  });
}

function buildScalar() {
  return defineProcessor(() => {
    const inp = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const hist = buffer.f32({ size: TAP, name: "hist" });
    const coef = buffer.f32({ size: TAP, name: "coef" });
    return {
      process: () => {
        forSample.byN(4, (i) => {
          let s: any = mul(0, 0);
          for (let k = 0; k < TAP; k++) {
            s = add(s, mul(hist.read(k), coef.read(k)));
          }
          out.set(0, i, s);
          hist.write(0, inp.at(0, i));
        });
      },
    };
  });
}

async function instantiate(processor: any) {
  const r = compileToWasm(processor, { sampleRate: SR });
  const mod = await WebAssembly.compile(r.binary as any);
  const mathImports = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    tanh: Math.tanh,
    exp: Math.exp,
    log: Math.log,
    pow: Math.pow,
    atan2: Math.atan2,
  };
  const inst = await WebAssembly.instantiate(mod, { math: mathImports });
  const exports = inst.exports as any;
  exports.init();
  // Initialize coef[k] = sin(k) so we have non-trivial values.
  const coefBuf = r.layout.bufferRegion.buffers.find((b) => b.bufferId === 1)!;
  const mem = new Float32Array((exports.memory as WebAssembly.Memory).buffer);
  for (let k = 0; k < TAP; k++) {
    mem[(coefBuf.offset >> 2) + k] = Math.sin(k * 0.3);
  }
  return { exports, layout: r.layout, mem, text: r.text };
}

describe("SIMD parity", () => {
  test("SIMD lowering uses f32x4 ops in the binary text", async () => {
    const { text } = await instantiate(buildSIMD());
    expect(text.includes("f32x4")).toBe(true);
  });

  test("SIMD output matches scalar within 1e-5 over 16 blocks", async () => {
    const simd = await instantiate(buildSIMD());
    const scalar = await instantiate(buildScalar());
    const inLayoutS = simd.layout.audioInputs.inputs[0]!;
    const inLayoutSc = scalar.layout.audioInputs.inputs[0]!;
    const outLayoutS = simd.layout.audioOutputs.outputs[0]!;
    const outLayoutSc = scalar.layout.audioOutputs.outputs[0]!;
    let maxDiff = 0;
    for (let block = 0; block < 16; block++) {
      // Fill input with a chirp.
      for (let i = 0; i < BLOCK; i++) {
        const sample = Math.sin((2 * Math.PI * (220 + block * 10) * i) / SR) * 0.6;
        simd.mem[(inLayoutS.offset >> 2) + i] = sample;
        scalar.mem[(inLayoutSc.offset >> 2) + i] = sample;
      }
      simd.exports.process(BLOCK);
      scalar.exports.process(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        const a = simd.mem[(outLayoutS.offset >> 2) + i]!;
        const b = scalar.mem[(outLayoutSc.offset >> 2) + i]!;
        const d = Math.abs(a - b);
        if (d > maxDiff) maxDiff = d;
      }
    }
    // SIMD reduction order differs from scalar (4-way tree vs left-to-right
    // accumulation), so allow a few ULPs of FP rounding difference.
    expect(maxDiff).toBeLessThan(1e-5);
  });
});
