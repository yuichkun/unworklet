/**
 * Behavioral tests for `makeWorkletNamespace(graph)` — the per-processor
 * function namespace that backs `CompiledProcessor.worklet` (= `01-dsl.md` §11,
 * `04-worklet-runtime.md` §2, Q80).
 *
 * In the worklet, the namespace 3 entry points (`initialize` / `process` /
 * `parameterDescriptors`) are wired into a `class extends AudioWorkletProcessor`
 * (either the unplugin-emitted template auto-register path, or a
 * user-authored escape-hatch class). Tests stand in for the host by passing a
 * minimal `self` object with a `port.postMessage` collector + the same
 * `inputs` / `outputs` / `parameters` shape that AudioWorkletProcessor.process
 * receives.
 */

import "./dsl/primitives.ts"; // method form (= `.mul`) registration side-effect

import { expect, test, vi } from "vite-plus/test";

import { compile } from "./compile/index.ts";
import { CAPACITY_16, SAMPLES_PER_BLOCK } from "./dsl/constants.ts";
import { audioInput, audioOutput, event, param } from "./dsl/declarations.ts";
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
    event<{ slot: number }>({ from: "main", name: "preset", capacity: 16 });
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
      // fields = [] (= no onReceive yet, slot size unsettled until the first onReceive
      // call resolves the capture proxy and seals the field layout).
      slotSize: 0,
      fields: [],
    },
  ]);
});

test("`eventRings` reflects declared `event<T>` per-event ringbuffer descriptor", () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    const peakEvt = event<{ level: number }>({ to: "main", name: "peak", capacity: 16 });
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
      wasmRingBase: 512, // end of ioScratch region (= 1 ch × 128 samples × 4 bytes = 512)
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
  // allocation inside the per-quantum hot path. `initialize` pre-binds one
  // view per (port, channel) and per param, reused on every render. If a
  // future change rebinds a view inside `process()` (e.g. via a typo that
  // re-creates one against `memory.buffer`), the second call's output will
  // diverge because the underlying ArrayBuffer view would re-read scratch
  // memory that already holds the previous block's residue. This test
  // pins the deterministic "two identical inputs → two identical outputs"
  // contract that view reuse guarantees.
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

test("`process` up-mixes a mono input across a stereo-declared port (no left-only)", async () => {
  // A mono source connected to a stereo `audioInput({ channels: 2 })` effect:
  // AudioWorklet (channelCountMode 'max') hands the worklet ONE input channel.
  // The declared 2nd channel must be filled from channel 0 (Web Audio 'speakers'
  // up-mix), not zeroed — otherwise the right output is silent (the "left-only"
  // bug). A disconnected port (zero channels) still maps to silence (test above).
  const { wasm } = await compile(stereoGain);
  const self = makeMockSelf();
  stereoGain.worklet.initialize(self, { processorOptions: { wasm } });

  const mono = new Float32Array(SAMPLES_PER_BLOCK).fill(0.5);
  const inputs = [[mono]]; // ONE channel feeding a 2-channel input port
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK), new Float32Array(SAMPLES_PER_BLOCK)]];
  const parameters = { gain: new Float32Array([2]) };

  stereoGain.worklet.process(self, inputs, outputs, parameters);

  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(outputs[0][0]![i]).toBeCloseTo(1.0); // left  = 0.5 × 2
    expect(outputs[0][1]![i]).toBeCloseTo(1.0); // right = up-mixed 0.5 × 2 (currently 0)
  }
});

