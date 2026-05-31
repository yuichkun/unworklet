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

import { expect, test, vi } from "vite-plus/test";

import { compile } from "./compile/index.ts";
import { CAPACITY_16, SAMPLES_PER_BLOCK } from "./dsl/constants.ts";
import { f32, num } from "./dsl/constructors.ts";
import {
  audioInput,
  audioOutput,
  buffer,
  event,
  message,
  param,
  state,
} from "./dsl/declarations.ts";
import { forSample } from "./dsl/loop.ts";
import { defineProcessor } from "./processor.ts";

type CollectedMessage = unknown;

type PortListener = (event: MessageEvent) => void;

type MockSelf = {
  port: {
    postMessage: (m: CollectedMessage) => void;
    addEventListener: (kind: string, fn: PortListener) => void;
    start: () => void;
    __listeners: PortListener[];
    __startCalled: boolean;
  };
  messages: CollectedMessage[];
};

const makeMockSelf = (): MockSelf => {
  const messages: CollectedMessage[] = [];
  const listeners: PortListener[] = [];
  const self: MockSelf = {
    port: {
      postMessage: (m: CollectedMessage) => {
        messages.push(m);
      },
      addEventListener: (kind: string, fn: PortListener) => {
        if (kind === "message") listeners.push(fn);
      },
      start: () => {
        self.port.__startCalled = true;
      },
      __listeners: listeners,
      __startCalled: false,
    },
    messages,
  };
  return self;
};

// Helper to fire a port.message event into all registered listeners (= simulates
// `port.postMessage(...)` from main into the worklet's listener path).
const firePortMessage = (self: MockSelf, data: unknown): void => {
  for (const listener of self.port.__listeners) {
    listener({ data } as MessageEvent);
  }
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

test("`eventRings` is empty when no `event<T>` declarations exist", () => {
  expect(stereoGain.worklet.eventRings).toEqual([]);
});

test("`messageRings` is empty when no `message<T>` declarations exist", () => {
  expect(stereoGain.worklet.messageRings).toEqual([]);
});

test("`messageRings` reflects declared `message<T>` per-message ringbuffer descriptor", () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    message<{ slot: number }>({ name: "preset", capacity: 16 });
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(0);
        });
      },
    };
  });
  expect(proc.worklet.messageRings).toEqual([
    {
      name: "preset",
      wasmRingBase: 512,
      capacity: 16,
      // fields = [] (= onReceive ナ シ で 未 seal、 slot size = 0)、 1 番 目 onReceive
      // 走 っ た 時 に capture proxy で fields 確 定。
      slotSize: 0,
      fields: [],
    },
  ]);
});

test("`eventRings` reflects declared `event<T>` per-event ringbuffer descriptor", () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    const peakEvt = event<{ level: number }>({ name: "peak", capacity: 16 });
    return {
      process: () => {
        forSample((i) => {
          peakEvt.emitIf(true, { atSample: i, level: 0.5 });
          out.ch(0).at(i).write(0);
        });
      },
    };
  });
  expect(proc.worklet.eventRings).toEqual([
    {
      name: "peak",
      wasmRingBase: 512, // ioScratch 末 尾 (= 1 ch × 128 sample × 4 byte = 512)
      capacity: 16,
      slotSize: 8,
      fields: [
        { name: "atSample", wireType: "i32", offsetInSlot: 0, byteSize: 4 },
        { name: "level", wireType: "f32", offsetInSlot: 4, byteSize: 4 },
      ],
    },
  ]);
});

test("`initialize(self, opts)` instantiates WASM and posts a `ready` ack on the port", async () => {
  const { wasm } = await compile(stereoGain);
  const self = makeMockSelf();

  stereoGain.worklet.initialize(self, { processorOptions: { wasm } });

  expect(self.messages).toContainEqual({ kind: "ready" });
});

test("`process(self, ...)` reuses pre-bound memory views across consecutive calls", async () => {
  // Audio-thread invariant (00-foundations.md §5.1) = no Float32Array
  // allocation inside the per-quantum hot path。 `initialize` pre-binds one
  // view per (port, channel) and per param、 reused on every render。 If a
  // future change rebinds a view inside `process()` (e.g. via a typo that
  // re-creates one against `memory.buffer`)、 the second call's output will
  // diverge because the underlying ArrayBuffer view would re-read scratch
  // memory that already holds the previous block's residue。 This test
  // pins the deterministic "two identical inputs → two identical outputs"
  // contract that view reuse guarantees。
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });

  const input = new Float32Array(SAMPLES_PER_BLOCK).fill(0.5);
  const inputs = [[input]];
  const outputsA = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  const outputsB = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  const parameters = { gain: new Float32Array([2]) };

  monoGain.worklet.process(self, inputs, outputsA, parameters);
  monoGain.worklet.process(self, inputs, outputsB, parameters);

  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(outputsB[0][0]![i]).toBeCloseTo(outputsA[0][0]![i]!);
    expect(outputsB[0][0]![i]).toBeCloseTo(1.0);
  }
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

