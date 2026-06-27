/**
 * Behavior of `compile()` orchestration (= `03-compiler.md` §1, the public
 * entry point that invokes each internal module in stage order).
 *
 * 4-stage wiring:
 *   capturedGraph = processor.graph
 *   diagnostics   = analyze(graph)
 *   memory        = layout(graph)
 *   wasm          = await emit(graph, memory)
 *   schemaHash    = schemaHash(graph)
 *
 * Returns `{ wasm, graph, memory, diagnostics, schemaHash, __compiledProcessor }`
 * conforming to the CompileResult<C> shape.
 */

import { expect, test } from "vite-plus/test";

import "../dsl/primitives.ts"; // side-effect: registers `.mul` and other method forms on Node prototype
import { SAMPLES_PER_BLOCK } from "../dsl/constants.ts";
import { audioInput, audioOutput, param } from "../dsl/declarations.ts";
import { forSample } from "../dsl/loop.ts";
import { defineProcessor } from "../processor.ts";
import type { CapturedGraph } from "./ast.ts";
import { emit } from "./emit.ts";
import { layout } from "./layout.ts";
import { compile, makeDriver } from "./index.ts";

const stereoGain = defineProcessor(() => {
  const input = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const gain = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" }).named("gain");
  return {
    process: () => {
      forSample((i) => {
        out.left.at(i).write(input.left.at(i).mul(gain.at(i)));
        out.right.at(i).write(input.right.at(i).mul(gain.at(i)));
      });
    },
  };
});

test("`compile(processor)` returns a `CompileResult` with all 5 stage outputs", async () => {
  const result = await compile(stereoGain);
  expect(result.wasm).toBeInstanceOf(Uint8Array);
  expect(result.wasm.byteLength).toBeGreaterThan(0);
  expect(result.schemaHash).toMatch(/^[0-9a-f]{32}$/);
  expect(result.diagnostics).toBeDefined();
  expect(result.memory).toBeDefined();
  expect(result.graph).toBeDefined();
});

test("`compile` records the sampleRate it baked at (default 48000, overridable)", async () => {
  const def = await compile(stereoGain);
  expect(def.sampleRate).toBe(48000);
  const at44k = await compile(stereoGain, { sampleRate: 44100 });
  expect(at44k.sampleRate).toBe(44100);
});

test("`compile` orchestration drives stereo-gain processor to memory I/O end-to-end", async () => {
  const { wasm } = await compile(stereoGain);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;

  const inputCh0 = new Float32Array(memory.buffer, 0, 128);
  const inputCh1 = new Float32Array(memory.buffer, 512, 128);
  const gainView = new Float32Array(memory.buffer, 2048, 128);
  inputCh0.fill(1.0);
  inputCh1.fill(0.25);
  gainView.fill(0.5);

  proc();

  const outCh0 = new Float32Array(memory.buffer, 1024, 128);
  const outCh1 = new Float32Array(memory.buffer, 1536, 128);
  for (let i = 0; i < 128; i++) {
    expect(outCh0[i]).toBe(0.5);
    expect(outCh1[i]).toBe(0.125);
  }
});

test("`compile` is deterministic: same processor always produces the same schemaHash", async () => {
  const first = await compile(stereoGain);
  const second = await compile(stereoGain);
  expect(first.schemaHash).toBe(second.schemaHash);
});

// ─────────────────────────────────────────────────────────────────────────
// makeDriver unit tests: exercise each method path on the driver handle in isolation
// ─────────────────────────────────────────────────────────────────────────

const stereoGainGraph: CapturedGraph = {
  declarations: [
    { kind: "audioInput", name: "main", channels: 2 },
    { kind: "audioOutput", name: "main", channels: 2 },
    {
      kind: "param",
      name: "gain",
      type: "f32",
      default: 1,
      min: 0,
      max: 4,
      automationRate: "a-rate",
    },
  ],
  statements: [],
};

test("`makeDriver(...).instantiate()` narrows graph declarations to CompileInstanceDeclaration shape", async () => {
  const lay = layout(stereoGainGraph);
  const wasm = await emit(stereoGainGraph, lay);
  const instance = await makeDriver(stereoGainGraph, lay, wasm).instantiate();
  expect(instance.declarations).toEqual([
    { kind: "audioInput", name: "main", channels: 2 },
    { kind: "audioOutput", name: "main", channels: 2 },
    { kind: "param", name: "gain", default: 1 },
  ]);
});