test("`process` on path-β escape hatch with missing `initialize(self, opts)` posts `worklet-initialize-not-called` exactly once", async () => {
  // Path β = user-authored `class extends AudioWorkletProcessor` whose
  // constructor forgot to invoke `def.worklet.initialize(this, opts)`
  // (= Q80 documents this as the worklet-initialize-not-called runtime
  // error path). The audio thread cannot throw, so the runtime posts a
  // structured event once and then continues emitting silence.
  const self = makeMockSelf();
  // Note: NO `initialize(...)` call — emulates the path-β bug.
  const inputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(1)]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(99)]];
  const parameters = { gain: new Float32Array([0.5]) };

  const ret = monoGain.worklet.process(self, inputs, outputs, parameters);

  expect(ret).toBe(true);
  // Silenced (= no throw on the audio thread).
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(outputs[0][0]![i]).toBe(0);
  }
  expect(self.messages).toContainEqual({
    kind: "error",
    code: "worklet-initialize-not-called",
  });

  // Subsequent quanta keep emitting silence without re-posting the event.
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
  // surface from an out-of-bounds memory access or unreachable instruction.
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
  // Silenced (= 00-foundations.md §5.1 invariant 3 + 05-client.md §4).
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
  // (= node stays connected with silence output, single failure event).
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
  // quantum after first detection, until disposed". A subsequent quantum
  // where the host returns to SAMPLES_PER_BLOCK must STILL emit silence
  // (= node is permanently silenced + connected, not transiently).
  const goodInputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(1)]];
  const goodOutputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(99)]];
  monoGain.worklet.process(self, goodInputs, goodOutputs, parameters);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(goodOutputs[0][0]![i]).toBe(0);
  }
  // And no second `block-length-mismatch` event is posted (= single
  // event for the lifetime of the node, exact same shape as wasm-trap).
  const errorMessagesAfter = self.messages.slice(initialMessageCount);
  expect(errorMessagesAfter).toHaveLength(1);
});

test("`initialize` without `processorOptions.module` or `.wasm` posts a structured init-error", async () => {
  // Cover the `if (!wasmModule) throw new Error(...)` branch inside the
  // initialize try/catch = path β author hands an empty processorOptions
  // or the path α emit is somehow corrupted. The audio thread must not
  // throw; init-error is posted instead.
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
  // Cover the `inputs[portIdx] ?? []` fallback branch in process().
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });
  // Host hands us a length-0 outer array → portInput defaults to [].
  const inputs: Float32Array[][] = [];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(7)]];
  const parameters = { gain: new Float32Array([2]) };
  monoGain.worklet.process(self, inputs, outputs, parameters);
  // Silent input × gain = silence (verified independently in another test);
  // here we just confirm the path executes without throwing.
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(outputs[0][0]![i]).toBeCloseTo(0);
  }
});

test("`process` skips output channels the host did not provide", async () => {
  // Cover the `if (dest)` false branch in the output marshal loop.
  const { wasm } = await compile(stereoGain);
  const self = makeMockSelf();
  stereoGain.worklet.initialize(self, { processorOptions: { wasm } });
  const inputs = [
    [new Float32Array(SAMPLES_PER_BLOCK).fill(1), new Float32Array(SAMPLES_PER_BLOCK).fill(1)],
  ];
  // Provide only 1 channel of output where the processor declares 2 — the
  // missing channel slot is `undefined` and must be skipped without throwing.
  const outputs: Float32Array[][] = [[new Float32Array(SAMPLES_PER_BLOCK).fill(0)]];
  const parameters = { gain: new Float32Array([1]) };
  expect(() => stereoGain.worklet.process(self, inputs, outputs, parameters)).not.toThrow();
});

test("`initialize` catches arbitrary throws inside the WASM boot path and posts init-error", async () => {
  // Cover the outer catch in `initialize` for non-trivial throws (= e.g.
  // a corrupt module that surfaces during instance construction).
  const self = makeMockSelf();
  // A `WebAssembly.Module`-shaped fake whose `instance` construction
  // throws — exercises the catch path post-`!wasmModule` check.
  const corruptModule = {} as unknown as WebAssembly.Module;
  // Stub WebAssembly.Instance to throw when this corrupt module flows
  // through.
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
  // branch in `errorMessage`. Throwing a primitive from inside the boot path
  // (= unusual but legal in JS) must still surface a structured init-error
  // with a string `message` field.
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
  // Cover the `args[1] ?? {}` fallback in initialize. Path β escape hatches
  // could omit the second argument entirely (e.g. a class constructor that
  // forwards `super()` without re-passing options). The runtime must treat
  // missing opts as an empty bag and surface the standard init-error rather
  // than throwing on the audio thread.
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
  // Cover the `outputs[portIdx] ?? []` fallback in the output marshal loop.
  // A misbehaving host (= test harness, or a non-conformant engine) may hand
  // us an outputs array shorter than the declared number of output ports.
  // The audio-thread invariant forbids throwing, so the marshal loop must
  // silently no-op over the missing port (= `portOutput` defaults to `[]`,
  // `dest` is undefined, `if (dest)` is skipped).
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });
  const inputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(0.5)]];
  // Host hands us an empty outputs outer array even though monoGain declares
  // 1 output port = `outputs[0]` is undefined → `?? []` kicks in.
  const outputs: Float32Array[][] = [];
  const parameters = { gain: new Float32Array([1]) };
  expect(() => monoGain.worklet.process(self, inputs, outputs, parameters)).not.toThrow();
});