test("`process` on path-β escape hatch with missing `initialize(self, opts)` posts `worklet-initialize-not-called` exactly once", async () => {
  // Path β = user-authored `class extends AudioWorkletProcessor` whose
  // constructor forgot to invoke `def.worklet.initialize(this, opts)`
  // (= Q80 documents this as the worklet-initialize-not-called runtime
  // error path)。 The audio thread cannot throw, so the runtime posts a
  // structured event once and then continues emitting silence。
  const self = makeMockSelf();
  // Note: NO `initialize(...)` call — emulates the path-β bug。
  const inputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(1)]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(99)]];
  const parameters = { gain: new Float32Array([0.5]) };

  const ret = monoGain.worklet.process(self, inputs, outputs, parameters);

  expect(ret).toBe(true);
  // Silenced (= no throw on the audio thread)。
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(outputs[0][0]![i]).toBe(0);
  }
  expect(self.messages).toContainEqual({
    kind: "error",
    code: "worklet-initialize-not-called",
  });

  // Subsequent quanta keep emitting silence without re-posting the event。
  outputs[0][0]!.fill(99);
  monoGain.worklet.process(self, inputs, outputs, parameters);
  const initEvents = self.messages.filter(
    (m): m is { kind: string; code: string } =>
      typeof m === "object" &&
      m !== null &&
      (m as { code?: unknown }).code === "worklet-initialize-not-called",
  );
  expect(initEvents).toHaveLength(1);
});

test("`process` catches WASM trap inside state.process() and posts `wasm-trap` + emits silence", async () => {
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });
  const initialMessageCount = self.messages.length;

  // Inject a trap by replacing the WASM `process` function on the state
  // with one that throws — emulates how WebAssembly.RuntimeError would
  // surface from an out-of-bounds memory access or unreachable instruction。
  type SelfWithState = { [k: symbol]: { process: () => void; failed: boolean } };
  const stateBag = self as unknown as SelfWithState;
  const stateKey = Object.getOwnPropertySymbols(stateBag).find(
    (s) => s.description === "unworklet.workletState",
  )!;
  const state = stateBag[stateKey]!;
  state.process = () => {
    throw new Error("RuntimeError: out of bounds memory access");
  };

  const inputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(0.5)]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(99)]];
  const parameters = { gain: new Float32Array([1]) };

  const ret = monoGain.worklet.process(self, inputs, outputs, parameters);

  expect(ret).toBe(true);
  // Silenced (= 00-foundations.md §5.1 invariant 3 + 05-client.md §4)。
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(outputs[0][0]![i]).toBe(0);
  }
  const errorMessages = self.messages.slice(initialMessageCount);
  expect(errorMessages).toHaveLength(1);
  expect(errorMessages[0]).toMatchObject({
    kind: "error",
    code: "wasm-trap",
    message: expect.stringContaining("out of bounds"),
  });

  // Subsequent quanta keep emitting silence WITHOUT re-posting wasm-trap
  // (= node stays connected with silence output, single failure event)。
  outputs[0][0]!.fill(99);
  monoGain.worklet.process(self, inputs, outputs, parameters);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(outputs[0][0]![i]).toBe(0);
  }
  const errorMessagesAfter = self.messages.slice(initialMessageCount);
  expect(errorMessagesAfter).toHaveLength(1);
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

  // docs/04-worklet-runtime.md §3 + §8 + Q75 = uniform "silence on every
  // quantum after first detection, until disposed"。 A subsequent quantum
  // where the host returns to SAMPLES_PER_BLOCK must STILL emit silence
  // (= node is permanently silenced + connected, not transiently)。
  const goodInputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(1)]];
  const goodOutputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(99)]];
  monoGain.worklet.process(self, goodInputs, goodOutputs, parameters);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(goodOutputs[0][0]![i]).toBe(0);
  }
  // And no second `block-length-mismatch` event is posted (= single
  // event for the lifetime of the node, exact same shape as wasm-trap)。
  const errorMessagesAfter = self.messages.slice(initialMessageCount);
  expect(errorMessagesAfter).toHaveLength(1);
});

test("`initialize` without `processorOptions.module` or `.wasm` posts a structured init-error", async () => {
  // Cover the `if (!wasmModule) throw new Error(...)` branch inside the
  // initialize try/catch = path β author hands an empty processorOptions
  // or the path α emit is somehow corrupted。 The audio thread must not
  // throw; init-error is posted instead。
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: {} });
  const errorMessages = self.messages.filter(
    (m): m is { kind: string; message: string } =>
      typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "init-error",
  );
  expect(errorMessages).toHaveLength(1);
  expect(errorMessages[0]!.message).toMatch(/processorOptions\.module/);
});

test("`process` with no input port connected (= empty inputs[port]) emits silence cleanly", async () => {
  // Cover the `inputs[portIdx] ?? []` fallback branch in process()。
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });
  // Host hands us a length-0 outer array → portInput defaults to []。
  const inputs: Float32Array[][] = [];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(7)]];
  const parameters = { gain: new Float32Array([2]) };
  monoGain.worklet.process(self, inputs, outputs, parameters);
  // Silent input × gain = silence (verified independently in another test);
  // here we just confirm the path executes without throwing。
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(outputs[0][0]![i]).toBeCloseTo(0);
  }
});

