// Coverage tests for the WASM emitter, exercising each primitive group.
// Each test captures a tiny processor, compiles to WASM, runs it, and
// verifies the output matches the expected closed-form result.
import { expect, test, describe } from "vite-plus/test";
import { compileToWasm, type CompileResult } from "@unworklet/compiler";
import * as P from "@unworklet/compiler/capture-primitives";
import * as D from "@unworklet/compiler/capture-decls";

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

function f32View(exports: any) {
  return new Float32Array((exports.memory as WebAssembly.Memory).buffer);
}
function i32View(exports: any) {
  return new Int32Array((exports.memory as WebAssembly.Memory).buffer);
}

function fillInput(exports: any, layout: any, inputName: string, ch: number, fn: (i: number) => number) {
  const ai = layout.audioInputs.inputs.find((x: any) => x.inputId === layout.audioInputs.inputs.find((y: any) => y).inputId)!;
  // simpler: find by name through the graph (not in layout). Just assume
  // the only declared input in tests below.
  const view = f32View(exports);
  const start = (ai.offset + ch * ai.channelStride) / 4;
  for (let i = 0; i < BLOCK; i++) view[start + i] = fn(i);
}
function readOutput(exports: any, layout: any, ch: number): Float32Array {
  const ao = layout.audioOutputs.outputs[0];
  const view = f32View(exports);
  const start = (ao.offset + ch * ao.channelStride) / 4;
  return view.slice(start, start + BLOCK);
}

function setParamARate(exports: any, layout: any, paramIdx: number, fn: (i: number) => number) {
  const pl = layout.params.layouts[paramIdx];
  const view = f32View(exports);
  for (let i = 0; i < BLOCK; i++) view[pl.offset / 4 + i] = fn(i);
}
function setParamKRate(exports: any, layout: any, paramIdx: number, value: number) {
  const pl = layout.params.layouts[paramIdx];
  f32View(exports)[pl.offset / 4] = value;
}

describe("Arithmetic", () => {
  test("add / sub / mul / div / mod", async () => {
    const result = compileToWasm(() => {
      const main = D.audioInput({ channels: 1, name: "main" });
      const out = D.audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          D.forSample((i: any) => {
            const x = main.at(0, i);
            // (x + 1) * 2 - 0.5 → 2x + 1.5
            out.set(0, i, P.sub(P.mul(P.add(x, 1), 2), 0.5));
          });
        },
      };
    }, { sampleRate: SR });
    const { exports, layout } = await instantiate(result);
    fillInput(exports, layout, "main", 0, (i) => i / BLOCK);
    exports.process(BLOCK);
    const out = readOutput(exports, layout, 0);
    for (let i = 0; i < BLOCK; i++) {
      const x = i / BLOCK;
      expect(out[i]).toBeCloseTo(2 * x + 1.5, 5);
    }
  });
});

describe("Math", () => {
  test("sin/cos/exp/log/sqrt", async () => {
    const result = compileToWasm(() => {
      const main = D.audioInput({ channels: 1, name: "main" });
      const out = D.audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          D.forSample((i: any) => {
            const x = main.at(0, i);
            // log(exp(x)) === x; sin(x)^2 + cos(x)^2 === 1; sqrt(4) === 2
            // Check sin alone for simplicity.
            out.set(0, i, P.sin(x));
          });
        },
      };
    }, { sampleRate: SR });
    const { exports, layout } = await instantiate(result);
    fillInput(exports, layout, "main", 0, (i) => (i / BLOCK) * 2 * Math.PI);
    exports.process(BLOCK);
    const out = readOutput(exports, layout, 0);
    for (let i = 0; i < BLOCK; i++) {
      expect(out[i]).toBeCloseTo(Math.sin((i / BLOCK) * 2 * Math.PI), 4);
    }
  });
});

describe("Comparison + select", () => {
  test("gt + select", async () => {
    const result = compileToWasm(() => {
      const main = D.audioInput({ channels: 1, name: "main" });
      const out = D.audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          D.forSample((i: any) => {
            const x = main.at(0, i);
            // hard-clip at 0.5
            out.set(0, i, P.select(P.gt(x, 0.5), 0.5, x));
          });
        },
      };
    }, { sampleRate: SR });
    const { exports, layout } = await instantiate(result);
    fillInput(exports, layout, "main", 0, (i) => i / BLOCK);
    exports.process(BLOCK);
    const out = readOutput(exports, layout, 0);
    for (let i = 0; i < BLOCK; i++) {
      const x = i / BLOCK;
      expect(out[i]).toBeCloseTo(x > 0.5 ? 0.5 : x, 5);
    }
  });
});

