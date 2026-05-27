/**
 * Behavioral tests for `makeWorkletNamespace(graph)` — the per-processor
 * function namespace that backs `CompiledProcessor.worklet` (= `01-dsl.md` §11、
 * `04-worklet-runtime.md` §2、 Q80)。
 *
 * In the worklet, the namespace 3 entry points (`initialize` / `process` /
 * `parameterDescriptors`) are wired into a `class extends AudioWorkletProcessor`
 * (either the vite-plugin-emitted template auto-register path, or a
 * user-authored escape-hatch class). Tests stand in for the host by passing a
 * minimal `self` object with a `port.postMessage` collector + the same
 * `inputs` / `outputs` / `parameters` shape that AudioWorkletProcessor.process
 * receives.
 */

import "./dsl/primitives.ts"; // method form (= `.mul`) registration side-effect

import { expect, test } from "vite-plus/test";

import { compile } from "./compile/index.ts";
import { SAMPLES_PER_BLOCK } from "./dsl/constants.ts";
import { audioInput, audioOutput, param } from "./dsl/declarations.ts";
import { forSample } from "./dsl/loop.ts";
import { defineProcessor } from "./processor.ts";

type CollectedMessage = unknown;

type MockSelf = {
  port: {
    postMessage: (m: CollectedMessage) => void;
  };
  messages: CollectedMessage[];
};

const makeMockSelf = (): MockSelf => {
  const messages: CollectedMessage[] = [];
  return {
    port: {
      postMessage: (m: CollectedMessage) => {
        messages.push(m);
      },
    },
    messages,
  };
};

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

const monoGain = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });
  const gain = param.f32({ default: 0.5, min: 0, max: 4, automationRate: "k-rate" }).named("gain");
  return {
    process: () => {
      forSample((i) => {
        out
          .ch(0)
          .at(i)
          .write(input.ch(0).at(i).mul(gain.at(i)));
      });
    },
  };
});

const ioOnly = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });
  return {
    process: () => {
      forSample((i) => {
        out.ch(0).at(i).write(input.ch(0).at(i));
      });
    },
  };
});

test("`parameterDescriptors` reflects declared params (= name / default / min / max / automationRate)", () => {
  expect(stereoGain.worklet.parameterDescriptors).toEqual([
    {
      name: "gain",
      defaultValue: 1,
      minValue: 0,
      maxValue: 4,
      automationRate: "a-rate",
    },
  ]);
});

test("`parameterDescriptors` is empty when no `param` declarations exist", () => {
  expect(ioOnly.worklet.parameterDescriptors).toEqual([]);
});

test("`inputs` / `outputs` reflect declared audioInput / audioOutput ports in declaration order", () => {
  expect(stereoGain.worklet.inputs).toEqual([{ name: "main", channels: 2 }]);
  expect(stereoGain.worklet.outputs).toEqual([{ name: "main", channels: 2 }]);
  expect(monoGain.worklet.inputs).toEqual([{ name: "main", channels: 1 }]);
  expect(monoGain.worklet.outputs).toEqual([{ name: "main", channels: 1 }]);
});

test("`initialize(self, opts)` instantiates WASM and posts a `ready` ack on the port", async () => {
  const { wasm } = await compile(stereoGain);
  const self = makeMockSelf();

  stereoGain.worklet.initialize(self, { processorOptions: { wasm } });

  expect(self.messages).toContainEqual({ kind: "ready" });
});

test("`process(self, ...)` returns true to keep the node alive", async () => {
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });

  const inputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(0.5)]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  const parameters = { gain: new Float32Array([0.5]) };

  const ret = monoGain.worklet.process(self, inputs, outputs, parameters);
  expect(ret).toBe(true);
});

test("`process` runs WASM: input × k-rate gain (length-1 broadcast) = output", async () => {
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });

  const inputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(0.5)]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  // k-rate: length-1, broadcast to every sample
  const parameters = { gain: new Float32Array([2]) };

  monoGain.worklet.process(self, inputs, outputs, parameters);

  const out0 = outputs[0][0]!;
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(out0[i]).toBeCloseTo(1.0);
  }
});

test("`process` runs WASM: input × a-rate gain (length-128 per-sample) = output", async () => {
  const { wasm } = await compile(stereoGain);
  const self = makeMockSelf();
  stereoGain.worklet.initialize(self, { processorOptions: { wasm } });

  const inputCh0 = new Float32Array(SAMPLES_PER_BLOCK).fill(0.5);
  const inputCh1 = new Float32Array(SAMPLES_PER_BLOCK).fill(0.25);
  const gainAutomation = new Float32Array(SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    gainAutomation[i] = i / SAMPLES_PER_BLOCK; // 0 .. ~1
  }
  const inputs = [[inputCh0, inputCh1]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK), new Float32Array(SAMPLES_PER_BLOCK)]];
  const parameters = { gain: gainAutomation };

  stereoGain.worklet.process(self, inputs, outputs, parameters);

  const outCh0 = outputs[0][0]!;
  const outCh1 = outputs[0][1]!;
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(outCh0[i]).toBeCloseTo(0.5 * (i / SAMPLES_PER_BLOCK));
    expect(outCh1[i]).toBeCloseTo(0.25 * (i / SAMPLES_PER_BLOCK));
  }
});

test("`process` fills param view with declared default when host passes length-0 array", async () => {
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });

  const inputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(1)]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  // length-0 = no automation. Default `0.5` from declaration should apply.
  const parameters = { gain: new Float32Array(0) };

  monoGain.worklet.process(self, inputs, outputs, parameters);

  const out0 = outputs[0][0]!;
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(out0[i]).toBeCloseTo(0.5);
  }
});

test("`process` handles a disconnected input port (= empty channel array) as silence", async () => {
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });

  // Disconnected = port has zero channels in `inputs[portIdx]`.
  const inputs = [[]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(99)]];
  const parameters = { gain: new Float32Array([0.5]) };

  monoGain.worklet.process(self, inputs, outputs, parameters);

  const out0 = outputs[0][0]!;
  // Silent input × gain(0.5) = silence.
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(out0[i]).toBeCloseTo(0);
  }
});

test("`process` on block-length mismatch emits silence + posts `block-length-mismatch` error", async () => {
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });
  // Drop the initial ready ack from the collector for clarity.
  const initialMessageCount = self.messages.length;

  // Host hands us a 64-sample block — the runtime guard from
  // `04-worklet-runtime.md` §3 / Q75 should kick in.
  const wrongLen = 64;
  const inputs = [[new Float32Array(wrongLen).fill(1)]];
  const outputs = [[new Float32Array(wrongLen).fill(7)]];
  const parameters = { gain: new Float32Array([0.5]) };

  const ret = monoGain.worklet.process(self, inputs, outputs, parameters);

  expect(ret).toBe(true);
  // Output must be silenced (= zero buffer per Q75).
  const out0 = outputs[0][0]!;
  for (let i = 0; i < wrongLen; i++) {
    expect(out0[i]).toBe(0);
  }
  // Main side should observe the runtime guard event.
  const errorMessages = self.messages.slice(initialMessageCount);
  expect(errorMessages).toContainEqual({
    kind: "error",
    code: "block-length-mismatch",
    expected: SAMPLES_PER_BLOCK,
    received: wrongLen,
  });
});