test("`process` skips output channels the host did not provide", async () => {
  // Cover the `if (dest)` false branch in the output marshal loop。
  const { wasm } = await compile(stereoGain);
  const self = makeMockSelf();
  stereoGain.worklet.initialize(self, { processorOptions: { wasm } });
  const inputs = [
    [new Float32Array(SAMPLES_PER_BLOCK).fill(1), new Float32Array(SAMPLES_PER_BLOCK).fill(1)],
  ];
  // Provide only 1 channel of output where the processor declares 2 — the
  // missing channel slot is `undefined` and must be skipped without throwing。
  const outputs: Float32Array[][] = [[new Float32Array(SAMPLES_PER_BLOCK).fill(0)]];
  const parameters = { gain: new Float32Array([1]) };
  expect(() => stereoGain.worklet.process(self, inputs, outputs, parameters)).not.toThrow();
});

test("`initialize` catches arbitrary throws inside the WASM boot path and posts init-error", async () => {
  // Cover the outer catch in `initialize` for non-trivial throws (= e.g.
  // a corrupt module that surfaces during instance construction)。
  const self = makeMockSelf();
  // A `WebAssembly.Module`-shaped fake whose `instance` construction
  // throws — exercises the catch path post-`!wasmModule` check。
  const corruptModule = {} as unknown as WebAssembly.Module;
  // Stub WebAssembly.Instance to throw when this corrupt module flows
  // through。
  const originalInstance = WebAssembly.Instance;
  (WebAssembly as { Instance: unknown }).Instance = function FakeInstance(
    _mod: WebAssembly.Module,
  ): never {
    throw new Error("link error: missing import 'env.process'");
  } as unknown as typeof WebAssembly.Instance;
  try {
    monoGain.worklet.initialize(self, { processorOptions: { module: corruptModule } });
  } finally {
    (WebAssembly as { Instance: unknown }).Instance = originalInstance;
  }
  const initErrors = self.messages.filter(
    (m): m is { kind: string; message: string } =>
      typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "init-error",
  );
  expect(initErrors).toHaveLength(1);
  expect(initErrors[0]!.message).toMatch(/link error/);
});

test("`initialize` catches non-Error throws (e.g. a string) and stringifies them into init-error", async () => {
  // Cover the `err instanceof Error ? err.message : String(err)` non-Error
  // branch in `errorMessage`。 Throwing a primitive from inside the boot path
  // (= unusual but legal in JS) must still surface a structured init-error
  // with a string `message` field。
  const self = makeMockSelf();
  const corruptModule = {} as unknown as WebAssembly.Module;
  const originalInstance = WebAssembly.Instance;
  (WebAssembly as { Instance: unknown }).Instance = function FakeInstance(
    _mod: WebAssembly.Module,
  ): never {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw "raw-string-from-instance";
  } as unknown as typeof WebAssembly.Instance;
  try {
    monoGain.worklet.initialize(self, { processorOptions: { module: corruptModule } });
  } finally {
    (WebAssembly as { Instance: unknown }).Instance = originalInstance;
  }
  const initErrors = self.messages.filter(
    (m): m is { kind: string; message: string } =>
      typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "init-error",
  );
  expect(initErrors).toHaveLength(1);
  expect(initErrors[0]!.message).toBe("raw-string-from-instance");
});

test("`initialize(self)` without an opts argument defaults to {} and posts init-error", async () => {
  // Cover the `args[1] ?? {}` fallback in initialize。 Path β escape hatches
  // could omit the second argument entirely (e.g. a class constructor that
  // forwards `super()` without re-passing options)。 The runtime must treat
  // missing opts as an empty bag and surface the standard init-error rather
  // than throwing on the audio thread。
  const self = makeMockSelf();
  (monoGain.worklet.initialize as (s: unknown) => void)(self);
  const initErrors = self.messages.filter(
    (m): m is { kind: string; message: string } =>
      typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "init-error",
  );
  expect(initErrors).toHaveLength(1);
  expect(initErrors[0]!.message).toMatch(/processorOptions\.module/);
});

test("`process` handles a missing output port (= outputs outer array shorter than declared) without throwing", async () => {
  // Cover the `outputs[portIdx] ?? []` fallback in the output marshal loop。
  // A misbehaving host (= test harness, or a non-conformant engine) may hand
  // us an outputs array shorter than the declared number of output ports。
  // The audio-thread invariant forbids throwing, so the marshal loop must
  // silently no-op over the missing port (= `portOutput` defaults to `[]`、
  // `dest` is undefined, `if (dest)` is skipped)。
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });
  const inputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(0.5)]];
  // Host hands us an empty outputs outer array even though monoGain declares
  // 1 output port = `outputs[0]` is undefined → `?? []` kicks in。
  const outputs: Float32Array[][] = [];
  const parameters = { gain: new Float32Array([1]) };
  expect(() => monoGain.worklet.process(self, inputs, outputs, parameters)).not.toThrow();
});