// ─────────────────────────────────────────────────────────────────────────
// publish copy logic (= sub-phase 7.4: the worklet template copies WASM publish
// slots into the shared buffer). Covers SAB mode (Atomics.store), the
// postMessage fallback (direct view write), and the "same version → skip" path.
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

test("publish copy (sab mode): due tick at end of quantum copies value to SAB via Atomics.store", async () => {
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

  // threshold = round(48000 / 30) = 1600; after 13 blocks, 1664 ≥ 1600 = due
  const input = new Float32Array(SAMPLES_PER_BLOCK).fill(0.5);
  const inputs = [[input]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  for (let b = 0; b < 13; b++) {
    publishProc.worklet.process(self, inputs, outputs, {});
  }
  const view = new Int32Array(publishBuffer);
  // valueBits: the i32 bit pattern of f32 0.5
  const valueBits = new Int32Array(new Float32Array([0.5]).buffer)[0]!;
  expect(view[0]).toBe(valueBits);
  expect(view[1]).toBe(64); // sample counter remainder = 1664 - 1600
  expect(view[2]).toBe(1); // version
});

test("publish copy (postMessage fallback): each due tick dispatched individually via port.postMessage (no publishBuffer)", async () => {
  // postMessage path = no publishBuffer (structured clone produces separate
  // instances in main and worklet, making shared-memory mirroring impossible;
  // the worklet notifies via port.postMessage instead). Asserts that exactly
  // one { kind: 'publish', ... } message lands in self.messages.
  const { wasm } = await compile(publishProc, { sampleRate: 48000 });
  const self = makeMockSelf();
  publishProc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      publishSlots: publishProc.worklet.publishSlots,
      transport: "postMessage",
    },
  });
  // Consume the `ready` ack posted at the end of initialize so that only
  // publish messages are asserted below.
  self.messages.length = 0;

  const input = new Float32Array(SAMPLES_PER_BLOCK).fill(0.5);
  const inputs = [[input]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  for (let b = 0; b < 13; b++) {
    publishProc.worklet.process(self, inputs, outputs, {});
  }
  // After 13 blocks the counter reaches 1664 ≥ threshold 1600 = one due tick triggers a publish dispatch.
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

test("publish copy: view unchanged when block is not yet due (= skip path)", async () => {
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
  expect(view[2]).toBe(0); // version not yet updated
  expect(view[0]).toBe(0); // value not yet copied
});

test("publish copy: processor without publishBuffer skips the publish path entirely (= regression)", async () => {
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });
  const inputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(0.5)]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  const parameters = { gain: new Float32Array([2]) };
  expect(() => monoGain.worklet.process(self, inputs, outputs, parameters)).not.toThrow();
});

// ─────────────────────────────────────────────────────────────────────────
// event ring SAB copy (= sub-phase 7.6 commit 5c). The audio thread emits
// (fills a slot in the WASM-internal ring and increments head); the worklet
// template bulk-copies that ring into the SAB ring at the end of each quantum
// via Atomics.store(head / tail / overflow). Verifies that the main side can
// read the expected values from the SAB.
// ─────────────────────────────────────────────────────────────────────────

