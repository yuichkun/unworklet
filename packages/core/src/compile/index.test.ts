/**
 * Behavior of `compile()` orchestration (= `03-compiler.md` §1、 plan
 * Q-D stage 別 internal module を 順 次 invoke す る public entry)。
 *
 * 4 stage 配 線:
 *   capturedGraph = processor.graph
 *   diagnostics   = analyze(graph)
 *   memory        = layout(graph)
 *   wasm          = await emit(graph, memory)
 *   schemaHash    = schemaHash(graph)
 *
 * 返 す `{ wasm, graph, memory, diagnostics, schemaHash, __compiledProcessor }`
 * は CompileResult<C> shape。
 */

import { expect, test } from "vite-plus/test";

import "../dsl/primitives.ts"; // side-effect = `.mul` method form を Node prototype に 登 録
import { audioInput, audioOutput, param } from "../dsl/declarations.ts";
import { forSample } from "../dsl/loop.ts";
import { defineProcessor } from "../processor.ts";
import { compile } from "./index.ts";

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
  expect(result.schemaHash).toMatch(/^[0-9a-f]{64}$/);
  expect(result.diagnostics).toBeDefined();
  expect(result.memory).toBeDefined();
  expect(result.graph).toBeDefined();
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

test("`compile` is deterministic = 同 processor で 同 schemaHash を 返 す", async () => {
  const first = await compile(stereoGain);
  const second = await compile(stereoGain);
  expect(first.schemaHash).toBe(second.schemaHash);
});