// ─────────────────────────────────────────────────────────────────────────
// publish copy logic (= sub-phase 7.4 = worklet template が WASM publish slot
// を 共 有 buffer に copy)。 SAB mode (= Atomics.store) と postMessage fallback
// (= 直接 view write) 両 path + 「version 同 値 で skip」 path を 担 保。
// ─────────────────────────────────────────────────────────────────────────

import { state as stateDecl } from "./dsl/declarations.ts";

const publishProc = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });
  const meter = stateDecl.f32(0).expose({ name: "meter", publish: { rateFps: 30 } });
  return {
    process: () => {
      forSample((i) => {
        out.ch(0).at(i).write(input.ch(0).at(i));
      });
      meter.write(input.ch(0).at(0));
    },
  };
});

test("publish copy (sab mode): WASM 末 尾 で due tick が SAB に Atomics.store 経 由 で copy", async () => {
  const { wasm } = await compile(publishProc, { sampleRate: 48000 });
  const self = makeMockSelf();
  const publishBuffer = new SharedArrayBuffer(12); // 1 slot × 12 byte
  publishProc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      publishBuffer,
      publishSlots: publishProc.worklet.publishSlots,
      transport: "sab",
    },
  });

  // threshold = round(48000 / 30) = 1600、 13 block で 1664 ≥ 1600 = due
  const input = new Float32Array(SAMPLES_PER_BLOCK).fill(0.5);
  const inputs = [[input]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  for (let b = 0; b < 13; b++) {
    publishProc.worklet.process(self, inputs, outputs, {});
  }
  const view = new Int32Array(publishBuffer);
  // valueBits: f32 0.5 を i32 bit pattern として 読 ん だ 値
  const valueBits = new Int32Array(new Float32Array([0.5]).buffer)[0]!;
  expect(view[0]).toBe(valueBits);
  expect(view[1]).toBe(64); // sample counter 残 り = 1664 - 1600
  expect(view[2]).toBe(1); // version
});

test("publish copy (postMessage fallback): port.postMessage で 個 別 配 送 (= publishBuffer な し)", async () => {
  // postMessage path = publishBuffer な し (= structured clone で main / worklet
  // が 別 instance に な る た め mirror 不 能、 worklet 側 が port.postMessage で
  // 通 知 す る 経 路)。 self.messages に { kind: 'publish', ... } が 1 件 入 る
  // こ と を 確 認。
  const { wasm } = await compile(publishProc, { sampleRate: 48000 });
  const self = makeMockSelf();
  publishProc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      publishSlots: publishProc.worklet.publishSlots,
      transport: "postMessage",
    },
  });
  // initialize 末 尾 の `ready` ack を consume = publish message だ け を assert す
  // る path。
  self.messages.length = 0;

  const input = new Float32Array(SAMPLES_PER_BLOCK).fill(0.5);
  const inputs = [[input]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  for (let b = 0; b < 13; b++) {
    publishProc.worklet.process(self, inputs, outputs, {});
  }
  // 13 block で counter 1664 ≥ threshold 1600 = 1 度 due tick で publish 配 送
  const publishMessages = self.messages.filter(
    (m): m is { kind: string; slotIndex: number; valueBits: number; version: number } =>
      typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "publish",
  );
  expect(publishMessages.length).toBe(1);
  expect(publishMessages[0]!.slotIndex).toBe(0);
  const valueBits = new Int32Array(new Float32Array([0.5]).buffer)[0]!;
  expect(publishMessages[0]!.valueBits).toBe(valueBits);
  expect(publishMessages[0]!.version).toBe(1);
});

test("publish copy: not due block で view 不 変 (= skip path)", async () => {
  const { wasm } = await compile(publishProc, { sampleRate: 48000 });
  const self = makeMockSelf();
  const publishBuffer = new SharedArrayBuffer(12);
  publishProc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      publishBuffer,
      publishSlots: publishProc.worklet.publishSlots,
      transport: "sab",
    },
  });

  // 12 block = counter 1536 < 1600 = not due
  const input = new Float32Array(SAMPLES_PER_BLOCK).fill(0.5);
  const inputs = [[input]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  for (let b = 0; b < 12; b++) {
    publishProc.worklet.process(self, inputs, outputs, {});
  }
  const view = new Int32Array(publishBuffer);
  expect(view[2]).toBe(0); // version 未 更 新
  expect(view[0]).toBe(0); // value 未 copy
});

test("publish copy: publishBuffer ナ シ processor は publish path skip (= regression)", async () => {
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });
  const inputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(0.5)]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  const parameters = { gain: new Float32Array([2]) };
  expect(() => monoGain.worklet.process(self, inputs, outputs, parameters)).not.toThrow();
});

// ─────────────────────────────────────────────────────────────────────────
// event ring SAB copy (= sub-phase 7.6 commit 5c)。 audio thread が emit
// (= WASM 内 ring に slot fill + head++) → worklet template が per-quantum
// 末 尾 で SAB ring に bulk copy + Atomics.store(head / tail / overflow)。 main
// 側 が SAB から read で 期 待 値 取 れ る path を 担 保。
// ─────────────────────────────────────────────────────────────────────────