const eventEmitProc = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });
  // Reset gate state to true at the start of each quantum and use stateLoad as
  // the condition — a syntactic workaround for Q32-c (constant-truthy) that
  // keeps the dynamic-fire path reachable through the analyze pass.
  const gate = stateDecl.named("gate").bool(true);
  const peakEvt = event<{ level: number }>({ to: "main", name: "peak", capacity: 16 });
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

test("event ring copy (sab mode): WASM emit reflected into SAB header + slots via Atomics", async () => {
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
  // capacity 16 + 128 emits → repeated drop-oldest: head = 128, tail = 128 - 16 = 112,
  // overflowCount = 128 - 16 = 112
  expect(Atomics.load(headView, 0)).toBe(128); // head
  expect(Atomics.load(headView, 1)).toBe(112); // tail
  expect(Atomics.load(headView, 2)).toBe(112); // overflowCount

  // The 128th emit (atSample = 127) lands in slot 127 % 16 = 15.
  // Read slot 15 to verify atSample = 127 and level = 0.5.
  const slotsView = new DataView(eventRingsBuffer, 12);
  expect(slotsView.getInt32(15 * 8, true)).toBe(127); // atSample
  expect(slotsView.getFloat32(15 * 8 + 4, true)).toBe(0.5); // level
});

test("event ring copy (postMessage fallback): new emits dispatched via port.postMessage (no eventRingsBuffer)", async () => {
  // postMessage path = no eventRingsBuffer (structured clone produces separate
  // instances in main and worklet, making shared-memory mirroring impossible;
  // the worklet dispatches each batch individually via port.postMessage). Asserts
  // that self.messages receives { kind: 'event', ringIndex, newSlotsBytes,
  // newSlotCount, overflowCount }.
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
  // 128 emits / capacity 16 = repeated drop-oldest; the last 16 slots remain in
  // the ring. The dispatch covers currentTail..currentHead (16 slots); overflow
  // slots are skipped.
  expect(eventMessages[0]!.newSlotCount).toBe(16);
  expect(eventMessages[0]!.overflowCount).toBe(112); // 128 - 16
});

test("event ring copy: processor without eventRingsBuffer skips the event path entirely (= regression)", async () => {
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });
  const inputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(0.5)]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  const parameters = { gain: new Float32Array([2]) };
  expect(() => monoGain.worklet.process(self, inputs, outputs, parameters)).not.toThrow();
});

// ─────────────────────────────────────────────────────────────────────────
// message ring mirror (= sub-phase 7.7d). At the start of each quantum the
// worklet template mirrors slots pushed by main into the SAB ring into the
// WASM-internal ring; WASM drain logic then runs (sub-phase 7.7c). At the end
// of drain the worklet commits the WASM tail back into the SAB tail so the
// main side can observe that drain has completed.
// ─────────────────────────────────────────────────────────────────────────

const messageRecvProc = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "out" });
  const captured = stateDecl.named("captured").i32(0);
  const ctrl = event<{ slot: number }>({ from: "main", name: "ctrl", capacity: 16 });
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

test("message ring mirror (sab mode): main SAB push → process mirrors into WASM ring + drain updates state", async () => {
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
  // Simulate a main-side push: write slot 0 = 42 into the SAB and Atomics.store head = 1.
  const headerView = new Int32Array(messageRingsBuffer, 0, 3);
  const slotsView = new Int32Array(messageRingsBuffer, 12);
  slotsView[0] = 42;
  Atomics.store(headerView, 0, 1); // head = 1
  const inputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  messageRecvProc.worklet.process(self, inputs, outputs, {});
  // After drain, the SAB tail must be committed to match head.
  expect(Atomics.load(headerView, 1)).toBe(1);
});

