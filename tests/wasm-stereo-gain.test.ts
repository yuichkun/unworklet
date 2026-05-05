// End-to-end test: capture a stereo-gain processor with capture primitives,
// compile to WASM via binaryen, instantiate WebAssembly, render audio,
// verify output is correct.
import { expect, test, describe } from "vite-plus/test";
import { compileToWasm } from "@unworklet/compiler";
import * as P from "@unworklet/compiler/capture-primitives";
import * as D from "@unworklet/compiler/capture-decls";

test("compiles a tiny processor body to WASM", () => {
  // Just make sure the build completes — doesn't crash, produces valid WASM,
  // and the layout makes sense.
  const result = compileToWasm(
    () => {
      const main = D.audioInput({ channels: 2, name: "main" });
      const out = D.audioOutput({ channels: 2, name: "main" });
      const gain = D.param({
        default: 1.0,
        min: 0,
        max: 4,
        automationRate: "a-rate",
        name: "gain",
      });
      return {
        process: () => {
          D.forSample((i: any) => {
            out.set(0, i, P.mul(main.at(0, i), gain.at(i)));
            out.set(1, i, P.mul(main.at(1, i), gain.at(i)));
          });
        },
      };
    },
    { sampleRate: 48000 },
  );

  expect(result.binary).toBeInstanceOf(Uint8Array);
  expect(result.binary.byteLength).toBeGreaterThan(20);
  expect(result.layout.audioInputs.inputs.length).toBe(1);
  expect(result.layout.audioOutputs.outputs.length).toBe(1);
  expect(result.layout.params.layouts.length).toBe(1);
});

test("instantiates WASM and runs init + process without crashing", async () => {
  const result = compileToWasm(
    () => {
      const main = D.audioInput({ channels: 2, name: "main" });
      const out = D.audioOutput({ channels: 2, name: "main" });
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
            out.set(1, i, P.mul(main.at(1, i), gain.at(i)));
          });
        },
      };
    },
    { sampleRate: 48000 },
  );

  const wasm = await WebAssembly.compile(result.binary);
  const inst = await WebAssembly.instantiate(wasm, {
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
  expect(typeof exports.init).toBe("function");
  expect(typeof exports.process).toBe("function");
  expect(exports.memory).toBeInstanceOf(WebAssembly.Memory);

  // Initialize state region with declared defaults.
  exports.init();

  // Marshal a stereo input + a-rate gain param into linear memory at the
  // layout-defined offsets, then call process.
  const mem = new Float32Array((exports.memory as WebAssembly.Memory).buffer);
  const blockSize = 128;
  const ai = result.layout.audioInputs.inputs[0]!;
  const ao = result.layout.audioOutputs.outputs[0]!;
  const pl = result.layout.params.layouts[0]!;

  // Fill ch0 with sine, ch1 with sine*0.7
  for (let i = 0; i < blockSize; i++) {
    mem[(ai.offset + 0 * ai.channelStride) / 4 + i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.8;
    mem[(ai.offset + 1 * ai.channelStride) / 4 + i] = Math.sin((2 * Math.PI * 660 * i) / 48000) * 0.8;
    mem[pl.offset / 4 + i] = 0.5; // gain
  }

  exports.process(blockSize);

  // Read outputs
  const outL = mem.slice(
    (ao.offset + 0 * ao.channelStride) / 4,
    (ao.offset + 0 * ao.channelStride) / 4 + blockSize,
  );
  const outR = mem.slice(
    (ao.offset + 1 * ao.channelStride) / 4,
    (ao.offset + 1 * ao.channelStride) / 4 + blockSize,
  );

  // gain=0.5; output should be 0.5 * input
  for (let i = 0; i < blockSize; i++) {
    const expectedL = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.8 * 0.5;
    const expectedR = Math.sin((2 * Math.PI * 660 * i) / 48000) * 0.8 * 0.5;
    expect(outL[i]).toBeCloseTo(expectedL, 5);
    expect(outR[i]).toBeCloseTo(expectedR, 5);
  }
});