const eventEmitProc = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });
  // gate state を 毎 quantum 開 始 で true に set + stateLoad を cond で 使 う =
  // Q32-c (= constant-truthy) を 構 文 上 回 避 + 動 的 fire path (= analyze pass)。
  const gate = stateDecl.named("gate").bool(true);
  const peakEvt = event<{ level: number }>({ name: "peak", capacity: 16 });
  return {
    process: () => {
      gate.write(true);
      forSample((i) => {
        peakEvt.emitIf(gate.read(), { atSample: i, level: 0.5 });
        out.ch(0).at(i).write(input.ch(0).at(i));
      });
    },
  };
});

test("event ring copy (sab mode): WASM emit → SAB に header + slot を Atomics 反映", async () => {
  const { wasm } = await compile(eventEmitProc);
  const self = makeMockSelf();
  const ring = eventEmitProc.worklet.eventRings[0]!;
  const ringTotalBytes = 12 + ring.capacity * ring.slotSize;
  const eventRingsBuffer = new SharedArrayBuffer(ringTotalBytes);
  eventEmitProc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      eventRingsBuffer,
      eventRings: eventEmitProc.worklet.eventRings,
      eventRingSabOffsets: [0],
      transport: "sab",
    },
  });
  const input = new Float32Array(SAMPLES_PER_BLOCK).fill(0.25);
  const inputs = [[input]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  eventEmitProc.worklet.process(self, inputs, outputs, {});

  const headView = new Int32Array(eventRingsBuffer, 0, 3);
  // capacity 16 + 128 emit → drop-oldest 連 発、 head = 128、 tail = 128 - 16 = 112、
  // overflowCount = 128 - 16 = 112
  expect(Atomics.load(headView, 0)).toBe(128); // head
  expect(Atomics.load(headView, 1)).toBe(112); // tail
  expect(Atomics.load(headView, 2)).toBe(112); // overflowCount

  // slot 0 = 最 後 に 書 か れ た emit の slot (= 128 % 16 = 0)、 ま た は 117 % 16 = 5...
  // 最 後 128 個 目 emit (= atSample = 127) は slot 127 % 16 = 15 に 書 か れ る。
  // slot 15 を 読 む = atSample 127 / level 0.5
  const slotsView = new DataView(eventRingsBuffer, 12);
  expect(slotsView.getInt32(15 * 8, true)).toBe(127); // atSample
  expect(slotsView.getFloat32(15 * 8 + 4, true)).toBe(0.5); // level
});

test("event ring copy (postMessage fallback): port.postMessage で 新 emit 分 配 送 (= eventRingsBuffer な し)", async () => {
  // postMessage path = eventRingsBuffer な し (= structured clone で main / worklet
  // が 別 instance に な る た め mirror 不 能、 worklet 側 が port.postMessage で
  // 個 別 配 送)。 self.messages に { kind: 'event', ringIndex, newSlotsBytes,
  // newSlotCount, overflowCount } が 入 る こ と を 確 認。
  const { wasm } = await compile(eventEmitProc);
  const self = makeMockSelf();
  eventEmitProc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      eventRings: eventEmitProc.worklet.eventRings,
      eventRingSabOffsets: [0],
      transport: "postMessage",
    },
  });
  self.messages.length = 0;

  const inputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(0.25)]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  eventEmitProc.worklet.process(self, inputs, outputs, {});

  const eventMessages = self.messages.filter(
    (
      m,
    ): m is {
      kind: string;
      ringIndex: number;
      newSlotCount: number;
      overflowCount: number;
    } => typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "event",
  );
  expect(eventMessages.length).toBe(1);
  expect(eventMessages[0]!.ringIndex).toBe(0);
  // 128 emit / capacity 16 = drop-oldest 連 発、 最 後 16 slot 分 が ring に 残 る、
  // 配 送 さ れ る の は currentTail .. currentHead の 16 slot 分 (= overflow 分 は skip)
  expect(eventMessages[0]!.newSlotCount).toBe(16);
  expect(eventMessages[0]!.overflowCount).toBe(112); // 128 - 16
});

test("event ring copy: eventRingsBuffer ナ シ processor は event path skip (= regression)", async () => {
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });
  const inputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(0.5)]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  const parameters = { gain: new Float32Array([2]) };
  expect(() => monoGain.worklet.process(self, inputs, outputs, parameters)).not.toThrow();
});

// ─────────────────────────────────────────────────────────────────────────
// message ring mirror (= sub-phase 7.7d)。 main が SAB に push し た slot を
// worklet template が per-quantum 開 始 で WASM memory ring に mirror + WASM
// 内 で drain logic が 走 る (= sub-phase 7.7c)、 drain 末 尾 で worklet が
// WASM tail を SAB tail に commit (= main 側 で drain 観 測 可)。
// ─────────────────────────────────────────────────────────────────────────

const messageRecvProc = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "out" });
  const captured = stateDecl.named("captured").i32(0);
  const ctrl = message<{ slot: number }>({ name: "ctrl", capacity: 16 });
  return {
    process: () => {
      ctrl.onReceive(({ slot }) => {
        captured.write(slot);
      });
      forSample((i) => {
        out.ch(0).at(i).write(0);
      });
    },
  };
});