test("message ring mirror (sab mode): head acquire-load occurs before slot copy (= 02-messaging §5.5 acquire-before-read)", async () => {
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

  // §5.5 consumer protocol requires an acquire-load of head before reading slot
  // data. In the SAB mirror, Atomics.load(head) must happen before the slot-bytes
  // copy (Uint8Array.set from sabView → wasmView); otherwise a concurrent producer
  // write can produce a torn read. The vitest spy invocationCallOrder is used to
  // compare the two call sites. The Uint8Array.prototype.set spy captures only the
  // message ring copy (audio I/O marshalling uses Float32Array, a different
  // prototype's set).
  const loadSpy = vi.spyOn(Atomics, "load");
  const setSpy = vi.spyOn(Uint8Array.prototype, "set");
  try {
    const inputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
    const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
    messageRecvProc.worklet.process(self, inputs, outputs, {});
  } finally {
    vi.restoreAllMocks();
  }

  // Verify that head was acquire-loaded and slot bytes were copied.
  expect(loadSpy.mock.invocationCallOrder.length).toBeGreaterThan(0);
  expect(setSpy.mock.invocationCallOrder.length).toBeGreaterThan(0);
  // §5.5: the first head acquire-load must precede the first slot copy.
  expect(loadSpy.mock.invocationCallOrder[0]!).toBeLessThan(setSpy.mock.invocationCallOrder[0]!);
});

test("message ring mirror: processor without messageRingsBuffer skips the message path entirely (= regression)", async () => {
  const { wasm } = await compile(monoGain);
  const self = makeMockSelf();
  monoGain.worklet.initialize(self, { processorOptions: { wasm } });
  const inputs = [[new Float32Array(SAMPLES_PER_BLOCK).fill(0.5)]];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  const parameters = { gain: new Float32Array([2]) };
  expect(() => monoGain.worklet.process(self, inputs, outputs, parameters)).not.toThrow();
});

// ─────────────────────────────────────────────────────────────────────────
// message ring postMessage path (= postMessage fallback). No messageRingsBuffer:
// main sends directly via port.postMessage; the worklet receives via
// self.port.onmessage, pushes into a queue, and injects into the WASM ring at
// the start of each process() call.
// ─────────────────────────────────────────────────────────────────────────

const messagePostProc = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "out" });
  const captured = stateDecl.i32(0).expose({ name: "captured", publish: { rateFps: 30 } });
  const ctrl = event<{ slot: number }>({ from: "main", name: "ctrl", capacity: CAPACITY_16 });
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