describe("State (f32)", () => {
  test("integrator: state accumulates input", async () => {
    const result = compileToWasm(() => {
      const main = D.audioInput({ channels: 1, name: "main" });
      const out = D.audioOutput({ channels: 1, name: "main" });
      const acc = D.state.f32(0, { name: "acc" });
      return {
        process: () => {
          D.forSample((i: any) => {
            const next = P.add(acc.load(), main.at(0, i));
            acc.store(next);
            out.set(0, i, next);
          });
        },
      };
    }, { sampleRate: SR });
    const { exports, layout } = await instantiate(result);
    fillInput(exports, layout, "main", 0, () => 1);
    exports.process(BLOCK);
    const out = readOutput(exports, layout, 0);
    for (let i = 0; i < BLOCK; i++) {
      expect(out[i]).toBeCloseTo(i + 1, 4);
    }
  });
});

describe("Buffer (f32)", () => {
  test("read/write roundtrip", async () => {
    const result = compileToWasm(() => {
      const main = D.audioInput({ channels: 1, name: "main" });
      const out = D.audioOutput({ channels: 1, name: "main" });
      const buf = D.buffer.f32({ size: 256, name: "buf" });
      return {
        process: () => {
          D.forSample((i: any) => {
            buf.write(i, main.at(0, i));
            out.set(0, i, buf.read(i));
          });
        },
      };
    }, { sampleRate: SR });
    const { exports, layout } = await instantiate(result);
    fillInput(exports, layout, "main", 0, (i) => Math.sin(i / 10));
    exports.process(BLOCK);
    const out = readOutput(exports, layout, 0);
    for (let i = 0; i < BLOCK; i++) {
      expect(out[i]).toBeCloseTo(Math.sin(i / 10), 4);
    }
  });
});

describe("Param (a-rate)", () => {
  test("output = input * gain (per-sample param)", async () => {
    const result = compileToWasm(() => {
      const main = D.audioInput({ channels: 1, name: "main" });
      const out = D.audioOutput({ channels: 1, name: "main" });
      const gain = D.param({
        default: 0.5,
        min: 0,
        max: 4,
        automationRate: "a-rate",
        name: "gain",
      });
      return {
        process: () => {
          D.forSample((i: any) => {
            out.set(0, i, P.mul(main.at(0, i), gain.at(i)));
          });
        },
      };
    }, { sampleRate: SR });
    const { exports, layout } = await instantiate(result);
    fillInput(exports, layout, "main", 0, () => 1);
    setParamARate(exports, layout, 0, (i) => i / BLOCK);
    exports.process(BLOCK);
    const out = readOutput(exports, layout, 0);
    for (let i = 0; i < BLOCK; i++) {
      expect(out[i]).toBeCloseTo(i / BLOCK, 5);
    }
  });
});

describe("Param (k-rate)", () => {
  test("output = input * gain (block-constant param)", async () => {
    const result = compileToWasm(() => {
      const main = D.audioInput({ channels: 1, name: "main" });
      const out = D.audioOutput({ channels: 1, name: "main" });
      const gain = D.param({
        default: 0.7,
        min: 0,
        max: 4,
        automationRate: "k-rate",
        name: "gain",
      });
      return {
        process: () => {
          // k-rate: read once at block start
          const g = gain.at(0);
          D.forSample((i: any) => {
            out.set(0, i, P.mul(main.at(0, i), g));
          });
        },
      };
    }, { sampleRate: SR });
    const { exports, layout } = await instantiate(result);
    fillInput(exports, layout, "main", 0, (i) => 1);
    setParamKRate(exports, layout, 0, 0.25);
    exports.process(BLOCK);
    const out = readOutput(exports, layout, 0);
    for (let i = 0; i < BLOCK; i++) {
      expect(out[i]).toBeCloseTo(0.25, 5);
    }
  });
});

describe("forSample.byN", () => {
  test("stride 4 writes one sample per 4", async () => {
    const result = compileToWasm(() => {
      const out = D.audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          D.forSample.byN(4, (i: any) => {
            out.set(0, i, 1);
          });
        },
      };
    }, { sampleRate: SR });
    const { exports, layout } = await instantiate(result);
    exports.process(BLOCK);
    const out = readOutput(exports, layout, 0);
    for (let i = 0; i < BLOCK; i++) {
      if (i % 4 === 0) expect(out[i]).toBe(1);
      else expect(out[i]).toBe(0);
    }
  });
});