test("`instance.writeInput(port, channel, block)` writes into `inputs[port] + channel * 512` offset", async () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "audioInput", name: "main", channels: 2 }],
    statements: [],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const instance = await makeDriver(graph, lay, wasm).instantiate();

  const block = new Float32Array(SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) block[i] = i / SAMPLES_PER_BLOCK;
  instance.writeInput("main", 1, block);

  // channel 1 base offset = inputs.main (= 0) + 1 * 512 = 512
  const view = new Float32Array(instance.memory.buffer, 512, SAMPLES_PER_BLOCK);
  expect(view).toEqual(block);
});

test("`instance.writeParam(name, block)` writes into `params[name]` offset", async () => {
  const lay = layout(stereoGainGraph);
  const wasm = await emit(stereoGainGraph, lay);
  const instance = await makeDriver(stereoGainGraph, lay, wasm).instantiate();

  const block = new Float32Array(SAMPLES_PER_BLOCK);
  block.fill(0.75);
  instance.writeParam("gain", block);

  // params.gain offset = 2048 (per stereoGainGraph layout)
  const view = new Float32Array(instance.memory.buffer, 2048, SAMPLES_PER_BLOCK);
  expect(view).toEqual(block);
});

test("`instance.readOutput(port, channel, dest)` reads from `outputs[port] + channel * 512` offset", async () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "audioOutput", name: "main", channels: 2 }],
    statements: [],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const instance = await makeDriver(graph, lay, wasm).instantiate();

  // write directly into memory (outputs.main = 0, channel 1 base = 512)
  const memoryView = new Float32Array(instance.memory.buffer, 512, SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) memoryView[i] = i * 0.01;

  const dest = new Float32Array(SAMPLES_PER_BLOCK);
  instance.readOutput("main", 1, dest);
  expect(dest).toEqual(memoryView);
});

test("`instance.process()` invokes the WASM `process` export (= memory observable side effect)", async () => {
  // verify that a top-level literal write is reflected in memory after process() is called
  const graph: CapturedGraph = {
    declarations: [{ kind: "audioOutput", name: "main", channels: 1 }],
    statements: [
      {
        kind: "audioOutWrite",
        portName: "main",
        channel: 0,
        offset: { kind: "literal", type: "i32", value: 0 },
        value: { kind: "literal", type: "f32", value: 0.42 },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const instance = await makeDriver(graph, lay, wasm).instantiate();
  instance.process();
  const view = new Float32Array(instance.memory.buffer, 0, 1);
  // 0.42 is not exactly representable as f32; use Math.fround to round the expected value
  expect(view[0]).toBe(Math.fround(0.42));
});

test("`compile` rejects when analyze produces error diagnostics and the error message contains a stable ID", async () => {
  // A constant-truthy emitIf inside forSample triggers an error diagnostic from analyze;
  // compile throws before reaching emit, and the message includes the stable diagnostic ID.
  const badProc: CapturedGraph = {
    declarations: [
      {
        kind: "audioOutput",
        name: "out",
        channels: 1,
      },
      {
        kind: "event",
        name: "peak",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [{ name: "level", wireType: "f32" }],
      },
    ],
    statements: [
      {
        kind: "forSample",
        stride: 1,
        body: [
          {
            kind: "eventEmitIf",
            name: "peak",
            cond: { kind: "literal", type: "i32", value: 1 },
            atSample: { kind: "loopCounter" },
            fields: [
              {
                name: "level",
                wireType: "f32",
                value: { kind: "literal", type: "f32", value: 0.5 },
              },
            ],
          },
        ],
      },
    ],
  };
  const fakeProcessor = {
    graph: badProc as unknown,
    schemaHash: "test",
    worklet: {} as never,
    __compiledProcessor: undefined as never,
  } as unknown as Parameters<typeof compile>[0];
  await expect(compile(fakeProcessor)).rejects.toThrow(/constant-truthy-emitif/);
});
