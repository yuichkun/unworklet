// Verify the live-eval runtime in apps/playground/src/codeplayground/runtime.ts
// can take a TypeScript-flavoured `defineProcessor` source string, strip
// imports, and produce a CompiledProcessor that compiles to WASM.
import { describe, expect, test } from "vite-plus/test";
import { evalProcessorSource } from "../src/codeplayground/runtime";

describe("codeplayground runtime", () => {
  test("evals a basic stereo gain processor source", () => {
    const source = `
      import {
        defineProcessor, audioInput, audioOutput, param, forSample, mul,
      } from "@unworklet/core";

      export const myProc = defineProcessor(() => {
        const main = audioInput({ channels: 2, name: "main" });
        const out = audioOutput({ channels: 2, name: "main" });
        const g = param({ name: "gain", default: 1, min: 0, max: 4, automationRate: "a-rate" });
        return {
          process: () => {
            forSample((i) => {
              out.set(0, i, mul(main.at(0, i), g.at(i)));
              out.set(1, i, mul(main.at(1, i), g.at(i)));
            });
          },
        };
      });
    `;
    const r = evalProcessorSource(source);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.processorName).toBe("myProc");
      expect(r.processor).toBeDefined();
    }
  });

  test("surfaces a compile error when the source has a JS-operator-on-node mistake", () => {
    const source = `
      import { defineProcessor, audioInput, audioOutput, state, forSample, mul } from "@unworklet/core";
      export const broken = defineProcessor(() => {
        const main = audioInput({ channels: 1, name: "main" });
        const out = audioOutput({ channels: 1, name: "main" });
        const s = state.f32(0);
        return { process: () => {
          forSample((i) => {
            // / 127 on a graph node — should hit the toPrimitive trap.
            out.set(0, i, mul(s.load() / 127, main.at(0, i)));
          });
        }};
      });
    `;
    const r = evalProcessorSource(source);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot coerce|graph node/i);
  });

  test("error on syntactically invalid source", () => {
    const r = evalProcessorSource("this is not (valid)) ts at all !!");
    expect(r.ok).toBe(false);
  });
});