test("message ring mirror (sab mode): main が SAB push → process で WASM ring に mirror + drain で state 反 映", async () => {
  const { wasm } = await compile(messageRecvProc);
  const self = makeMockSelf();
  const ring = messageRecvProc.worklet.messageRings[0]!;
  const ringTotalBytes = 12 + ring.capacity * ring.slotSize;
  const messageRingsBuffer = new SharedArrayBuffer(ringTotalBytes);
  messageRecvProc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      messageRingsBuffer,
      messageRings: messageRecvProc.worklet.messageRings,
      messageRingSabOffsets: [0],
      transport: "sab",
    },
  });
  // main 側 push を simulate: SAB に slot 0 = 42 push + head = 1 Atomics.store
  const headerView = new Int32Array(messageRingsBuffer, 0, 3);
  const slotsView = new Int32Array(messageRingsBuffer, 12);
  slotsView[0] = 42;
  Atomics.store(headerView, 0, 1); // head = 1
  const inputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  messageRecvProc.worklet.process(self, inputs, outputs, {});
  // drain 後 SAB tail も head に commit
  expect(Atomics.load(headerView, 1)).toBe(1);
});

test("message ring mirror (sab mode): head の acquire-load を slot コピー より 前 に 行 う (= 02-messaging §5.5 acquire-before-read)", async () => {
  const { wasm } = await compile(messageRecvProc);
  const self = makeMockSelf();
  const ring = messageRecvProc.worklet.messageRings[0]!;
  const ringTotalBytes = 12 + ring.capacity * ring.slotSize;
  const messageRingsBuffer = new SharedArrayBuffer(ringTotalBytes);
  messageRecvProc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      messageRingsBuffer,
      messageRings: messageRecvProc.worklet.messageRings,
      messageRingSabOffsets: [0],
      transport: "sab",
    },
  });
  const headerView = new Int32Array(messageRingsBuffer, 0, 3);
  const slotsView = new Int32Array(messageRingsBuffer, 12);
  slotsView[0] = 42;
  Atomics.store(headerView, 0, 1); // head = 1 (= pending message)

  // §5.5 consumer protocol は「head を acquire-load し て か ら slot data を 読 む」
  // を 要 求。 SAB mirror で は Atomics.load(head) が slot bytes の copy (= sabView →
  // wasmView の Uint8Array.set) よ り 前 に 起 き な け れ ば、 並 行 producer write を
  // torn read す る。 vitest spy の invocationCallOrder で 両 者 の 呼 び 出 し 順 を 比 較。
  // Uint8Array.prototype.set spy は message ring copy だ け を 捕 捉 す る (= audio I/O
  // marshalling は Float32Array 経 由 = 別 prototype の set)。
  const loadSpy = vi.spyOn(Atomics, "load");
  const setSpy = vi.spyOn(Uint8Array.prototype, "set");
  try {
    const inputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
    const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
    messageRecvProc.worklet.process(self, inputs, outputs, {});
  } finally {
    vi.restoreAllMocks();
  }

  // head が acquire-load さ れ + slot bytes が copy さ れ た こ と
  expect(loadSpy.mock.invocationCallOrder.length).toBeGreaterThan(0);
  expect(setSpy.mock.invocationCallOrder.length).toBeGreaterThan(0);
  // §5.5: 最 初 の head acquire-load は 最 初 の slot copy よ り 前
  expect(loadSpy.mock.invocationCallOrder[0]!).toBeLessThan(setSpy.mock.invocationCallOrder[0]!);
});

test("message ring mirror: messageRingsBuffer ナ シ processor は message path skip (= regression)", async () => {
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });
  const inputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(0.5)]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  const parameters = { gain: new Float32Array([2]) };
  expect(() => monoGain.worklet.process(self, inputs, outputs, parameters)).not.toThrow();
});

// ─────────────────────────────────────────────────────────────────────────
// message ring postMessage path (= postMessage fallback、 messageRingsBuffer
// な し で main 側 が port.postMessage 直 送 + worklet 側 が self.port.onmessage
// で receive + queue に push + process 開 始 で WASM ring に inject)
// ─────────────────────────────────────────────────────────────────────────

const messagePostProc = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "out" });
  const captured = stateDecl.i32(0).expose({ name: "captured", publish: { rateFps: 30 } });
  const ctrl = message<{ slot: number }>({ name: "ctrl", capacity: CAPACITY_16 });
  return {
    process: () => {
      ctrl.onReceive(({ slot }) => {
        captured.write(slot);
      });
      forSample((i) => {
        out.ch(0).at(i).write(0);
      });
    },
  };
});

test("message inject (postMessage): initialize で port.addEventListener + port.start 呼 ば れ る", async () => {
  const { wasm } = await compile(messagePostProc);
  const self = makeMockSelf();
  messagePostProc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      messageRings: messagePostProc.worklet.messageRings,
      messageRingSabOffsets: [0],
      transport: "postMessage",
    },
  });
  expect(self.port.__listeners.length).toBeGreaterThan(0);
  expect(self.port.__startCalled).toBe(true);
});