test("message inject (postMessage): initialize registers port.addEventListener and calls port.start", async () => {
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

test("message inject (postMessage): firePortMessage pushes payload to queue; process drains it into WASM ring", async () => {
  const { wasm } = await compile(messagePostProc);
  const self = makeMockSelf();
  messagePostProc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      messageRings: messagePostProc.worklet.messageRings,
      messageRingSabOffsets: [0],
      transport: "postMessage",
      // Also supply publish slots to verify the full action chain via captured's publish.
      publishSlots: messagePostProc.worklet.publishSlots,
    },
  });
  self.messages.length = 0;
  // Simulate main → worklet delivery.
  firePortMessage(self, { kind: "message", ringIndex: 0, payload: { slot: 42 } });
  // process injects the message into the WASM ring; onReceive calls captured.write(42);
  // at the end of the due quantum the publish path notifies main via port.postMessage.
  const inputs: Float32Array[][] = [];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  // publish at 30fps = 1600-sample period; 13 blocks trigger the due tick.
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

test("message inject (postMessage): malformed messages are dropped and never pushed to the queue", async () => {
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
  // All of the following must be dropped: wrong kind, out-of-range ringIndex,
  // null payload, non-object payload, null data.
  firePortMessage(self, { kind: "other-kind", ringIndex: 0, payload: { slot: 1 } });
  firePortMessage(self, { kind: "message", ringIndex: 99, payload: { slot: 2 } });
  firePortMessage(self, { kind: "message", ringIndex: 0, payload: null });
  firePortMessage(self, { kind: "message", ringIndex: 0, payload: "non-object" });
  firePortMessage(self, null);
  firePortMessage(self, { kind: "message", ringIndex: "not-a-number", payload: { slot: 3 } });
  // Run process and confirm no publish fires (empty queue → no inject → captured stays 0).
  const inputs: Float32Array[][] = [];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  for (let b = 0; b < 13; b++) {
    messagePostProc.worklet.process(self, inputs, outputs, {});
  }
  const publishMessages = self.messages.filter(
    (m): m is { kind: string; valueBits: number } =>
      typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "publish",
  );
  // captured stays at its initial value 0, so all published valueBits must be 0.
  for (const m of publishMessages) expect(m.valueBits).toBe(0);
});

test("message inject (postMessage): capacity overflow triggers WASM drop-oldest and posts an overflow notification", async () => {
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
  // capacity 16: sending 17 messages triggers one drop-oldest.
  for (let i = 0; i < 17; i++) {
    firePortMessage(self, { kind: "message", ringIndex: 0, payload: { slot: i } });
  }
  const inputs: Float32Array[][] = [];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  messagePostProc.worklet.process(self, inputs, outputs, {});
  // Exactly one overflow notification must be posted at the end of the quantum.
  const overflowMessages = self.messages.filter(
    (m): m is { kind: string; ringIndex: number; overflowCount: number } =>
      typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "message-overflow",
  );
  expect(overflowMessages.length).toBe(1);
  expect(overflowMessages[0]!.ringIndex).toBe(0);
  expect(overflowMessages[0]!.overflowCount).toBe(1);
});

test("message overflow notify (postMessage): no overflow notification posted when overflow count is unchanged", async () => {
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
  // Push just one message: no overflow; after one quantum self.messages must
  // contain no "message-overflow" entry.
  firePortMessage(self, { kind: "message", ringIndex: 0, payload: { slot: 1 } });
  const inputs: Float32Array[][] = [];
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  messagePostProc.worklet.process(self, inputs, outputs, {});
  // No additional push in the next quantum = overflow count unchanged.
  messagePostProc.worklet.process(self, inputs, outputs, {});
  const overflowMessages = self.messages.filter(
    (m): m is { kind: string } =>
      typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "message-overflow",
  );
  expect(overflowMessages.length).toBe(0);
});

test("message inject (postMessage): process does not allocate DataView per quantum (ring view pre-bound at init, §5.1 realtime safety)", async () => {
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

  // Pre-binding during init is allowed. The measurement target is per-quantum
  // allocation inside the audio-thread hot path (process()), so the DataView
  // constructor is hooked after init completes.
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
    // Inject a message every quantum to ensure the inject path (field writes via
    // ring view) is always exercised. The queue drains each process() call, so
    // a fresh push is needed before each quantum.
    for (let b = 0; b < 5; b++) {
      firePortMessage(self, { kind: "message", ringIndex: 0, payload: { slot: b } });
      messagePostProc.worklet.process(self, inputs, outputs, {});
    }
  } finally {
    globalThis.DataView = RealDataView;
  }

  // Zero DataView constructions inside process() — the message ring view is pre-bound once during init.
  expect(ctorCount).toBe(0);
});

test("message inject (postMessage): ingress queue is bounded by ring capacity (drop-oldest prevents unbounded audio-thread loop, §5.1)", async () => {
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

  // Burst more messages than the ring capacity without interleaving process()
  // calls — simulating main posting more than ring capacity in a single quantum.
  // Without a bound, the queue grows to burst size and the `for (const payload of queue)`
  // loop in process() would scale linearly with the burst = unbounded loop on the
  // audio thread (00-foundations §5.1 invariant 2 violation).
  const burst = capacity + 8;
  for (let i = 0; i < burst; i++) {
    firePortMessage(self, { kind: "message", ringIndex: 0, payload: { slot: i } });
  }

  // White-box read of the module-private Symbol to inspect the ingress queue length.
  const stateKey = Object.getOwnPropertySymbols(self).find(
    (s) => s.description === "unworklet.workletState",
  );
  expect(stateKey).toBeDefined();
  const state = (self as unknown as Record<symbol, { messageQueueMirrors: unknown[][] }>)[
    stateKey!
  ]!;
  // Ingress queue must not exceed ring capacity (drop-oldest enforces the bound).
  expect(state.messageQueueMirrors[0]!.length).toBe(capacity);
});

test("no message/midi rings: a port message listener is still registered + started (= snapshot/restore is universal, `11-midi.md` §4.4 / `05-client.md` §2.6)", async () => {
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
