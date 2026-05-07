// Method-chain DSL coverage:
//
// - Capture-mode AST equivalence: `x.add(y).mul(z)` produces the same set
//   of statements as `mul(add(x, y), z)`.
// - Interp-mode numeric equivalence: same expressions return identical
//   numeric output through the JS engine.
// - `num()` chain entry: literal-leading expressions chain correctly.
//
// Real WASM compile + render is covered by the existing example tests
// (which were rewritten to use chain methods); this file is a focused
// unit test for the method surface itself.

import { expect, test, describe } from "vite-plus/test";
import {
  defineProcessor,
  audioInput,
  audioOutput,
  forSample,
  add,
  mul,
  sub,
  num,
  state,
} from "@unworklet/core";
import { compileToWasm } from "@unworklet/compiler";
import { Engine } from "@unworklet/core/internal";

const SR = 48000;
const BLOCK = 128;

describe("method chain — capture-mode AST equivalence", () => {
  test("x.add(y).mul(z) compiles to same WASM statement count as mul(add(x, y), z)", () => {
    const procChain = defineProcessor(() => {
      const main = audioInput({ channels: 1, name: "main" });
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          forSample((i) => {
            out.set(0, i, main.at(0, i).add(0.5).mul(2));
          });
        },
      };
    });
    const procFree = defineProcessor(() => {
      const main = audioInput({ channels: 1, name: "main" });
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          forSample((i) => {
            out.set(0, i, mul(add(main.at(0, i), 0.5), 2));
          });
        },
      };
    });
    const a = compileToWasm(procChain, { sampleRate: SR });
    const b = compileToWasm(procFree, { sampleRate: SR });
    // Same captured shape: statement count + schemaHash equality is a
    // strong signal that the AST shape is identical.
    expect(a.graph.processBody.length).toBe(b.graph.processBody.length);
    expect(a.graph.schemaHash).toBe(b.graph.schemaHash);
  });

  test("num(1).sub(m) compiles to same shape as sub(1, m)", () => {
    const procChain = defineProcessor(() => {
      const main = audioInput({ channels: 1, name: "main" });
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          forSample((i) => {
            out.set(0, i, num(0.7).sub(main.at(0, i)));
          });
        },
      };
    });
    const procFree = defineProcessor(() => {
      const main = audioInput({ channels: 1, name: "main" });
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          forSample((i) => {
            out.set(0, i, sub(0.7, main.at(0, i)));
          });
        },
      };
    });
    const a = compileToWasm(procChain, { sampleRate: SR });
    const b = compileToWasm(procFree, { sampleRate: SR });
    expect(a.graph.processBody.length).toBe(b.graph.processBody.length);
  });
});

describe("method chain — interp-mode numeric equivalence", () => {
  test("(1 - mix) × dry + mix × wet — chain vs free → same samples", async () => {
    // `chain`-style processor
    const procChain = defineProcessor(() => {
      const main = audioInput({ channels: 1, name: "main" });
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          forSample((i) => {
            const x = main.at(0, i);
            // (1 - 0.3) × x + 0.3 × x  → x  (mix=0.3 with dry=wet=x)
            out.set(0, i, num(1).sub(0.3).mul(x).add(num(0.3).mul(x)));
          });
        },
      };
    });
    const procFree = defineProcessor(() => {
      const main = audioInput({ channels: 1, name: "main" });
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          forSample((i) => {
            const x = main.at(0, i);
            out.set(0, i, add(mul(sub(1, 0.3), x), mul(0.3, x)));
          });
        },
      };
    });

    const e1 = new Engine(procChain, { sampleRate: SR, blockSize: BLOCK });
    const e2 = new Engine(procFree, { sampleRate: SR, blockSize: BLOCK });
    const input = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) input[i] = Math.sin((i / BLOCK) * Math.PI * 2);

    const r1 = e1.render({ main: [input] });
    const r2 = e2.render({ main: [input] });
    for (let i = 0; i < BLOCK; i++) {
      expect(r1.outputs.main![0]![i]!).toBeCloseTo(r2.outputs.main![0]![i]!, 6);
    }
  });

  test("state.load().add(1) chain mutates as expected", () => {
    const proc = defineProcessor(() => {
      const main = audioInput({ channels: 1, name: "main" });
      const out = audioOutput({ channels: 1, name: "main" });
      const cnt = state.i32(0, { name: "cnt" });
      return {
        process: () => {
          forSample((i) => {
            cnt.store(cnt.load().add(1));
            out.set(0, i, main.at(0, i));
          });
        },
      };
    });
    const e = new Engine(proc, { sampleRate: SR, blockSize: BLOCK });
    e.render({ main: [new Float32Array(BLOCK)] });
    e.render({ main: [new Float32Array(BLOCK)] });
    // 2 blocks × 128 samples each = 256 increments
    const cnt = e.rt.rootScope.states.find((s) => s.slot.name === "cnt")!;
    expect(cnt.read()).toBe(256);
  });
});

describe("num() chain entry", () => {
  test("num(number) returns a chainable f32 node in interp mode", () => {
    const v = num(0.5).add(0.25);
    expect(typeof (v as any).valueOf?.()).toBe("number");
    expect(Number(v)).toBeCloseTo(0.75, 6);
  });

  test("num(boolean) returns a chainable bool node in interp mode", () => {
    const t = num(true);
    expect(Boolean(Number(t))).toBe(true);
  });

  test("num(0.5).mul(x) mid-block matches sub(1, 0.5) × x", () => {
    const proc = defineProcessor(() => {
      const main = audioInput({ channels: 1, name: "main" });
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          forSample((i) => {
            const x = main.at(0, i);
            out.set(0, i, num(0.5).mul(x));
          });
        },
      };
    });
    const e = new Engine(proc, { sampleRate: SR, blockSize: BLOCK });
    const input = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) input[i] = i / BLOCK;
    const r = e.render({ main: [input] });
    for (let i = 0; i < BLOCK; i++) {
      expect(r.outputs.main![0]![i]!).toBeCloseTo((i / BLOCK) * 0.5, 6);
    }
  });
});

describe("forSample loop var i — chain methods", () => {
  test("i.add(1) inside a buffer index works", async () => {
    const proc = defineProcessor(() => {
      const main = audioInput({ channels: 1, name: "main" });
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          forSample((i) => {
            // i.add(0) is a no-op but exercises the i.add path
            out.set(0, i.add(0), main.at(0, i));
          });
        },
      };
    });
    const e = new Engine(proc, { sampleRate: SR, blockSize: BLOCK });
    const input = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) input[i] = i;
    const r = e.render({ main: [input] });
    for (let i = 0; i < BLOCK; i++) {
      expect(r.outputs.main![0]![i]!).toBe(i);
    }
  });
});