test("message inject (postMessage): firePortMessage で payload を queue に push + process で WASM ring drain", async () => {
  const { wasm } = await compile(messagePostProc);
  const self = makeMockSelf();
  messagePostProc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      messageRings: messagePostProc.worklet.messageRings,
      messageRingSabOffsets: [0],
      transport: "postMessage",
      // publish も hand (= captured の publish 経 由 で 動 作 chain 担 保)
      publishSlots: messagePostProc.worklet.publishSlots,
    },
  });
  self.messages.length = 0;
  // main → worklet を simulate
  firePortMessage(self, { kind: "message", ringIndex: 0, payload: { slot: 42 } });
  // process 開始 で WASM ring に inject + onReceive で captured.write(42) + 末尾
  // publish 経 由 で main へ port.postMessage 通 知 (= "publish" message)
  const inputs: Float32Array[][] = [];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  // publish が 30fps で 1600 sample 周期 = 13 block で due tick
  for (let b = 0; b < 13; b++) {
    messagePostProc.worklet.process(self, inputs, outputs, {});
  }
  const publishMessages = self.messages.filter(
    (m): m is { kind: string; valueBits: number } =>
      typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "publish",
  );
  expect(publishMessages.length).toBeGreaterThan(0);
  expect(publishMessages[0]!.valueBits).toBe(42);
});

test("message inject (postMessage): 不 正 kind は drop = queue に push さ れ な い", async () => {
  const { wasm } = await compile(messagePostProc);
  const self = makeMockSelf();
  messagePostProc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      messageRings: messagePostProc.worklet.messageRings,
      messageRingSabOffsets: [0],
      transport: "postMessage",
      publishSlots: messagePostProc.worklet.publishSlots,
    },
  });
  self.messages.length = 0;
  // 不 正 kind + ringIndex 範 囲 外 + null payload + non-object payload + null data 全 drop
  firePortMessage(self, { kind: "other-kind", ringIndex: 0, payload: { slot: 1 } });
  firePortMessage(self, { kind: "message", ringIndex: 99, payload: { slot: 2 } });
  firePortMessage(self, { kind: "message", ringIndex: 0, payload: null });
  firePortMessage(self, { kind: "message", ringIndex: 0, payload: "non-object" });
  firePortMessage(self, null);
  firePortMessage(self, { kind: "message", ringIndex: "not-a-number", payload: { slot: 3 } });
  // process 走 ら せ て publish が 出 な い こ と (= queue 空 = inject ナ シ = captured 0)
  const inputs: Float32Array[][] = [];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  for (let b = 0; b < 13; b++) {
    messagePostProc.worklet.process(self, inputs, outputs, {});
  }
  const publishMessages = self.messages.filter(
    (m): m is { kind: string; valueBits: number } =>
      typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "publish",
  );
  // captured 初 期 値 0 が publish さ れ る = valueBits 全 0
  for (const m of publishMessages) expect(m.valueBits).toBe(0);
});

test("message inject (postMessage): 容 量 超 え で WASM 内 drop-oldest + overflow notify", async () => {
  const { wasm } = await compile(messagePostProc);
  const self = makeMockSelf();
  messagePostProc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      messageRings: messagePostProc.worklet.messageRings,
      messageRingSabOffsets: [0],
      transport: "postMessage",
    },
  });
  self.messages.length = 0;
  // capacity 16 = 17 件 送 れ ば 1 件 drop-oldest 発 動
  for (let i = 0; i < 17; i++) {
    firePortMessage(self, { kind: "message", ringIndex: 0, payload: { slot: i } });
  }
  const inputs: Float32Array[][] = [];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  messagePostProc.worklet.process(self, inputs, outputs, {});
  // 末 尾 で overflow notify が 1 件 出 て いる
  const overflowMessages = self.messages.filter(
    (m): m is { kind: string; ringIndex: number; overflowCount: number } =>
      typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "message-overflow",
  );
  expect(overflowMessages.length).toBe(1);
  expect(overflowMessages[0]!.ringIndex).toBe(0);
  expect(overflowMessages[0]!.overflowCount).toBe(1);
});

test("message overflow notify (postMessage): overflow 変 化 ナ シ quantum は skip", async () => {
  const { wasm } = await compile(messagePostProc);
  const self = makeMockSelf();
  messagePostProc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      messageRings: messagePostProc.worklet.messageRings,
      messageRingSabOffsets: [0],
      transport: "postMessage",
    },
  });
  self.messages.length = 0;
  // 1 件 だ け push = overflow 起 き な い = 1 quantum 後 self.messages に
  // "message-overflow" 出 て な い
  firePortMessage(self, { kind: "message", ringIndex: 0, payload: { slot: 1 } });
  const inputs: Float32Array[][] = [];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  messagePostProc.worklet.process(self, inputs, outputs, {});
  // 次 quantum で も push 続 け な い = overflow 変 化 ナ シ
  messagePostProc.worklet.process(self, inputs, outputs, {});
  const overflowMessages = self.messages.filter(
    (m): m is { kind: string } =>
      typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "message-overflow",
  );
  expect(overflowMessages.length).toBe(0);
});

test("message inject (postMessage): process 内 で DataView を 毎 quantum alloc し な い (= ring view は init で pre-bind、 §5.1 realtime safety)", async () => {
  const { wasm } = await compile(messagePostProc);
  const self = makeMockSelf();
  messagePostProc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      messageRings: messagePostProc.worklet.messageRings,
      messageRingSabOffsets: [0],
      transport: "postMessage",
    },
  });

  // init で の pre-bind は許 容。 計 測 す る の は audio thread hot path (= process())
  // 内 で の per-quantum alloc だ け な の で、 init 後 に DataView constructor を hook。
  const RealDataView = globalThis.DataView;
  let ctorCount = 0;
  globalThis.DataView = new Proxy(RealDataView, {
    construct(target, args, newTarget) {
      ctorCount++;
      return Reflect.construct(target, args, newTarget);
    },
  }) as typeof DataView;

  const inputs: Float32Array[][] = [];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  try {
    // 毎 quantum message を inject = inject path (= ring view 経 由 の field 書 込) を
    // 確 実 に 通 す。 queue は process ご と に drain さ れ る た め 各 quantum 前 に 再 push。
    for (let b = 0; b < 5; b++) {
      firePortMessage(self, { kind: "message", ringIndex: 0, payload: { slot: b } });
      messagePostProc.worklet.process(self, inputs, outputs, {});
    }
  } finally {
    globalThis.DataView = RealDataView;
  }

  // process 内 で の DataView 構 築 = 0 (= message ring view は init で 1 度 だ け pre-bind)
  expect(ctorCount).toBe(0);
});

test("message inject (postMessage): ingress queue を ring capacity で bound す る (= drop-oldest、 audio thread unbounded loop 回避、 §5.1)", async () => {
  const { wasm } = await compile(messagePostProc);
  const self = makeMockSelf();
  messagePostProc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      messageRings: messagePostProc.worklet.messageRings,
      messageRingSabOffsets: [0],
      transport: "postMessage",
    },
  });
  const capacity = messagePostProc.worklet.messageRings[0]!.capacity;

  // process() を 挟 ま ず に capacity 超 の burst を ingress (= main が 1 quantum 間 に
  // ring capacity を 超 え る 数 を post し た 状 況)。 bound ナ シ だ と queue が burst
  // サ イ ズ ま で 膨 ら み、 process() の `for (const payload of queue)` が audio thread
  // で burst 比 例 = unbounded loop (= 00-foundations §5.1 invariant 2 違 反)。
  const burst = capacity + 8;
  for (let i = 0; i < burst; i++) {
    firePortMessage(self, { kind: "message", ringIndex: 0, payload: { slot: i } });
  }

  // 内 部 state (= module-private Symbol) を 白 箱 read し て ingress queue 長 を 確 認。
  const stateKey = Object.getOwnPropertySymbols(self).find(
    (s) => s.description === "unworklet.workletState",
  );
  expect(stateKey).toBeDefined();
  const state = (self as unknown as Record<symbol, { messageQueueMirrors: unknown[][] }>)[
    stateKey!
  ]!;
  // ingress queue は ring capacity を 超 え な い (= drop-oldest で bound)
  expect(state.messageQueueMirrors[0]!.length).toBe(capacity);
});

test("no message/midi rings: a port message listener is still registered + started (= snapshot/restore は universal、`11-midi.md` §4.4 / `05-client.md` §2.6)", async () => {
  // snapshot / restore travel as port request-response and must work for every
  // processor — even one with no message / midi rings — so `initialize` always
  // wires one message listener + starts the port. (Earlier this was gated on
  // message/midi rings; the universal snapshot capability superseded that.)
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });
  expect(self.port.__listeners.length).toBe(1);
  expect(self.port.__startCalled).toBe(true);
});

// ── loose-literal re-lift at the store / write boundary (Q77, "type ⟺ works") ──
// `num(n)` is a loose literal that defers its type to context. A `.write()` /
// buffer `.write()` IS that context, so the literal must re-lift to the declared
// slot type — emitting an `f32.const` into a non-f32 slot type-checks in TS yet
// produces broken WASM. These run the compiled module and read the value back.

test("`process`: state.f64.write(num(n)) re-lifts the loose literal to the f64 slot", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const x = state.f64(0);
    return {
      process: () => {
        x.write(num(5));
        forSample((i) => {
          out.ch(0).at(i).write(f32(x.read()));
        });
      },
    };
  });
  const { wasm } = await compile(proc);
  const self = makeMockSelf();
  proc.worklet.initialize(self, { processorOptions: { wasm } });
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  proc.worklet.process(self, [], outputs, {});
  expect(outputs[0]![0]![0]).toBeCloseTo(5);
});

test("`process`: buffer.i32.write(num(n)) re-lifts the loose literal to the i32 element type", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const b = buffer.i32({ size: 4 });
    return {
      process: () => {
        b.write(0, num(7));
        forSample((i) => {
          out
            .ch(0)
            .at(i)
            .write(f32(b.read(0)));
        });
      },
    };
  });
  const { wasm } = await compile(proc);
  const self = makeMockSelf();
  proc.worklet.initialize(self, { processorOptions: { wasm } });
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  proc.worklet.process(self, [], outputs, {});
  expect(outputs[0]![0]![0]).toBeCloseTo(7);
});
