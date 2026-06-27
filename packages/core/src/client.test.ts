/**
 * Behavioral tests for `createNode(ctx, processor, options?)` — Phase 6 A-3
 * implementation of `05-client.md` §1 + §2 (= minimum surface for the main
 * thread entrypoint that boots a processor via AudioWorklet).
 *
 * Mock strategy:
 * - `audioContext.audioWorklet.addModule` → mock function returning a Promise
 * - `globalThis.fetch` → mock function returning a WASM bytes Promise
 * - `globalThis.AudioWorkletNode` → mock class whose constructor accepts
 *   options and exposes `port` and `parameters` fields
 * - the mock port has a self-delivery path via `postMessage` so the test can
 *   control exactly when the ready ack is dispatched
 */

import { expect, test, vi } from "vite-plus/test";

import { createNode, inspect } from "./client.ts";
import { getDevNodes } from "./devRegistry.ts";
import { replaceProcessor } from "./replaceProcessor.ts";
import { encodeScalar } from "./snapshot.ts";
import { decodeSnapshot, encodeSnapshot } from "./snapshotBlob.ts";
import type { CompiledProcessor, MidiEvent } from "./types.ts";

type MockAudioParam = { value: number };

type ConstructorRecord = {
  context: unknown;
  name: string;
  options: AudioWorkletNodeOptions;
};

type PortListener = (e: { data: unknown }) => void;
type NodeListener = (e: Event) => void;

type MockAudioWorkletNode = {
  port: {
    postMessage: (msg: unknown) => void;
    onmessage: PortListener | null;
    addEventListener: (kind: string, fn: PortListener) => void;
    removeEventListener: (kind: string, fn: PortListener) => void;
    start: () => void;
    close: () => void;
    __listeners: PortListener[];
  };
  addEventListener: (kind: string, fn: NodeListener) => void;
  removeEventListener: (kind: string, fn: NodeListener) => void;
  parameters: { get: (name: string) => MockAudioParam | undefined };
  connect: (target: unknown, output?: number, input?: number) => unknown;
  disconnect: (...args: unknown[]) => void;
  __constructorRecord: ConstructorRecord;
  __processorErrorListeners: NodeListener[];
};

type MockHarnessOptions = {
  fetchOk?: boolean;
  fetchStatus?: number;
  fetchStatusText?: string;
  /**
   * When true, every constructed mock port's `start()` throws — exercises
   * the cleanup-on-throw branch inside `awaitReady`.
   */
  portStartThrows?: boolean;
  /**
   * Whether to set `crossOriginIsolated` on the mock global. Defaults to true
   * because most tests assume SAB is available. Pass `false` for explicit deny
   * or `"deleted"` to remove the property entirely (mirroring real environments
   * where the header is absent) when exercising the sab-unavailable path.
   */
  crossOriginIsolated?: boolean | "deleted";
};

type MockGainNode = {
  gain: { value: number };
  connect: (target: unknown, output?: number, input?: number) => unknown;
  disconnect: () => void;
  __outgoing: Array<{ target: unknown; output: number; input?: number }>;
};

type MockHarness = {
  context: {
    audioWorklet: { addModule: (url: string) => Promise<void> };
    createGain: () => MockGainNode;
  };
  addModuleCalls: string[];
  fetchCalls: string[];
  /** First argument of every `console.warn` during the harness lifetime. */
  warnCalls: string[];
  constructed: ConstructorRecord[];
  nodes: MockAudioWorkletNode[];
  createdGains: MockGainNode[];
  lastNode: MockAudioWorkletNode | null;
  fireReady: () => void;
  fireReadyAll: () => void;
  fireInitError: (message: string) => void;
  fireProcessorError: (message?: string) => void;
  cleanup: () => void;
};

const installMockGlobals = (
  wasmBytes: Uint8Array,
  harnessOpts: MockHarnessOptions = {},
): MockHarness => {
  const fetchOk = harnessOpts.fetchOk ?? true;
  const fetchStatus = harnessOpts.fetchStatus ?? 200;
  const fetchStatusText = harnessOpts.fetchStatusText ?? "OK";
  const portStartThrows = harnessOpts.portStartThrows ?? false;
  // Most tests assume a SAB-available environment. Defaulting to true avoids
  // spurious sab-unavailable notifications on the onError path. Tests that
  // exercise the sab-unavailable path pass `crossOriginIsolated: 'deleted'`
  // to mock an environment where the property is absent.
  const coiOption = harnessOpts.crossOriginIsolated ?? true;
  const coiTarget = globalThis as unknown as { crossOriginIsolated?: boolean };
  const prevCoi = coiTarget.crossOriginIsolated;
  if (coiOption === "deleted") {
    delete coiTarget.crossOriginIsolated;
  } else {
    coiTarget.crossOriginIsolated = coiOption;
  }

  const addModuleCalls: string[] = [];
  const fetchCalls: string[] = [];
  const constructed: ConstructorRecord[] = [];
  const nodes: MockAudioWorkletNode[] = [];
  let lastNode: MockAudioWorkletNode | null = null;

  // Track every `GainNode` created via `context.createGain()` and its
  // outgoing edges so input-proxy tests can observe routing without a real
  // Web Audio engine.
  const createdGains: MockGainNode[] = [];
  const context = {
    audioWorklet: {
      addModule(url: string): Promise<void> {
        addModuleCalls.push(url);
        return Promise.resolve();
      },
    },
    createGain(): MockGainNode {
      const outgoing: Array<{ target: unknown; output: number; input?: number }> = [];
      const gain: MockGainNode = {
        gain: { value: 0 },
        connect(target: unknown, output?: number, input?: number): unknown {
          outgoing.push({ target, output: output ?? 0, input });
          return target;
        },
        disconnect(): void {
          outgoing.length = 0;
        },
        __outgoing: outgoing,
      };
      createdGains.push(gain);
      return gain;
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    fetchCalls.push(url);
    return Promise.resolve({
      ok: fetchOk,
      status: fetchStatus,
      statusText: fetchStatusText,
      headers: { get: (_name: string) => "application/octet-stream" },
      arrayBuffer: (): Promise<ArrayBuffer> =>
        Promise.resolve(
          wasmBytes.buffer.slice(
            wasmBytes.byteOffset,
            wasmBytes.byteOffset + wasmBytes.byteLength,
          ) as ArrayBuffer,
        ),
    });
  }) as typeof globalThis.fetch;

  // Stub `WebAssembly.compile` so tests run without real WASM bytes.
  // The returned object only needs an identity the production path can
  // forward through `processorOptions.module`; createNode tests assert
  // it round-trips, no Module method is invoked.
  const originalWasmCompile = WebAssembly.compile;
  const compiledModuleSentinels: unknown[] = [];
  WebAssembly.compile = ((_bytes: BufferSource) => {
    const sentinel = { __mockModuleId: compiledModuleSentinels.length };
    compiledModuleSentinels.push(sentinel);
    return Promise.resolve(sentinel as unknown as WebAssembly.Module);
  }) as typeof WebAssembly.compile;

  // Capture `console.warn` so the SAB-unavailable dev notice (and any other warn)
  // doesn't print across the suite, and the dedicated test can assert on it.
  const originalWarn = console.warn;
  const warnCalls: string[] = [];
  console.warn = ((...args: unknown[]) => {
    warnCalls.push(String(args[0]));
  }) as typeof console.warn;

  class MockWorkletNodeImpl {
    port: MockAudioWorkletNode["port"];
    parameters: MockAudioWorkletNode["parameters"];
    context: unknown;
    __constructorRecord: ConstructorRecord;
    __processorErrorListeners: NodeListener[];
    constructor(ctx: unknown, name: string, opts: AudioWorkletNodeOptions) {
      this.context = ctx; // AudioNode.context — read by replaceProcessor
      this.__constructorRecord = { context: ctx, name, options: opts };
      constructed.push(this.__constructorRecord);
      const portListeners: PortListener[] = [];
      this.__processorErrorListeners = [];
      this.port = {
        postMessage: (_msg: unknown) => {},
        onmessage: null,
        addEventListener: (_kind: string, fn) => {
          portListeners.push(fn);
        },
        removeEventListener: (_kind: string, fn) => {
          const idx = portListeners.indexOf(fn);
          if (idx >= 0) portListeners.splice(idx, 1);
        },
        start: () => {
          if (portStartThrows) {
            throw new Error("InvalidStateError: port already started");
          }
        },
        close: () => {},
        __listeners: portListeners,
      };
      this.parameters = {
        get: (paramName: string): MockAudioParam | undefined => {
          const params = opts.parameterData ?? {};
          return paramName in params ? { value: params[paramName] as number } : { value: 0 };
        },
      };
      lastNode = this as unknown as MockAudioWorkletNode;
      nodes.push(lastNode);
    }
    addEventListener(kind: string, fn: NodeListener): void {
      if (kind === "processorerror") this.__processorErrorListeners.push(fn);
    }
    removeEventListener(kind: string, fn: NodeListener): void {
      if (kind !== "processorerror") return;
      const idx = this.__processorErrorListeners.indexOf(fn);
      if (idx >= 0) this.__processorErrorListeners.splice(idx, 1);
    }
    connect(_target: unknown, _output?: number, _input?: number): unknown {
      return _target;
    }
    disconnect(..._args: unknown[]): void {}
  }
  (globalThis as Record<string, unknown>).AudioWorkletNode = MockWorkletNodeImpl;

  return {
    context,
    addModuleCalls,
    fetchCalls,
    warnCalls,
    constructed,
    nodes,
    createdGains,
    get lastNode() {
      return lastNode;
    },
    fireReady() {
      if (!lastNode) throw new Error("no AudioWorkletNode constructed yet");
      for (const listener of lastNode.port.__listeners) {
        listener({ data: { kind: "ready" } });
      }
    },
    fireReadyAll() {
      if (nodes.length === 0) throw new Error("no AudioWorkletNode constructed yet");
      for (const n of nodes) {
        for (const listener of n.port.__listeners) {
          listener({ data: { kind: "ready" } });
        }
      }
    },
    fireInitError(message: string) {
      if (!lastNode) throw new Error("no AudioWorkletNode constructed yet");
      for (const listener of lastNode.port.__listeners) {
        listener({ data: { kind: "init-error", message } });
      }
    },
    fireProcessorError(message?: string) {
      if (!lastNode) throw new Error("no AudioWorkletNode constructed yet");
      const event = { message } as unknown as Event;
      for (const listener of lastNode.__processorErrorListeners) {
        listener(event);
      }
    },
    cleanup() {
      globalThis.fetch = originalFetch;
      WebAssembly.compile = originalWasmCompile;
      console.warn = originalWarn;
      delete (globalThis as Record<string, unknown>).AudioWorkletNode;
      if (prevCoi === undefined) {
        delete coiTarget.crossOriginIsolated;
      } else {
        coiTarget.crossOriginIsolated = prevCoi;
      }
    },
  };
};

const makeMockProcessor = (overrides?: {
  moduleUrl?: string | undefined;
  wasmUrl?: string | undefined;
  processorName?: string | undefined;
  displayName?: string | undefined;
  inputs?: Array<{ name: string; channels: number }>;
  outputs?: Array<{ name: string; channels: number }>;
  params?: Array<{ name: string }>;
  publishSlots?: Array<{
    name: string;
    type: "f32" | "i32" | "bool";
    sharedOffset: number;
    counterOffset: number;
  }>;
  eventRings?: Array<{
    name: string;
    wasmRingBase: number;
    capacity: number;
    slotSize: number;
    fields: Array<{
      name: string;
      wireType: "f32" | "f64" | "i32" | "i64" | "bool";
      offsetInSlot: number;
      byteSize: number;
    }>;
  }>;
  messageRings?: Array<{
    name: string;
    wasmRingBase: number;
    capacity: number;
    slotSize: number;
    fields: Array<{
      name: string;
      wireType: "f32" | "f64" | "i32" | "i64" | "bool";
      offsetInSlot: number;
      byteSize: number;
    }>;
  }>;
  midiRings?: Array<{
    name: string;
    direction: "in" | "out";
    wasmRingBase: number;
    capacity: number;
    sysex?: { wasmBase: number; perChunk: number; chunks: number };
  }>;
  migrations?: CompiledProcessor<unknown>["migrations"];
  bakedSampleRate?: number;
}): CompiledProcessor<unknown> =>
  ({
    graph: {} as never,
    schemaHash: "test",
    migrations: overrides?.migrations,
    worklet: {
      initialize: () => {},
      process: () => true,
      parameterDescriptors: (overrides?.params ?? [{ name: "gain" }]).map((p) => ({
        name: p.name,
      })),
      inputs: overrides?.inputs ?? [{ name: "main", channels: 2 }],
      outputs: overrides?.outputs ?? [{ name: "main", channels: 2 }],
      publishSlots: overrides?.publishSlots ?? [],
      eventRings: overrides?.eventRings ?? [],
      messageRings: overrides?.messageRings ?? [],
      midiRings: overrides?.midiRings ?? [],
      moduleUrl:
        overrides && "moduleUrl" in overrides ? overrides.moduleUrl : "/_assets/x.worklet.js",
      wasmUrl: overrides && "wasmUrl" in overrides ? overrides.wasmUrl : "/_assets/x.wasm",
      processorName:
        overrides && "processorName" in overrides ? overrides.processorName : "stereoGain",
      ...(overrides && "displayName" in overrides ? { displayName: overrides.displayName } : {}),
      ...(overrides && "bakedSampleRate" in overrides
        ? { bakedSampleRate: overrides.bakedSampleRate }
        : {}),
    },
    __compiledProcessor: undefined,
  }) as unknown as CompiledProcessor<unknown>;

const startCreate = async <T>(fn: () => Promise<T>, fire: () => void): Promise<T> => {
  const promise = fn();
  // Allow microtasks (= addModule + fetch) to resolve before firing ready.
  await new Promise((r) => setTimeout(r, 0));
  fire();
  return promise;
};

test("createNode throws when processor has no moduleUrl", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    await expect(
      createNode(h.context as never, makeMockProcessor({ moduleUrl: undefined }), undefined),
    ).rejects.toThrow(/moduleUrl/);
  } finally {
    h.cleanup();
  }
});

test("createNode throws when processor has no wasmUrl", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    await expect(
      createNode(h.context as never, makeMockProcessor({ wasmUrl: undefined }), undefined),
    ).rejects.toThrow(/wasmUrl/);
  } finally {
    h.cleanup();
  }
});

test("createNode throws when processor has no processorName", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    await expect(
      createNode(h.context as never, makeMockProcessor({ processorName: undefined }), undefined),
    ).rejects.toThrow(/processorName/);
  } finally {
    h.cleanup();
  }
});

test("createNode throws when context.sampleRate differs from the processor's baked sampleRate", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    await expect(
      createNode(
        { ...h.context, sampleRate: 44100 } as never,
        makeMockProcessor({ bakedSampleRate: 48000 }),
        undefined,
      ),
    ).rejects.toThrow(/compiled for 48000 Hz.*runs at 44100 Hz/);
  } finally {
    h.cleanup();
  }
});

test("createNode proceeds when context.sampleRate matches the baked sampleRate", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(
          { ...h.context, sampleRate: 48000 } as never,
          makeMockProcessor({ bakedSampleRate: 48000 }),
        ),
      h.fireReady,
    );
    expect(node).toBeTruthy();
  } finally {
    h.cleanup();
  }
});

test("createNode does not guard the rate when the processor carries no baked sampleRate", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode({ ...h.context, sampleRate: 44100 } as never, makeMockProcessor()),
      h.fireReady,
    );
    expect(node).toBeTruthy();
  } finally {
    h.cleanup();
  }
});

test("createNode calls audioWorklet.addModule with the moduleUrl", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    await startCreate(() => createNode(h.context as never, makeMockProcessor()), h.fireReady);
    expect(h.addModuleCalls).toEqual(["/_assets/x.worklet.js"]);
  } finally {
    h.cleanup();
  }
});

test("createNode fetches the wasmUrl", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    await startCreate(() => createNode(h.context as never, makeMockProcessor()), h.fireReady);
    expect(h.fetchCalls).toEqual(["/_assets/x.wasm"]);
  } finally {
    h.cleanup();
  }
});

test("createNode constructs AudioWorkletNode with correct port counts + channel layout", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            inputs: [{ name: "main", channels: 2 }],
            outputs: [
              { name: "main", channels: 2 },
              { name: "send", channels: 1 },
            ],
          }),
        ),
      h.fireReady,
    );
    expect(h.constructed).toHaveLength(1);
    const rec = h.constructed[0]!;
    expect(rec.name).toBe("stereoGain");
    expect(rec.options.numberOfInputs).toBe(1);
    expect(rec.options.numberOfOutputs).toBe(2);
    expect(rec.options.outputChannelCount).toEqual([2, 1]);
  } finally {
    h.cleanup();
  }
});

test("createNode passes a pre-compiled WebAssembly.Module through processorOptions (= no audio-thread sync compile)", async () => {
  const wasm = new Uint8Array([1, 2, 3, 4]);
  const h = installMockGlobals(wasm);
  try {
    await startCreate(() => createNode(h.context as never, makeMockProcessor()), h.fireReady);
    const opts = h.constructed[0]!.options;
    const sent = (opts.processorOptions as { module: WebAssembly.Module }).module;
    // The mock `WebAssembly.compile` stubs each call with a sentinel object;
    // the production path forwards that exact reference into processorOptions
    // so the audio thread can `new WebAssembly.Instance(module)` directly.
    expect(sent).toBeDefined();
    expect((sent as unknown as { __mockModuleId?: number }).__mockModuleId).toBe(0);
    // Old bytes-bag path must NOT be sent on the declarative path α (= avoids
    // sync `new WebAssembly.Module(bytes)` on the audio thread).
    expect((opts.processorOptions as { wasm?: Uint8Array }).wasm).toBeUndefined();
  } finally {
    h.cleanup();
  }
});

test("createNode forwards initial param values via parameterData", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    await startCreate(
      () => createNode(h.context as never, makeMockProcessor(), { initial: { gain: 0.5 } }),
      h.fireReady,
    );
    expect(h.constructed[0]!.options.parameterData).toEqual({ gain: 0.5 });
  } finally {
    h.cleanup();
  }
});

test("createNode resolves the Promise after the ready ack", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    expect(node).toBeDefined();
    expect(node.node).toBe(h.lastNode);
  } finally {
    h.cleanup();
  }
});

test("createNode caches addModule per (context, moduleUrl) — same context + same URL not re-loaded", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    await startCreate(() => createNode(h.context as never, makeMockProcessor()), h.fireReady);
    await startCreate(() => createNode(h.context as never, makeMockProcessor()), h.fireReady);
    expect(h.addModuleCalls).toEqual(["/_assets/x.worklet.js"]);
  } finally {
    h.cleanup();
  }
});

test("createNode dedupes addModule for concurrent calls with the same (context, moduleUrl)", async () => {
  // Regression for codex round-2 finding (high): two concurrent
  // `createNode()` calls for the same processor URL would each miss the
  // settled cache during `addModule`'s round-trip and both invoke
  // `audioWorklet.addModule(...)`. Browsers reject duplicate
  // `registerProcessor()` names with NotSupportedError, so the second of two
  // parallel loads would crash on real engines.
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  // Replace the synchronous mock addModule with an async one that resolves
  // only when the test releases it, so both `createNode` invocations are
  // genuinely in-flight when the cache lookup happens.
  let releaseAddModule!: () => void;
  const addModuleGate = new Promise<void>((resolve) => {
    releaseAddModule = resolve;
  });
  h.context.audioWorklet.addModule = (url: string): Promise<void> => {
    h.addModuleCalls.push(url);
    return addModuleGate;
  };
  try {
    const promiseA = createNode(h.context as never, makeMockProcessor());
    const promiseB = createNode(h.context as never, makeMockProcessor());
    // Let microtasks resolve so both calls enter `addModuleOnce` and the
    // cache decision is made before addModule settles.
    await new Promise((r) => setTimeout(r, 0));
    expect(h.addModuleCalls).toEqual(["/_assets/x.worklet.js"]);
    releaseAddModule();
    // Allow `addModule` to resolve and both flows to construct their nodes
    // before we fire the ready ack for both.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    h.fireReadyAll();
    await Promise.all([promiseA, promiseB]);
    expect(h.addModuleCalls).toEqual(["/_assets/x.worklet.js"]);
    expect(h.nodes).toHaveLength(2);
  } finally {
    h.cleanup();
  }
});

test("UnworkletNode.params.<name> wraps node.parameters.get(name)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({ params: [{ name: "gain" }, { name: "cutoff" }] }),
          { initial: { gain: 1, cutoff: 1000 } },
        ),
      h.fireReady,
    );
    expect(node.params.gain).toBeDefined();
    expect(node.params.cutoff).toBeDefined();
    expect(node.params.gain!.value).toBe(1);
    expect(node.params.cutoff!.value).toBe(1000);
  } finally {
    h.cleanup();
  }
});

test("UnworkletNode.outputs.<name>.connect routes through the node's output port index (AudioNode form)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            outputs: [
              { name: "main", channels: 2 },
              { name: "send", channels: 1 },
            ],
          }),
        ),
      h.fireReady,
    );
    const calls: Array<[unknown, number?, number?]> = [];
    h.lastNode!.connect = ((target, output, input) => {
      calls.push([target, output, input]);
      return target;
    }) as MockAudioWorkletNode["connect"];

    // AudioNode-shape destination (= has `.connect` method).
    const destinationNode = { connect: () => undefined };
    node.outputs.main!.connect(destinationNode as never);
    node.outputs.send!.connect(destinationNode as never);

    expect(calls).toEqual([
      [destinationNode, 0, 0],
      [destinationNode, 1, 0],
    ]);
  } finally {
    h.cleanup();
  }
});

test("UnworkletNode.outputs.<name>.connect uses the 2-arg overload for AudioParam destinations", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    const calls: Array<[unknown, number?, number?]> = [];
    h.lastNode!.connect = ((target, output, input) => {
      calls.push([target, output, input]);
      return target;
    }) as MockAudioWorkletNode["connect"];

    // AudioParam shape = no `.connect` method.
    const paramTarget = { value: 0 };
    node.outputs.main!.connect(paramTarget as never);

    expect(calls).toEqual([[paramTarget, 0, undefined]]);
  } finally {
    h.cleanup();
  }
});

test("UnworkletNode.inputs.<name> is an AudioNode destination already wired to the worklet port", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            inputs: [
              { name: "main", channels: 2 },
              { name: "sidechain", channels: 2 },
            ],
          }),
        ),
      h.fireReady,
    );
    // Spec: `source.connect(node.inputs.main)` — `.inputs.<name>` must be
    // an AudioNode the framework has already wired into the worklet's
    // input port at `portIdx`. The plugin uses a passthrough GainNode
    // proxy per port (= GainNode is an AudioNode and stays out of the
    // user's way).
    expect(h.createdGains).toHaveLength(2);
    expect(node.inputs.main).toBe(h.createdGains[0]);
    expect(node.inputs.sidechain).toBe(h.createdGains[1]);
    expect(h.createdGains[0]!.__outgoing).toEqual([{ target: h.lastNode, output: 0, input: 0 }]);
    expect(h.createdGains[1]!.__outgoing).toEqual([{ target: h.lastNode, output: 0, input: 1 }]);
  } finally {
    h.cleanup();
  }
});

test("UnworkletNode.dispose() disconnects every input proxy from the worklet node", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            inputs: [
              { name: "main", channels: 2 },
              { name: "sidechain", channels: 2 },
            ],
          }),
        ),
      h.fireReady,
    );
    expect(h.createdGains[0]!.__outgoing).toHaveLength(1);
    expect(h.createdGains[1]!.__outgoing).toHaveLength(1);
    node.dispose();
    // Internal `proxy → worklet` edges are gone = audio path through the
    // disposed node is dead, even if user sources are still wired into
    // the input proxies (= user owns the upstream graph).
    expect(h.createdGains[0]!.__outgoing).toHaveLength(0);
    expect(h.createdGains[1]!.__outgoing).toHaveLength(0);
  } finally {
    h.cleanup();
  }
});

test("UnworkletNode.onError receives block-length-mismatch messages posted by the worklet after ready", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    const received: unknown[] = [];
    node.onError((event) => {
      received.push(event);
    });
    for (const listener of h.lastNode!.port.__listeners) {
      listener({
        data: { kind: "error", code: "block-length-mismatch", expected: 128, received: 256 },
      });
    }
    // Subscriber receives a clean `NodeErrorEvent` shape = the worklet's
    // internal `kind: "error"` framing field is stripped by the
    // dispatcher.
    expect(received).toEqual([{ code: "block-length-mismatch", expected: 128, received: 256 }]);
  } finally {
    h.cleanup();
  }
});

test("UnworkletNode.onError translates a post-ready `processorerror` into a fixed-fallback wasm-trap event", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    const received: unknown[] = [];
    node.onError((event) => {
      received.push(event);
    });
    // MDN: `processorerror` is a plain `Event` with no portable payload.
    // Real structured trap info comes through the port message. Verify
    // the fallback marker does NOT read non-existent `.message`.
    for (const listener of h.lastNode!.__processorErrorListeners) {
      listener({} as Event);
    }
    expect(received).toEqual([
      { code: "wasm-trap", message: "AudioWorkletProcessor reported a failure (processorerror)" },
    ]);
  } finally {
    h.cleanup();
  }
});

test("UnworkletNode.onError unsubscribe stops further dispatch", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    const received: unknown[] = [];
    const unsub = node.onError((event) => {
      received.push(event);
    });
    unsub();
    for (const listener of h.lastNode!.port.__listeners) {
      listener({
        data: { kind: "error", code: "block-length-mismatch", expected: 128, received: 64 },
      });
    }
    expect(received).toEqual([]);
  } finally {
    h.cleanup();
  }
});

test("UnworkletNode.dispose() clears onError subscribers + removes long-lived listeners", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    const received: unknown[] = [];
    node.onError((event) => {
      received.push(event);
    });
    node.dispose();
    // After dispose, the long-lived message + processorerror listeners are
    // gone, so even if a stray event slips through nothing should reach the
    // subscriber.
    for (const listener of h.lastNode!.port.__listeners) {
      listener({
        data: { kind: "error", code: "block-length-mismatch", expected: 1, received: 2 },
      });
    }
    for (const listener of h.lastNode!.__processorErrorListeners) {
      listener({ message: "stray" } as unknown as Event);
    }
    expect(received).toEqual([]);
  } finally {
    h.cleanup();
  }
});

test("UnworkletNode.dispose() disconnects the underlying node + closes the port", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    let disconnectCalls = 0;
    let closeCalls = 0;
    h.lastNode!.disconnect = () => {
      disconnectCalls++;
    };
    h.lastNode!.port.close = () => {
      closeCalls++;
    };
    node.dispose();
    expect(disconnectCalls).toBe(1);
    expect(closeCalls).toBe(1);
  } finally {
    h.cleanup();
  }
});

test("createNode rejects when fetch(wasmUrl) returns a non-ok response", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), {
    fetchOk: false,
    fetchStatus: 404,
    fetchStatusText: "Not Found",
  });
  try {
    await expect(createNode(h.context as never, makeMockProcessor(), undefined)).rejects.toThrow(
      /404 Not Found/,
    );
  } finally {
    h.cleanup();
  }
});

test("createNode tears down the half-built worklet node when the handshake fails (init-error path)", async () => {
  // Codex round-7 finding 2: if the worklet posts init-error / fires
  // processorerror / never acks within the timeout, the caller never
  // receives an UnworkletNode and therefore cannot dispose() the
  // constructed AudioWorkletNode themselves. createNode() must clean up
  // the half-built node before rejecting, otherwise silent processors
  // accumulate inside the AudioContext.
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    let disconnectCalls = 0;
    let closeCalls = 0;
    const promise = createNode(h.context as never, makeMockProcessor(), undefined);
    await new Promise((r) => setTimeout(r, 0));
    // Hook the constructed node's cleanup paths before firing init-error.
    h.lastNode!.disconnect = () => {
      disconnectCalls++;
    };
    h.lastNode!.port.close = () => {
      closeCalls++;
    };
    h.fireInitError("WASM compile failed: bogus magic");
    await expect(promise).rejects.toThrow(/initialize\(\) failed/);
    expect(disconnectCalls).toBe(1);
    expect(closeCalls).toBe(1);
  } finally {
    h.cleanup();
  }
});

test("createNode rejects with the worklet message when it posts { kind: 'init-error' }", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const promise = createNode(h.context as never, makeMockProcessor(), undefined);
    await new Promise((r) => setTimeout(r, 0));
    h.fireInitError("WASM compile failed: invalid magic");
    await expect(promise).rejects.toThrow(/initialize\(\) failed.*invalid magic/);
  } finally {
    h.cleanup();
  }
});

test("createNode rejects on the `processorerror` event with whatever payload is available", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const promise = createNode(h.context as never, makeMockProcessor(), undefined);
    await new Promise((r) => setTimeout(r, 0));
    h.fireProcessorError("constructor blew up");
    await expect(promise).rejects.toThrow(/processorerror.*constructor blew up/);
  } finally {
    h.cleanup();
  }
});

test("createNode rejects with a timeout error when no ready / init-error / processorerror ever fires", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  vi.useFakeTimers();
  try {
    const promise = createNode(h.context as never, makeMockProcessor(), undefined);
    // Attach the rejection assertion synchronously (= before any timer
    // advance) to avoid `PromiseRejectionHandledWarning` from the timeout
    // firing before the .rejects handler observes it.
    const assertion = expect(promise).rejects.toThrow(/timed out after 10000ms/);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  } finally {
    vi.useRealTimers();
    h.cleanup();
  }
});

test("createNode rejects with cleanup if `port.start()` throws", async () => {
  // Spec-conformant engines no-op on `port.start()` after `addEventListener
  // ('message', ...)`; polyfilled / older engines can throw
  // InvalidStateError. Cover the cleanup-on-throw branch so the Promise
  // rejects cleanly + listeners / timer are not left pinned.
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { portStartThrows: true });
  try {
    const promise = createNode(h.context as never, makeMockProcessor(), undefined);
    await expect(promise).rejects.toThrow(/port already started/);
  } finally {
    h.cleanup();
  }
});

test("onError subscriber that throws does not break dispatch to other subscribers", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    const received: unknown[] = [];
    const originalConsoleError = console.error;
    const consoleErrorCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      consoleErrorCalls.push(args);
    };
    try {
      node.onError(() => {
        throw new Error("first subscriber blew up");
      });
      node.onError((event) => {
        received.push(event);
      });
      for (const listener of h.lastNode!.port.__listeners) {
        listener({
          data: { kind: "error", code: "block-length-mismatch", expected: 128, received: 64 },
        });
      }
      // Second subscriber must still have received the event despite the
      // first subscriber throwing. The throw is surfaced via console.error.
      expect(received).toEqual([{ code: "block-length-mismatch", expected: 128, received: 64 }]);
      expect(consoleErrorCalls.length).toBeGreaterThan(0);
    } finally {
      console.error = originalConsoleError;
    }
  } finally {
    h.cleanup();
  }
});

test("UnworkletNode.onError after dispose() is a no-op (= returns no-op unsubscribe, does not add handler)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    node.dispose();
    const received: unknown[] = [];
    const unsub = node.onError((event) => {
      received.push(event);
    });
    // Calling the returned unsubscribe must not throw, even though it is
    // a no-op (= we never added the handler in the first place).
    expect(() => unsub()).not.toThrow();
    // Dispatching after dispose cannot reach the late subscriber because
    // the listener has been removed from the underlying port + the
    // subscriber Set is cleared. Verify the late subscriber stays empty.
    for (const listener of h.lastNode!.port.__listeners) {
      listener({
        data: { kind: "error", code: "block-length-mismatch", expected: 1, received: 2 },
      });
    }
    expect(received).toEqual([]);
  } finally {
    h.cleanup();
  }
});

test("addModule cache drops rejected entries so a subsequent call can retry", async () => {
  // Transient network failures must not permanently poison
  // (context, moduleUrl). First call rejects → cache entry removed →
  // second call enters addModule fresh.
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    let callIdx = 0;
    h.context.audioWorklet.addModule = (url: string): Promise<void> => {
      h.addModuleCalls.push(url);
      callIdx++;
      if (callIdx === 1) {
        return Promise.reject(new Error("net::ERR_CONNECTION_REFUSED"));
      }
      return Promise.resolve();
    };
    const first = createNode(h.context as never, makeMockProcessor(), undefined);
    await expect(first).rejects.toThrow(/CONNECTION_REFUSED/);
    // Second attempt enters addModule again (= cache evicted).
    const second = createNode(h.context as never, makeMockProcessor(), undefined);
    await new Promise((r) => setTimeout(r, 0));
    h.fireReady();
    await second;
    expect(h.addModuleCalls).toEqual(["/_assets/x.worklet.js", "/_assets/x.worklet.js"]);
  } finally {
    h.cleanup();
  }
});

test("fetchAndCompileWasm uses WebAssembly.compileStreaming when the response is application/wasm", async () => {
  // Override fetch + compileStreaming to confirm the streaming branch
  // fires for application/wasm + the bytes path is skipped.
  const originalCompileStreaming = WebAssembly.compileStreaming;
  let streamingCalls = 0;
  const fakeModule = { __via: "streaming" };
  WebAssembly.compileStreaming = ((_response: Response | Promise<Response>) => {
    streamingCalls++;
    return Promise.resolve(fakeModule as unknown as WebAssembly.Module);
  }) as typeof WebAssembly.compileStreaming;
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    // Override the mock fetch to advertise application/wasm.
    globalThis.fetch = ((url: string) => {
      h.fetchCalls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: (_n: string) => "application/wasm" },
        arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(new ArrayBuffer(0)),
      });
    }) as typeof globalThis.fetch;
    await startCreate(() => createNode(h.context as never, makeMockProcessor()), h.fireReady);
    expect(streamingCalls).toBe(1);
  } finally {
    WebAssembly.compileStreaming = originalCompileStreaming;
    h.cleanup();
  }
});

test("outputs.<name>.disconnect calls node.disconnect with the right port index", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            outputs: [
              { name: "main", channels: 2 },
              { name: "send", channels: 1 },
            ],
          }),
        ),
      h.fireReady,
    );
    const calls: number[] = [];
    h.lastNode!.disconnect = ((arg: unknown) => {
      if (typeof arg === "number") calls.push(arg);
    }) as MockAudioWorkletNode["disconnect"];
    node.outputs.main!.disconnect();
    node.outputs.send!.disconnect();
    expect(calls).toEqual([0, 1]);
  } finally {
    h.cleanup();
  }
});

test("awaitReady: init-error message without a string payload falls back to '(no message)' in the rejection", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const promise = createNode(h.context as never, makeMockProcessor(), undefined);
    await new Promise((r) => setTimeout(r, 0));
    // Send init-error with no message field — covers the `typeof data.message
    // === "string"` false branch in awaitReady's onMessage handler.
    for (const listener of h.lastNode!.port.__listeners) {
      listener({ data: { kind: "init-error" } });
    }
    await expect(promise).rejects.toThrow(/\(no message\)/);
  } finally {
    h.cleanup();
  }
});

test("onErrorMessage drops non-object / null event.data without dispatching", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    const received: unknown[] = [];
    node.onError((event) => {
      received.push(event);
    });
    // Cover each early-return branch of onErrorMessage:
    for (const listener of h.lastNode!.port.__listeners) {
      listener({ data: null });
      listener({ data: 42 });
      listener({ data: "string event" });
    }
    expect(received).toEqual([]);
  } finally {
    h.cleanup();
  }
});

test("onErrorMessage drops messages whose kind is not 'error'", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    const received: unknown[] = [];
    node.onError((event) => {
      received.push(event);
    });
    for (const listener of h.lastNode!.port.__listeners) {
      listener({ data: { kind: "ready" } });
      listener({ data: { kind: "other-kind", code: "wasm-trap" } });
    }
    expect(received).toEqual([]);
  } finally {
    h.cleanup();
  }
});

test("onErrorMessage drops error messages with non-string or unknown code", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    const received: unknown[] = [];
    node.onError((event) => {
      received.push(event);
    });
    for (const listener of h.lastNode!.port.__listeners) {
      // Non-string code → early return.
      listener({ data: { kind: "error", code: 42 } });
      // Unknown code (= future / typo) → early return = guard against the
      // structured-union contract widening silently.
      listener({ data: { kind: "error", code: "some-future-code" } });
    }
    expect(received).toEqual([]);
  } finally {
    h.cleanup();
  }
});

test("UnworkletNode.dispose() is idempotent (= second call is a no-op)", async () => {
  // Cover the `if (disposed) return` guard.
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    let disconnectCalls = 0;
    h.lastNode!.disconnect = () => {
      disconnectCalls++;
    };
    node.dispose();
    node.dispose();
    // Second dispose() must short-circuit before re-running cleanup.
    expect(disconnectCalls).toBe(1);
  } finally {
    h.cleanup();
  }
});

test("awaitReady: stray events after settle are early-returned (= no double settle)", async () => {
  // Cover the `if (settled) return` guards in onMessage / onProcessorError /
  // timer. Drive a ready ack first (= settles), then fire init-error /
  // processorerror / advance the timer past timeout = no rejection should
  // occur because the promise already resolved.
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  vi.useFakeTimers();
  try {
    const promise = createNode(h.context as never, makeMockProcessor(), undefined);
    await vi.advanceTimersByTimeAsync(0);
    h.fireReady();
    const node = await promise;
    expect(node).toBeDefined();
    // The original awaitReady listeners are already removed by cleanup()
    // inside awaitReady — driving extra events should hit `settled === true`
    // returns inside the (already-detached) handlers if they are still
    // reachable through any closure. In practice cleanup removes them, so
    // these calls just verify no throws & no spurious rejection.
    expect(() => h.fireInitError("late")).not.toThrow();
    expect(() => h.fireProcessorError("late")).not.toThrow();
    await vi.advanceTimersByTimeAsync(15_000);
  } finally {
    vi.useRealTimers();
    h.cleanup();
  }
});

test("`inspect(blob)` decodes a snapshot blob into a structured view", async () => {
  const { encodeScalar } = await import("./snapshot.ts");
  const { encodeSnapshot } = await import("./snapshotBlob.ts");
  const blob = encodeSnapshot("schemaX", null, [
    { name: "gain", kind: "param", type: "f32", data: encodeScalar("f32", 0.5) },
    { name: "count", kind: "state", type: "i32", data: encodeScalar("i32", 9) },
  ]);
  const r = inspect(blob);
  expect(r.schemaHash).toBe("schemaX");
  expect(r.slots.gain).toEqual({ kind: "param", value: 0.5 });
  expect(r.slots.count).toEqual({ kind: "state", type: "i32", value: 9 });
});

test("`inspect(blob)` rejects a non-snapshot blob", () => {
  expect(() => inspect(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/bad magic/);
});

test("fetchAndCompileWasm falls back to '' when the response exposes no headers / get accessor", async () => {
  // Cover the `?? ""` fallback in `response.headers?.get?.("Content-Type") ?? ""`.
  // Some fetch polyfills / non-standard responses can omit `headers` entirely
  // or omit the `get` method on the headers bag — optional chaining must
  // resolve to "" so the regex test runs against an empty string rather than
  // throwing.
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    globalThis.fetch = ((url: string) => {
      h.fetchCalls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        // No `headers` property at all = optional chain resolves to undefined.
        arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(new ArrayBuffer(0)),
      });
    }) as typeof globalThis.fetch;
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    expect(node).toBeDefined();
  } finally {
    h.cleanup();
  }
});

test("buildParams skips params whose `node.parameters.get(name)` returns undefined", async () => {
  // Cover the `if (got)` else branch in buildParams — exercised when the
  // host engine returns `undefined` for a declared param name (= conservative
  // engines may return undefined if parameterData is partially populated).
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    // Override the parameters.get to return undefined for `cutoff`, a valid
    // AudioParam shape for `gain`.
    const originalAWN = (globalThis as Record<string, unknown>).AudioWorkletNode as new (
      ctx: unknown,
      name: string,
      opts: AudioWorkletNodeOptions,
    ) => MockAudioWorkletNode;
    (globalThis as Record<string, unknown>).AudioWorkletNode = class extends originalAWN {
      constructor(ctx: unknown, name: string, opts: AudioWorkletNodeOptions) {
        super(ctx, name, opts);
        this.parameters = {
          get: (paramName: string): MockAudioParam | undefined =>
            paramName === "gain" ? { value: 1 } : undefined,
        };
      }
    };
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({ params: [{ name: "gain" }, { name: "cutoff" }] }),
        ),
      h.fireReady,
    );
    // Only the param the host engine returned a non-undefined handle for
    // should appear on the node.
    expect(node.params.gain).toBeDefined();
    expect(node.params.cutoff).toBeUndefined();
  } finally {
    h.cleanup();
  }
});

test("awaitReady drops non-object / null data without rejecting (= early return + later ready settles)", async () => {
  // Cover the `if (typeof data !== 'object' || data === null) return` branch
  // inside `awaitReady`'s onMessage handler — exercised when an upstream
  // process posts arbitrary primitives through the port before the proper
  // `{ kind: "ready" }` ack arrives.
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const promise = createNode(h.context as never, makeMockProcessor(), undefined);
    await new Promise((r) => setTimeout(r, 0));
    for (const listener of h.lastNode!.port.__listeners) {
      // Each of these must be ignored by awaitReady (= no resolve, no reject).
      listener({ data: null });
      listener({ data: 42 });
      listener({ data: "string event" });
    }
    // Now send the real ready — promise should still resolve cleanly.
    h.fireReady();
    const node = await promise;
    expect(node).toBeDefined();
  } finally {
    h.cleanup();
  }
});

test("awaitReady ignores object data whose kind is neither 'ready' nor 'init-error'", async () => {
  // Cover the `if (data.kind === 'init-error')` else branch inside awaitReady.
  // An out-of-band message during handshake (= the long-lived runtime path
  // may post `{ kind: "error", ... }` before ready in some test orderings)
  // must be ignored by the handshake handler so the real `ready` still settles.
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const promise = createNode(h.context as never, makeMockProcessor(), undefined);
    await new Promise((r) => setTimeout(r, 0));
    for (const listener of h.lastNode!.port.__listeners) {
      // Object with a kind that is neither "ready" nor "init-error" = no-op.
      listener({ data: { kind: "error", code: "wasm-trap", message: "stray" } });
      listener({ data: { kind: "future-handshake-frame" } });
      // Object without a `kind` field at all.
      listener({ data: { unrelated: true } });
    }
    h.fireReady();
    const node = await promise;
    expect(node).toBeDefined();
  } finally {
    h.cleanup();
  }
});

test("awaitReady falls back to a fixed message when processorerror fires with no payload", async () => {
  // Cover the `errEvent.message || ...` fallback branch in awaitReady's
  // `onProcessorError` handler — MDN documents `processorerror` as a plain
  // `Event` with no portable `.message`, so the fallback string is what
  // surfaces in conformant engines.
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const promise = createNode(h.context as never, makeMockProcessor(), undefined);
    await new Promise((r) => setTimeout(r, 0));
    // Fire with NO message field = `errEvent.message` is undefined =
    // falsy → fallback string is used.
    for (const listener of h.lastNode!.__processorErrorListeners) {
      listener({} as Event);
    }
    await expect(promise).rejects.toThrow(
      /processorerror during init — AudioWorkletProcessor constructor threw/,
    );
  } finally {
    h.cleanup();
  }
});

test("awaitReady wraps non-Error throws from port.start() into a fresh Error", async () => {
  // Cover the `err instanceof Error ? err : new Error(String(err))` non-Error
  // branch — `port.start()` could conceivably throw a string / number /
  // plain object (= non-Error) in obscure polyfilled engines. The Promise
  // must still reject with an Error so downstream `.catch()` consumers see
  // a uniform shape.
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    // Re-install the mock node so port.start throws a non-Error string.
    const originalAWN = (globalThis as Record<string, unknown>).AudioWorkletNode as new (
      ctx: unknown,
      name: string,
      opts: AudioWorkletNodeOptions,
    ) => MockAudioWorkletNode;
    (globalThis as Record<string, unknown>).AudioWorkletNode = class extends originalAWN {
      constructor(ctx: unknown, name: string, opts: AudioWorkletNodeOptions) {
        super(ctx, name, opts);
        this.port.start = (): never => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw "raw-string-thrown-as-error";
        };
      }
    };
    const promise = createNode(h.context as never, makeMockProcessor(), undefined);
    await expect(promise).rejects.toThrow(/raw-string-thrown-as-error/);
  } finally {
    h.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Transport mode detection + SAB / fallback buffer allocation (sub-phase 7.4)
// ─────────────────────────────────────────────────────────────────────────

test("createNode without publishSlots omits publishBuffer from processorOptions entirely", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ publishSlots: [] })),
      h.fireReady,
    );
    const opts = h.lastNode!.__constructorRecord.options.processorOptions as Record<
      string,
      unknown
    >;
    expect(opts).not.toHaveProperty("publishBuffer");
    expect(opts).not.toHaveProperty("publishSlots");
  } finally {
    h.cleanup();
  }
});

test("createNode with publishSlots + crossOriginIsolated = SAB allocate + transport 'sab'", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            publishSlots: [{ name: "meter", type: "f32", sharedOffset: 0, counterOffset: 4 }],
          }),
        ),
      h.fireReady,
    );
    const opts = h.lastNode!.__constructorRecord.options.processorOptions as {
      publishBuffer: unknown;
      publishSlots: unknown;
      transport: string;
    };
    expect(opts.publishBuffer).toBeInstanceOf(SharedArrayBuffer);
    expect((opts.publishBuffer as SharedArrayBuffer).byteLength).toBe(12);
    expect(opts.transport).toBe("sab");
    expect(node.diagnostics.transport).toBe("sab");
  } finally {
    h.cleanup();
  }
});

test("createNode with messageRings + crossOriginIsolated = allocates SAB + passes messageRings to processorOptions", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const messageRingsFixture = [
      {
        name: "preset",
        wasmRingBase: 0,
        capacity: 16,
        slotSize: 4,
        fields: [{ name: "slot", wireType: "i32" as const, offsetInSlot: 0, byteSize: 4 }],
      },
    ];
    await startCreate(
      () =>
        createNode(h.context as never, makeMockProcessor({ messageRings: messageRingsFixture })),
      h.fireReady,
    );
    const opts = h.lastNode!.__constructorRecord.options.processorOptions as {
      messageRingsBuffer: unknown;
      messageRings: unknown;
      messageRingSabOffsets: number[];
      transport: string;
    };
    expect(opts.messageRingsBuffer).toBeInstanceOf(SharedArrayBuffer);
    // 1 ring = header 12 + 16 × 4 = 76
    expect((opts.messageRingsBuffer as SharedArrayBuffer).byteLength).toBe(76);
    expect(opts.messageRingSabOffsets).toEqual([0]);
    expect(opts.transport).toBe("sab");
  } finally {
    h.cleanup();
  }
});

test("createNode without messageRings omits messageRingsBuffer from processorOptions", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    await startCreate(() => createNode(h.context as never, makeMockProcessor()), h.fireReady);
    const opts = h.lastNode!.__constructorRecord.options.processorOptions as Record<
      string,
      unknown
    >;
    expect("messageRingsBuffer" in opts).toBe(false);
    expect("messageRings" in opts).toBe(false);
  } finally {
    h.cleanup();
  }
});

test("createNode with messageRings + !crossOriginIsolated = no messageRingsBuffer + descriptor only", async () => {
  // postMessage path: the main side sends directly via
  // `port.postMessage({ kind: 'message', ... })`; the worklet receives it
  // via self.port.onmessage and injects into the WASM ring, so no shared
  // buffer is needed.
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  try {
    await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            messageRings: [
              {
                name: "preset",
                wasmRingBase: 0,
                capacity: 16,
                slotSize: 4,
                fields: [{ name: "slot", wireType: "i32" as const, offsetInSlot: 0, byteSize: 4 }],
              },
            ],
          }),
        ),
      h.fireReady,
    );
    const opts = h.lastNode!.__constructorRecord.options.processorOptions as {
      messageRingsBuffer?: unknown;
      messageRings?: unknown;
      transport?: string;
    };
    expect(opts.messageRingsBuffer).toBeUndefined();
    expect(opts.messageRings).toBeDefined();
    expect(opts.transport).toBe("postMessage");
  } finally {
    h.cleanup();
  }
});

test("createNode with eventRings + crossOriginIsolated = allocates SAB + passes eventRings to processorOptions", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const eventRingsFixture = [
      {
        name: "peak",
        wasmRingBase: 0,
        capacity: 16,
        slotSize: 8, // atSample (4) + level (4)
        fields: [
          { name: "atSample", wireType: "i32" as const, offsetInSlot: 0, byteSize: 4 },
          { name: "level", wireType: "f32" as const, offsetInSlot: 4, byteSize: 4 },
        ],
      },
    ];
    await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ eventRings: eventRingsFixture })),
      h.fireReady,
    );
    const opts = h.lastNode!.__constructorRecord.options.processorOptions as {
      eventRingsBuffer: unknown;
      eventRings: unknown;
      eventRingSabOffsets: number[];
      transport: string;
    };
    expect(opts.eventRingsBuffer).toBeInstanceOf(SharedArrayBuffer);
    // 1 ring = header 12 + 16 × 8 = 140
    expect((opts.eventRingsBuffer as SharedArrayBuffer).byteLength).toBe(140);
    expect(opts.eventRingSabOffsets).toEqual([0]);
    expect(opts.transport).toBe("sab");
  } finally {
    h.cleanup();
  }
});

test("createNode with 2 eventRings = contiguous SAB layout with cumulative sabOffsets", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const eventRingsFixture = [
      {
        name: "evt1",
        wasmRingBase: 0,
        capacity: 16,
        slotSize: 8,
        fields: [
          { name: "atSample", wireType: "i32" as const, offsetInSlot: 0, byteSize: 4 },
          { name: "level", wireType: "f32" as const, offsetInSlot: 4, byteSize: 4 },
        ],
      },
      {
        name: "evt2",
        wasmRingBase: 140,
        capacity: 4,
        slotSize: 4,
        fields: [{ name: "atSample", wireType: "i32" as const, offsetInSlot: 0, byteSize: 4 }],
      },
    ];
    await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ eventRings: eventRingsFixture })),
      h.fireReady,
    );
    const opts = h.lastNode!.__constructorRecord.options.processorOptions as {
      eventRingsBuffer: SharedArrayBuffer;
      eventRingSabOffsets: number[];
    };
    // evt1 = 140 bytes, evt2 = 12 + 4 × 4 = 28 bytes, total 168
    expect(opts.eventRingsBuffer.byteLength).toBe(168);
    expect(opts.eventRingSabOffsets).toEqual([0, 140]);
  } finally {
    h.cleanup();
  }
});

test("createNode without eventRings omits eventRingsBuffer from processorOptions", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    await startCreate(() => createNode(h.context as never, makeMockProcessor()), h.fireReady);
    const opts = h.lastNode!.__constructorRecord.options.processorOptions as Record<
      string,
      unknown
    >;
    expect("eventRingsBuffer" in opts).toBe(false);
    expect("eventRings" in opts).toBe(false);
  } finally {
    h.cleanup();
  }
});

test("createNode with eventRings + !crossOriginIsolated = no eventRingsBuffer + descriptor only", async () => {
  // postMessage path: structured-clone would produce separate ring instances
  // on main and worklet (= mirroring impossible), so no buffer is handed over.
  // The worklet delivers new events individually via port.postMessage.
  // Only the eventRings descriptor + transport are passed.
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  try {
    await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            eventRings: [
              {
                name: "peak",
                wasmRingBase: 0,
                capacity: 16,
                slotSize: 8,
                fields: [
                  { name: "atSample", wireType: "i32" as const, offsetInSlot: 0, byteSize: 4 },
                  { name: "level", wireType: "f32" as const, offsetInSlot: 4, byteSize: 4 },
                ],
              },
            ],
          }),
        ),
      h.fireReady,
    );
    const opts = h.lastNode!.__constructorRecord.options.processorOptions as {
      eventRingsBuffer?: unknown;
      eventRings?: unknown;
      transport?: string;
    };
    expect(opts.eventRingsBuffer).toBeUndefined();
    expect(opts.eventRings).toBeDefined();
    expect(opts.transport).toBe("postMessage");
  } finally {
    h.cleanup();
  }
});

test("createNode with publishSlots + !crossOriginIsolated = no publishBuffer + transport 'postMessage' + descriptor only", async () => {
  // postMessage path: structured-clone would produce a separate ArrayBuffer
  // instance (= mirroring impossible), so publishBuffer is not handed over.
  // The worklet notifies via port.postMessage, making the main-side buffer
  // unnecessary. Only the publishSlots descriptor + transport are passed.
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            publishSlots: [
              { name: "a", type: "f32", sharedOffset: 0, counterOffset: 4 },
              { name: "b", type: "i32", sharedOffset: 12, counterOffset: 16 },
            ],
          }),
        ),
      h.fireReady,
    );
    const opts = h.lastNode!.__constructorRecord.options.processorOptions as {
      publishBuffer?: unknown;
      publishSlots?: unknown;
      transport?: string;
    };
    expect(opts.publishBuffer).toBeUndefined();
    expect(opts.publishSlots).toBeDefined();
    expect(opts.transport).toBe("postMessage");
    expect(node.diagnostics.transport).toBe("postMessage");
  } finally {
    h.cleanup();
  }
});

test("createNode without publishSlots inherits transport from environment (= sab when crossOriginIsolated)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ publishSlots: [] })),
      h.fireReady,
    );
    expect(node.diagnostics.transport).toBe("sab");
  } finally {
    h.cleanup();
  }
});

test("createNode warns once per context when the page is not cross-origin isolated", async () => {
  // `onError({ code: 'sab-unavailable' })` is opt-in; a dev who never subscribes
  // would get no signal. A default console warning makes the fallback visible.
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  try {
    await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ publishSlots: [] })),
      h.fireReady,
    );
    await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ publishSlots: [] })),
      h.fireReady,
    );
    // One warning for the context, not one per node …
    expect(h.warnCalls).toHaveLength(1);
    // … and it names the fix.
    expect(h.warnCalls[0]).toMatch(/cross-origin isolated/i);
    expect(h.warnCalls[0]).toMatch(/Cross-Origin-Embedder-Policy/);
  } finally {
    h.cleanup();
  }
});

test("createNode does not warn when the page is cross-origin isolated", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2])); // isolated by default
  try {
    await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ publishSlots: [] })),
      h.fireReady,
    );
    expect(h.warnCalls).toHaveLength(0);
  } finally {
    h.cleanup();
  }
});

test("first onError subscriber receives `{ code: 'sab-unavailable' }` exactly once in a sab-unavailable environment", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ publishSlots: [] })),
      h.fireReady,
    );
    const events: unknown[] = [];
    node.onError((e) => events.push(e));
    expect(events).toEqual([{ code: "sab-unavailable" }]);
    // second subscriber: pending already cleared, receives nothing
    const events2: unknown[] = [];
    node.onError((e) => events2.push(e));
    expect(events2).toEqual([]);
  } finally {
    h.cleanup();
  }
});

test("onError does not fire sab-unavailable in a SAB-available environment (regression guard)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ publishSlots: [] })),
      h.fireReady,
    );
    const events: unknown[] = [];
    node.onError((e) => events.push(e));
    expect(events).toEqual([]);
  } finally {
    h.cleanup();
  }
});

test("node.state.<name>.value synchronously reads published values in SAB mode (f32 / i32 / bool)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            publishSlots: [
              { name: "vF32", type: "f32", sharedOffset: 0, counterOffset: 4 },
              { name: "vI32", type: "i32", sharedOffset: 12, counterOffset: 16 },
              { name: "vBool", type: "bool", sharedOffset: 24, counterOffset: 28 },
            ],
          }),
        ),
      h.fireReady,
    );
    // Write directly into the SAB, simulating the worklet's copy path
    const buf = h.lastNode!.__constructorRecord.options.processorOptions!
      .publishBuffer as SharedArrayBuffer;
    const view = new Int32Array(buf);
    // write f32 0.5 as its bit pattern
    const f32Buf = new Float32Array([0.5]);
    const f32Bits = new Int32Array(f32Buf.buffer)[0]!;
    Atomics.store(view, 0, f32Bits);
    Atomics.store(view, 3, 42); // i32
    Atomics.store(view, 6, 1); // bool: true
    expect(node.state["vF32"]!.value).toBe(0.5);
    expect(node.state["vI32"]!.value).toBe(42);
    expect(node.state["vBool"]!.value).toBe(true);
    // bool: false
    Atomics.store(view, 6, 0);
    expect(node.state["vBool"]!.value).toBe(false);
  } finally {
    h.cleanup();
  }
});

test("node.state.<name>.value reads mirror updated via onPublishMessage in postMessage mode", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            publishSlots: [{ name: "vI32", type: "i32", sharedOffset: 0, counterOffset: 4 }],
          }),
        ),
      h.fireReady,
    );
    // initial value = mirror at 0, so .value is 0
    expect(node.state["vI32"]!.value).toBe(0);
    // simulate the publish message the worklet sends on version advance
    // (= onPublishMessage updates the mirror via the port listener)
    for (const listener of h.lastNode!.port.__listeners) {
      listener({
        data: { kind: "publish", slotIndex: 0, valueBits: 99, sampleCounter: 0, version: 1 },
      } as MessageEvent);
    }
    expect(node.state["vI32"]!.value).toBe(99);
  } finally {
    h.cleanup();
  }
});

test("node.state.<name>.subscribe(handler) registers a subscriber and returns an unsubscribe function", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            publishSlots: [{ name: "v", type: "f32", sharedOffset: 0, counterOffset: 4 }],
          }),
        ),
      h.fireReady,
    );
    const calls: unknown[] = [];
    const unsub = node.state["v"]!.subscribe((v) => calls.push(v));
    expect(typeof unsub).toBe("function");
    unsub();
    // after unsubscribe the handler does not fire on polling driver fill; confirm the subscriber set is cleared
    expect(calls).toEqual([]);
  } finally {
    h.cleanup();
  }
});

test("processor with no publishSlots produces an empty node.state object (regression guard)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ publishSlots: [] })),
      h.fireReady,
    );
    expect(Object.keys(node.state)).toEqual([]);
  } finally {
    h.cleanup();
  }
});

/**
 * rAF mock: drives requestAnimationFrame manually.
 * Collects ticks and invokes them synchronously on `flush()`, letting tests
 * observe the polling driver. cancelAnimationFrame removes handles so
 * dispose-time stop checks are verifiable.
 */
type RafHook = {
  flush: () => void;
  cancelledHandles: number[];
  pending: number;
  restore: () => void;
};

const installRafMock = (): RafHook => {
  const callbacks = new Map<number, () => void>();
  let nextHandle = 1;
  const cancelledHandles: number[] = [];
  const target = globalThis as unknown as {
    requestAnimationFrame?: (cb: () => void) => number;
    cancelAnimationFrame?: (handle: number) => void;
  };
  const prevRaf = target.requestAnimationFrame;
  const prevCancel = target.cancelAnimationFrame;
  target.requestAnimationFrame = (cb: () => void): number => {
    const handle = nextHandle++;
    callbacks.set(handle, cb);
    return handle;
  };
  target.cancelAnimationFrame = (handle: number): void => {
    cancelledHandles.push(handle);
    callbacks.delete(handle);
  };
  return {
    flush(): void {
      // Invoke all currently pending callbacks. Re-schedules made during flush
      // are deferred to the next flush call.
      const snapshot = [...callbacks.entries()];
      callbacks.clear();
      for (const [, cb] of snapshot) {
        cb();
      }
    },
    cancelledHandles,
    get pending(): number {
      return callbacks.size;
    },
    restore(): void {
      if (prevRaf === undefined) {
        delete target.requestAnimationFrame;
      } else {
        target.requestAnimationFrame = prevRaf;
      }
      if (prevCancel === undefined) {
        delete target.cancelAnimationFrame;
      } else {
        target.cancelAnimationFrame = prevCancel;
      }
    },
  };
};

test("polling driver fires handler when a version increment is detected on a rAF tick after subscribe", async () => {
  const raf = installRafMock();
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            publishSlots: [{ name: "v", type: "i32", sharedOffset: 0, counterOffset: 4 }],
          }),
        ),
      h.fireReady,
    );
    const buf = h.lastNode!.__constructorRecord.options.processorOptions!
      .publishBuffer as SharedArrayBuffer;
    const view = new Int32Array(buf);
    const calls: unknown[] = [];
    node.state["v"]!.subscribe((value) => calls.push(value));

    // first flush: version 0 = no change = no fire
    raf.flush();
    expect(calls).toEqual([]);

    // mock the worklet publish path: write value 42, version 1 directly into SAB
    Atomics.store(view, 0, 42);
    Atomics.store(view, 2, 1);
    raf.flush();
    expect(calls).toEqual([42]);

    // second publish: value 99, version 2
    Atomics.store(view, 0, 99);
    Atomics.store(view, 2, 2);
    raf.flush();
    expect(calls).toEqual([42, 99]);
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("polling driver stops the rAF loop when all subscribers unsubscribe (no polling wasted at zero subscribers)", async () => {
  const raf = installRafMock();
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            publishSlots: [{ name: "v", type: "i32", sharedOffset: 0, counterOffset: 4 }],
          }),
        ),
      h.fireReady,
    );
    const unsub = node.state["v"]!.subscribe(() => {});
    // SAB mode: subscribe starts the rAF polling loop (1 tick scheduled)
    expect(raf.pending).toBe(1);

    unsub();
    // All subscribers on all slots are now zero: rAF loop stops. This avoids
    // per-frame polling waste on the main thread after a temporary subscribe →
    // unsubscribe while the node is still alive.
    expect(raf.pending).toBe(0);
    expect(raf.cancelledHandles.length).toBeGreaterThan(0);
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("polling driver fires on every version increment even when the value is unchanged (no deduplication, Q39-b)", async () => {
  const raf = installRafMock();
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            publishSlots: [{ name: "v", type: "i32", sharedOffset: 0, counterOffset: 4 }],
          }),
        ),
      h.fireReady,
    );
    const buf = h.lastNode!.__constructorRecord.options.processorOptions!
      .publishBuffer as SharedArrayBuffer;
    const view = new Int32Array(buf);
    const calls: unknown[] = [];
    node.state["v"]!.subscribe((value) => calls.push(value));
    Atomics.store(view, 0, 50);
    Atomics.store(view, 2, 1);
    raf.flush();
    Atomics.store(view, 0, 50); // same value
    Atomics.store(view, 2, 2); // version incremented
    raf.flush();
    expect(calls).toEqual([50, 50]);
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("polling driver fires all subscribers with the same value; first subscriber throwing does not block the second", async () => {
  const raf = installRafMock();
  const originalConsoleError = console.error;
  const errLogs: unknown[] = [];
  console.error = ((...a: unknown[]) => {
    errLogs.push(a);
  }) as typeof console.error;
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            publishSlots: [{ name: "v", type: "i32", sharedOffset: 0, counterOffset: 4 }],
          }),
        ),
      h.fireReady,
    );
    const buf = h.lastNode!.__constructorRecord.options.processorOptions!
      .publishBuffer as SharedArrayBuffer;
    const view = new Int32Array(buf);
    const calls: unknown[] = [];
    node.state["v"]!.subscribe(() => {
      throw new Error("first sub blew up");
    });
    node.state["v"]!.subscribe((value) => calls.push(value));
    Atomics.store(view, 0, 7);
    Atomics.store(view, 2, 1);
    raf.flush();
    expect(calls).toEqual([7]);
    expect(errLogs.length).toBeGreaterThan(0);
  } finally {
    console.error = originalConsoleError;
    h.cleanup();
    raf.restore();
  }
});

test("polling driver skips unsubscribed handler and stops rAF on dispose", async () => {
  const raf = installRafMock();
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            publishSlots: [{ name: "v", type: "i32", sharedOffset: 0, counterOffset: 4 }],
          }),
        ),
      h.fireReady,
    );
    const buf = h.lastNode!.__constructorRecord.options.processorOptions!
      .publishBuffer as SharedArrayBuffer;
    const view = new Int32Array(buf);
    const calls: unknown[] = [];
    const unsub = node.state["v"]!.subscribe((value) => calls.push(value));
    Atomics.store(view, 0, 1);
    Atomics.store(view, 2, 1);
    raf.flush();
    expect(calls).toEqual([1]);
    unsub();
    Atomics.store(view, 0, 2);
    Atomics.store(view, 2, 2);
    raf.flush();
    expect(calls).toEqual([1]); // no increase
    // dispose stops rAF: pending = 0 + the previous handle is cancelled
    node.dispose();
    expect(raf.cancelledHandles.length).toBeGreaterThan(0);
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("publish dispatch in postMessage mode fires subscribers immediately via port.onmessage (no rAF polling)", async () => {
  // postMessage path: no rAF polling needed. A dispatched port.onmessage fires
  // subscribers immediately. The rAF mock is installed to confirm no firing
  // happens before flush (= polling driver is not started).
  const raf = installRafMock();
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            publishSlots: [{ name: "v", type: "i32", sharedOffset: 0, counterOffset: 4 }],
          }),
        ),
      h.fireReady,
    );
    const calls: unknown[] = [];
    node.state["v"]!.subscribe((value) => calls.push(value));
    // simulate a worklet publish (confirms subscriber fires before any rAF flush)
    for (const listener of h.lastNode!.port.__listeners) {
      listener({
        data: { kind: "publish", slotIndex: 0, valueBits: 88, sampleCounter: 0, version: 1 },
      } as MessageEvent);
    }
    expect(calls).toEqual([88]);
    // rAF flush produces no additional fires: polling driver is not started
    // on the postMessage path and the already-fired event is port-driven
    raf.flush();
    expect(calls).toEqual([88]);
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("polling driver: dispose in an environment without cancelAnimationFrame only nulls the handle (no throw)", async () => {
  const target = globalThis as unknown as {
    requestAnimationFrame?: (cb: () => void) => number;
    cancelAnimationFrame?: (handle: number) => void;
  };
  const prevRaf = target.requestAnimationFrame;
  const prevCancel = target.cancelAnimationFrame;
  target.requestAnimationFrame = (_cb: () => void): number => 999;
  delete target.cancelAnimationFrame;
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            publishSlots: [{ name: "v", type: "i32", sharedOffset: 0, counterOffset: 4 }],
          }),
        ),
      h.fireReady,
    );
    node.state["v"]!.subscribe(() => {});
    // cancelAnimationFrame absent on dispose: guard skips the call and nulls the handle
    expect(() => node.dispose()).not.toThrow();
  } finally {
    h.cleanup();
    if (prevRaf !== undefined) target.requestAnimationFrame = prevRaf;
    else delete target.requestAnimationFrame;
    if (prevCancel !== undefined) target.cancelAnimationFrame = prevCancel;
  }
});

test("polling driver: subscribe in an environment without requestAnimationFrame only adds to the subscriber set (rAF skipped)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  // Remove rAF to mock an environment without a polyfill
  const target = globalThis as unknown as {
    requestAnimationFrame?: (cb: () => void) => number;
  };
  const prevRaf = target.requestAnimationFrame;
  delete target.requestAnimationFrame;
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            publishSlots: [{ name: "v", type: "i32", sharedOffset: 0, counterOffset: 4 }],
          }),
        ),
      h.fireReady,
    );
    const unsub = node.state["v"]!.subscribe(() => {});
    expect(typeof unsub).toBe("function");
  } finally {
    h.cleanup();
    if (prevRaf !== undefined) target.requestAnimationFrame = prevRaf;
  }
});

test("pending sab-unavailable is cleared even when the first onError subscriber throws (second subscriber receives nothing)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  const originalConsoleError = console.error;
  const errs: unknown[] = [];
  console.error = ((...a: unknown[]) => {
    errs.push(a);
  }) as typeof console.error;
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ publishSlots: [] })),
      h.fireReady,
    );
    node.onError(() => {
      throw new Error("first sub blew up");
    });
    expect(errs.length).toBeGreaterThan(0);
    const events: unknown[] = [];
    node.onError((e) => events.push(e));
    expect(events).toEqual([]);
  } finally {
    console.error = originalConsoleError;
    h.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// node.events.<name>.on / diagnostics (sub-phase 7.6 commit 6)
//
// Main-thread surface for the worklet → main moment-in-time delivery path.
// Shares the rAF polling loop with the state subscribe path; drains the SAB
// via the zip path, reinterprets each slot per-field, and hands plain JS
// values to handlers.
// ─────────────────────────────────────────────────────────────────────────

const peakEventRing = {
  name: "peak",
  wasmRingBase: 0,
  capacity: 16,
  slotSize: 8,
  fields: [
    { name: "atSample", wireType: "i32" as const, offsetInSlot: 0, byteSize: 4 },
    { name: "level", wireType: "f32" as const, offsetInSlot: 4, byteSize: 4 },
  ],
};

test("node.events.<name>.on: subscribe + emit simulation fires handler on rAF tick", async () => {
  const raf = installRafMock();
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ eventRings: [peakEventRing] })),
      h.fireReady,
    );
    const eventBuf = h.lastNode!.__constructorRecord.options.processorOptions!
      .eventRingsBuffer as SharedArrayBuffer;
    const calls: Array<{ atSample: number; level: number }> = [];
    node.events["peak"]!.on((p) => calls.push(p as { atSample: number; level: number }));

    // head = 0: nothing to drain
    raf.flush();
    expect(calls).toEqual([]);

    // simulate a worklet emit: head = 1, slot 0 = atSample 5 / level 0.75
    const header = new Int32Array(eventBuf, 0, 3);
    const slot0 = new DataView(eventBuf, 12);
    slot0.setInt32(0, 5, true);
    slot0.setFloat32(4, 0.75, true);
    Atomics.store(header, 0, 1);
    raf.flush();
    expect(calls).toEqual([{ atSample: 5, level: 0.75 }]);

    // second emit: head = 2, slot 1 = atSample 7 / level 0.5
    slot0.setInt32(8, 7, true);
    slot0.setFloat32(12, 0.5, true);
    Atomics.store(header, 0, 2);
    raf.flush();
    expect(calls).toEqual([
      { atSample: 5, level: 0.75 },
      { atSample: 7, level: 0.5 },
    ]);
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("node.events.<name>.on: multiple subscribers fire in registration order", async () => {
  const raf = installRafMock();
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ eventRings: [peakEventRing] })),
      h.fireReady,
    );
    const eventBuf = h.lastNode!.__constructorRecord.options.processorOptions!
      .eventRingsBuffer as SharedArrayBuffer;
    const order: string[] = [];
    node.events["peak"]!.on(() => order.push("a"));
    node.events["peak"]!.on(() => order.push("b"));

    const header = new Int32Array(eventBuf, 0, 3);
    const slot0 = new DataView(eventBuf, 12);
    slot0.setInt32(0, 0, true);
    slot0.setFloat32(4, 1, true);
    Atomics.store(header, 0, 1);
    raf.flush();
    expect(order).toEqual(["a", "b"]);
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("node.events.<name>.on: handler does not fire after unsubscribe", async () => {
  const raf = installRafMock();
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ eventRings: [peakEventRing] })),
      h.fireReady,
    );
    const eventBuf = h.lastNode!.__constructorRecord.options.processorOptions!
      .eventRingsBuffer as SharedArrayBuffer;
    const calls: unknown[] = [];
    const unsub = node.events["peak"]!.on((p) => calls.push(p));

    const header = new Int32Array(eventBuf, 0, 3);
    const slot0 = new DataView(eventBuf, 12);
    slot0.setInt32(0, 0, true);
    slot0.setFloat32(4, 0.1, true);
    Atomics.store(header, 0, 1);
    raf.flush();
    expect(calls.length).toBe(1);

    unsub();
    slot0.setInt32(8, 1, true);
    slot0.setFloat32(12, 0.2, true);
    Atomics.store(header, 0, 2);
    raf.flush();
    expect(calls.length).toBe(1); // after unsubscribe: no further fires
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("node.events.<name>.diagnostics.overflowCount reads from the SAB via Atomics.load", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ eventRings: [peakEventRing] })),
      h.fireReady,
    );
    const eventBuf = h.lastNode!.__constructorRecord.options.processorOptions!
      .eventRingsBuffer as SharedArrayBuffer;
    const header = new Int32Array(eventBuf, 0, 3);
    expect(node.events["peak"]!.diagnostics.overflowCount()).toBe(0);
    Atomics.store(header, 2, 42); // set overflowCount = 42
    expect(node.events["peak"]!.diagnostics.overflowCount()).toBe(42);
  } finally {
    h.cleanup();
  }
});

test("node.events.<name>.on: dispose clears all subscribers and stops further fires", async () => {
  const raf = installRafMock();
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ eventRings: [peakEventRing] })),
      h.fireReady,
    );
    const eventBuf = h.lastNode!.__constructorRecord.options.processorOptions!
      .eventRingsBuffer as SharedArrayBuffer;
    const calls: unknown[] = [];
    node.events["peak"]!.on((p) => calls.push(p));
    node.dispose();

    const header = new Int32Array(eventBuf, 0, 3);
    const slot0 = new DataView(eventBuf, 12);
    slot0.setInt32(0, 0, true);
    slot0.setFloat32(4, 0.1, true);
    Atomics.store(header, 0, 1);
    raf.flush();
    expect(calls).toEqual([]);
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("node.events is an empty object for a processor with no event rings", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    expect(node.events).toEqual({});
  } finally {
    h.cleanup();
  }
});

test("node.events.<name>.on: f64 / i64 / bool fields are delivered as plain JS values", async () => {
  const raf = installRafMock();
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const wideRing = {
      name: "wide",
      wasmRingBase: 0,
      capacity: 4,
      slotSize: 24, // atSample (4) + f64 (8) + i64 (8) + bool (4) = 24
      fields: [
        { name: "atSample", wireType: "i32" as const, offsetInSlot: 0, byteSize: 4 },
        { name: "amp", wireType: "f64" as const, offsetInSlot: 4, byteSize: 8 },
        { name: "tick", wireType: "i64" as const, offsetInSlot: 12, byteSize: 8 },
        { name: "flag", wireType: "bool" as const, offsetInSlot: 20, byteSize: 4 },
      ],
    };
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ eventRings: [wideRing] })),
      h.fireReady,
    );
    const eventBuf = h.lastNode!.__constructorRecord.options.processorOptions!
      .eventRingsBuffer as SharedArrayBuffer;
    const calls: Array<Record<string, unknown>> = [];
    node.events["wide"]!.on((p) => calls.push(p as Record<string, unknown>));

    const header = new Int32Array(eventBuf, 0, 3);
    const slot0 = new DataView(eventBuf, 12);
    slot0.setInt32(0, 9, true); // atSample
    slot0.setFloat64(4, 1.5, true); // amp
    slot0.setBigInt64(12, 42n, true); // tick
    slot0.setInt32(20, 1, true); // flag = true
    Atomics.store(header, 0, 1);
    raf.flush();
    expect(calls).toEqual([{ atSample: 9, amp: 1.5, tick: 42n, flag: true }]);
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("node.events.<name>.on: postMessage transport updates subscribers and diagnostics immediately via port.onmessage", async () => {
  // postMessage path: the worklet posts `{ kind: 'event', ringIndex,
  // newSlotsBytes, newSlotCount, overflowCount }`. The main side decodes the
  // payload via onEventMessage, fires subscribers immediately, and mirrors
  // overflowCount. No rAF flush needed.
  const raf = installRafMock();
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ eventRings: [peakEventRing] })),
      h.fireReady,
    );
    const calls: unknown[] = [];
    node.events["peak"]!.on((p) => calls.push(p));
    // Build a newSlotsBytes buffer for 1 slot (atSample i32 + level f32 = 8 bytes)
    const slotBuf = new ArrayBuffer(8);
    const view = new DataView(slotBuf);
    view.setInt32(0, 3, true);
    view.setFloat32(4, 0.5, true);
    // simulate an event message dispatch via the port listener
    for (const listener of h.lastNode!.port.__listeners) {
      listener({
        data: {
          kind: "event",
          ringIndex: 0,
          newSlotsBytes: slotBuf,
          newSlotCount: 1,
          overflowCount: 7,
        },
      } as MessageEvent);
    }
    expect(calls).toEqual([{ atSample: 3, level: 0.5 }]);
    expect(node.events["peak"]!.diagnostics.overflowCount()).toBe(7);
    // rAF flush produces no additional fires (port-driven, no polling needed)
    raf.flush();
    expect(calls).toEqual([{ atSample: 3, level: 0.5 }]);
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("node.events.<name>.on: when drop-oldest advances sabTail past the local tail, main resets its drain start position", async () => {
  // When the worklet fires drop-oldest, the SAB tail advances past the main
  // local tail. The main side then resets drain start to max(localTail, sabTail).
  const raf = installRafMock();
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ eventRings: [peakEventRing] })),
      h.fireReady,
    );
    const eventBuf = h.lastNode!.__constructorRecord.options.processorOptions!
      .eventRingsBuffer as SharedArrayBuffer;
    const calls: Array<Record<string, unknown>> = [];
    node.events["peak"]!.on((p) => calls.push(p as Record<string, unknown>));
    const header = new Int32Array(eventBuf, 0, 3);
    const slotsView = new DataView(eventBuf, 12);
    // After many emits + repeated drop-oldest on the worklet: head = 20, tail = 4
    // (ring filled with 16 slots, 4 dropped). Main local tail = 0, sabTail = 4,
    // so drain resets to tail = 4.
    for (let i = 0; i < 16; i++) {
      const slotIdx = (4 + i) % 16;
      slotsView.setInt32(slotIdx * 8, 4 + i, true); // atSample
      slotsView.setFloat32(slotIdx * 8 + 4, (4 + i) * 0.01, true); // level
    }
    Atomics.store(header, 1, 4); // tail = 4
    Atomics.store(header, 0, 20); // head = 20
    raf.flush();
    // drain resets to tail = 4, draining 16 slots in atSample order 4..19
    expect(calls.length).toBe(16);
    expect(calls[0]).toEqual({ atSample: 4, level: Math.fround(0.04) });
    expect(calls[15]).toEqual({ atSample: 19, level: Math.fround(0.19) });
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("node.events.<name>.on: handler throw is caught and logged to console.error; subsequent handlers still fire", async () => {
  const raf = installRafMock();
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  const originalConsoleError = console.error;
  const errs: unknown[] = [];
  console.error = (...args: unknown[]) => errs.push(args);
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ eventRings: [peakEventRing] })),
      h.fireReady,
    );
    const eventBuf = h.lastNode!.__constructorRecord.options.processorOptions!
      .eventRingsBuffer as SharedArrayBuffer;
    const goodCalls: unknown[] = [];
    node.events["peak"]!.on(() => {
      throw new Error("handler blew up");
    });
    node.events["peak"]!.on((p) => goodCalls.push(p));

    const header = new Int32Array(eventBuf, 0, 3);
    const slot0 = new DataView(eventBuf, 12);
    slot0.setInt32(0, 0, true);
    slot0.setFloat32(4, 0.1, true);
    Atomics.store(header, 0, 1);
    raf.flush();
    expect(errs.length).toBeGreaterThan(0); // throw surfaced via console.error
    expect(goodCalls.length).toBe(1); // subsequent handler still fired
  } finally {
    console.error = originalConsoleError;
    h.cleanup();
    raf.restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// node.events.<name>.emit(payload) sender + diagnostics (= sub-phase 7.7e)
// ─────────────────────────────────────────────────────────────────────────

const presetMessageRing = {
  name: "preset",
  wasmRingBase: 0,
  capacity: 16,
  slotSize: 4,
  fields: [{ name: "slot", wireType: "i32" as const, offsetInSlot: 0, byteSize: 4 }],
};

test("node.events.<name>.emit(payload): pushes field values into a SAB slot and increments head", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(h.context as never, makeMockProcessor({ messageRings: [presetMessageRing] })),
      h.fireReady,
    );
    const msgBuf = h.lastNode!.__constructorRecord.options.processorOptions!
      .messageRingsBuffer as SharedArrayBuffer;
    node.events["preset"].emit({ slot: 42 });
    const header = new Int32Array(msgBuf, 0, 3);
    expect(Atomics.load(header, 0)).toBe(1);
    const slotsView = new Int32Array(msgBuf, 12);
    expect(slotsView[0]).toBe(42);
  } finally {
    h.cleanup();
  }
});

test("node.events.<name>.emit(payload): sequential sends fill slots in order", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(h.context as never, makeMockProcessor({ messageRings: [presetMessageRing] })),
      h.fireReady,
    );
    const msgBuf = h.lastNode!.__constructorRecord.options.processorOptions!
      .messageRingsBuffer as SharedArrayBuffer;
    const send = node.events["preset"].emit;
    send({ slot: 1 });
    send({ slot: 2 });
    send({ slot: 3 });
    const header = new Int32Array(msgBuf, 0, 3);
    expect(Atomics.load(header, 0)).toBe(3);
    const slotsView = new Int32Array(msgBuf, 12);
    expect([slotsView[0], slotsView[1], slotsView[2]]).toEqual([1, 2, 3]);
  } finally {
    h.cleanup();
  }
});

test("node.events.<name>.emit(payload): overflow path increments overflowCount when capacity is exceeded (capacity 4, 5 sends)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const smallRing = { ...presetMessageRing, capacity: 4 };
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ messageRings: [smallRing] })),
      h.fireReady,
    );
    const msgBuf = h.lastNode!.__constructorRecord.options.processorOptions!
      .messageRingsBuffer as SharedArrayBuffer;
    const send = node.events["preset"].emit;
    send({ slot: 1 });
    send({ slot: 2 });
    send({ slot: 3 });
    send({ slot: 4 });
    send({ slot: 5 });
    const header = new Int32Array(msgBuf, 0, 3);
    expect(Atomics.load(header, 0)).toBe(5);
    expect(Atomics.load(header, 1)).toBe(1);
    expect(Atomics.load(header, 2)).toBe(1);
    expect(node.events["preset"].diagnostics.overflowCount()).toBe(1);
  } finally {
    h.cleanup();
  }
});

test("node.events.<name>.diagnostics.overflowCount reads from the SAB via Atomics.load (message ring)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(h.context as never, makeMockProcessor({ messageRings: [presetMessageRing] })),
      h.fireReady,
    );
    const msgBuf = h.lastNode!.__constructorRecord.options.processorOptions!
      .messageRingsBuffer as SharedArrayBuffer;
    const header = new Int32Array(msgBuf, 0, 3);
    const diag = node.events["preset"].diagnostics;
    expect(diag.overflowCount()).toBe(0);
    Atomics.store(header, 2, 77);
    expect(diag.overflowCount()).toBe(77);
  } finally {
    h.cleanup();
  }
});

test("node.events.<name>.emit(): void payload (no fields) increments head without writing slot data", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const voidRing = {
      name: "ping",
      wasmRingBase: 0,
      capacity: 8,
      slotSize: 0,
      fields: [],
    };
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ messageRings: [voidRing] })),
      h.fireReady,
    );
    const msgBuf = h.lastNode!.__constructorRecord.options.processorOptions!
      .messageRingsBuffer as SharedArrayBuffer;
    node.events["ping"].emit({});
    node.events["ping"].emit({});
    const header = new Int32Array(msgBuf, 0, 3);
    expect(Atomics.load(header, 0)).toBe(2);
  } finally {
    h.cleanup();
  }
});

test("node.events is an empty object for a processor with no message/event rings, and node.messages is absent", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    expect(node.events).toEqual({});
    expect((node as { messages?: unknown }).messages).toBeUndefined();
  } finally {
    h.cleanup();
  }
});

test("node.events.<name>.emit(payload): boolean fields are encoded as 0/1 i32 (Q46 lift)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const flagRing = {
      name: "toggle",
      wasmRingBase: 0,
      capacity: 8,
      slotSize: 4,
      fields: [{ name: "active", wireType: "bool" as const, offsetInSlot: 0, byteSize: 4 }],
    };
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ messageRings: [flagRing] })),
      h.fireReady,
    );
    const msgBuf = h.lastNode!.__constructorRecord.options.processorOptions!
      .messageRingsBuffer as SharedArrayBuffer;
    node.events["toggle"].emit({ active: true });
    node.events["toggle"].emit({ active: false });
    const slotsView = new Int32Array(msgBuf, 12);
    expect(slotsView[0]).toBe(1);
    expect(slotsView[1]).toBe(0);
  } finally {
    h.cleanup();
  }
});

test("node.events.<name>.emit(payload): postMessage transport sends directly via port.postMessage; overflow mirrors via worklet notification", async () => {
  // The main sender uses `port.postMessage({ kind: 'message', ringIndex, payload })`
  // rather than SAB writes. When the WASM ring exceeds capacity, the worklet
  // fires drop-oldest and notifies via `{ kind: 'message-overflow', ringIndex,
  // overflowCount }`, which mirrors the count for diagnostics. This test hooks
  // port.postMessage via spy to confirm all 5 sends go through, then simulates
  // the worklet notification and observes the mirrored diagnostics.
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  try {
    const smallRing = { ...presetMessageRing, capacity: 4 };
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ messageRings: [smallRing] })),
      h.fireReady,
    );
    const posted: unknown[] = [];
    h.lastNode!.port.postMessage = (m: unknown) => {
      posted.push(m);
    };
    const send = node.events["preset"].emit;
    send({ slot: 1 });
    send({ slot: 2 });
    send({ slot: 3 });
    send({ slot: 4 });
    send({ slot: 5 });
    // all 5 sends delivered via port.postMessage
    expect(posted).toHaveLength(5);
    expect(posted[0]).toEqual({ kind: "message", ringIndex: 0, payload: { slot: 1 } });
    expect(posted[4]).toEqual({ kind: "message", ringIndex: 0, payload: { slot: 5 } });
    // initial overflow = 0 (no worklet notification received yet)
    const diag = node.events["preset"].diagnostics;
    expect(diag.overflowCount()).toBe(0);
    // simulate the worklet's drop-oldest notification
    for (const listener of h.lastNode!.port.__listeners) {
      listener({
        data: { kind: "message-overflow", ringIndex: 0, overflowCount: 1 },
      } as MessageEvent);
    }
    expect(diag.overflowCount()).toBe(1);
  } finally {
    h.cleanup();
  }
});

test("node.events.<name>.emit(payload): postMessage transport delivers payload unchanged via port.postMessage", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  try {
    const node = await startCreate(
      () =>
        createNode(h.context as never, makeMockProcessor({ messageRings: [presetMessageRing] })),
      h.fireReady,
    );
    const posted: unknown[] = [];
    h.lastNode!.port.postMessage = (m: unknown) => {
      posted.push(m);
    };
    node.events["preset"].emit({ slot: 99 });
    expect(posted).toEqual([{ kind: "message", ringIndex: 0, payload: { slot: 99 } }]);
  } finally {
    h.cleanup();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// node.midi.<name> surface (`11-midi.md` §3) — main-thread MIDI transport.
// send (inbound) encodes through the production `midiEventToWire` codec; onEvent
// (outbound) decodes incoming slots. postMessage paths are fully synchronous via
// the mock port; SAB paths read/write the shared ring buffer directly.
// ───────────────────────────────────────────────────────────────────────────

const midiInFixture = { name: "in", direction: "in" as const, wasmRingBase: 1024, capacity: 256 };
const midiOutFixture = {
  name: "out",
  direction: "out" as const,
  wasmRingBase: 4096,
  capacity: 256,
};

test("node.midi.<in>.send: postMessage transport encodes to wire bytes and delivers via port.postMessage", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ midiRings: [midiInFixture] })),
      h.fireReady,
    );
    const posted: unknown[] = [];
    h.lastNode!.port.postMessage = (m: unknown) => posted.push(m);
    node.midi["in"]!.send({ type: "noteOn", channel: 3, note: 60, velocity: 100 });
    expect(posted).toEqual([
      { kind: "midi", ringIndex: 0, item: { status: 0x93, data1: 60, data2: 100, atSample: 0 } },
    ]);
  } finally {
    h.cleanup();
  }
});

test("node.midi.<out>.onEvent: postMessage transport decodes a midiOut slot and dispatches to matching type handler", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ midiRings: [midiOutFixture] })),
      h.fireReady,
    );
    const got: MidiEvent[] = [];
    node.midi["out"]!.onEvent("noteOn", (e) => got.push(e));
    const slot = new ArrayBuffer(8);
    const dv = new DataView(slot);
    dv.setUint8(0, 0x95); // noteOn channel 5
    dv.setUint8(1, 64);
    dv.setUint8(2, 120);
    dv.setUint32(4, 7, true);
    for (const l of h.lastNode!.port.__listeners) {
      l({
        data: { kind: "midiOut", ringIndex: 0, newSlotsBytes: slot, newSlotCount: 1 },
      } as MessageEvent);
    }
    expect(got).toEqual([{ type: "noteOn", channel: 5, note: 64, velocity: 120 }]);
  } finally {
    h.cleanup();
  }
});

test("node.midi.<out>.onEvent: handler does not fire when the event type does not match", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ midiRings: [midiOutFixture] })),
      h.fireReady,
    );
    const notes: MidiEvent[] = [];
    const ccs: MidiEvent[] = [];
    node.midi["out"]!.onEvent("noteOn", (e) => notes.push(e));
    node.midi["out"]!.onEvent("cc", (e) => ccs.push(e));
    // a cc slot — only the cc handler should fire
    const slot = new ArrayBuffer(8);
    const dv = new DataView(slot);
    dv.setUint8(0, 0xb2); // cc channel 2
    dv.setUint8(1, 74);
    dv.setUint8(2, 33);
    for (const l of h.lastNode!.port.__listeners) {
      l({
        data: { kind: "midiOut", ringIndex: 0, newSlotsBytes: slot, newSlotCount: 1 },
      } as MessageEvent);
    }
    expect(notes).toEqual([]);
    expect(ccs).toEqual([{ type: "cc", channel: 2, controller: 74, value: 33 }]);
  } finally {
    h.cleanup();
  }
});

test("node.midi.<name>.diagnostics.overflowCount: postMessage transport mirrors the count via midi-overflow notification", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ midiRings: [midiInFixture] })),
      h.fireReady,
    );
    expect(node.midi["in"]!.diagnostics.overflowCount()).toBe(0);
    for (const l of h.lastNode!.port.__listeners) {
      l({ data: { kind: "midi-overflow", ringIndex: 0, overflowCount: 3 } } as MessageEvent);
    }
    expect(node.midi["in"]!.diagnostics.overflowCount()).toBe(3);
  } finally {
    h.cleanup();
  }
});

test("node.midi.<in>.connectFromWebMIDI: injects MIDIInput.onmidimessage raw bytes via send", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ midiRings: [midiInFixture] })),
      h.fireReady,
    );
    const posted: unknown[] = [];
    h.lastNode!.port.postMessage = (m: unknown) => posted.push(m);
    const fakeInput: { onmidimessage: ((e: { data: Uint8Array }) => void) | null } = {
      onmidimessage: null,
    };
    node.midi["in"]!.connectFromWebMIDI(fakeInput);
    fakeInput.onmidimessage!({ data: new Uint8Array([0x90, 60, 100]) });
    expect(posted).toEqual([
      { kind: "midi", ringIndex: 0, item: { status: 0x90, data1: 60, data2: 100, atSample: 0 } },
    ]);
  } finally {
    h.cleanup();
  }
});

test("node.midi.<in>.send: SAB transport writes a wire slot into the shared ring and increments head", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ midiRings: [midiInFixture] })),
      h.fireReady,
    );
    const opts = h.lastNode!.__constructorRecord.options.processorOptions as {
      midiRingsBuffer: SharedArrayBuffer;
    };
    node.midi["in"]!.send({ type: "cc", channel: 0, controller: 7, value: 127 });
    const header = new Int32Array(opts.midiRingsBuffer);
    expect(header[0]).toBe(1); // head advanced 0 → 1
    const dv = new DataView(opts.midiRingsBuffer);
    expect(dv.getUint8(12)).toBe(0xb0); // cc status at slot 0 (after 12-byte header)
    expect(dv.getUint8(13)).toBe(7);
    expect(dv.getUint8(14)).toBe(127);
  } finally {
    h.cleanup();
  }
});

test("node.midi.<out>.onEvent: SAB transport drains the shared out-ring and dispatches via rAF poll", async () => {
  const raf = installRafMock();
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ midiRings: [midiOutFixture] })),
      h.fireReady,
    );
    const opts = h.lastNode!.__constructorRecord.options.processorOptions as {
      midiRingsBuffer: SharedArrayBuffer;
    };
    const got: MidiEvent[] = [];
    node.midi["out"]!.onEvent("noteOn", (e) => got.push(e));
    // worklet writes one out-ring slot (out is the only ring → SAB offset 0).
    const dv = new DataView(opts.midiRingsBuffer);
    dv.setUint8(12, 0x90);
    dv.setUint8(13, 50);
    dv.setUint8(14, 64);
    Atomics.store(new Int32Array(opts.midiRingsBuffer), 0, 1); // head = 1
    raf.flush();
    expect(got).toEqual([{ type: "noteOn", channel: 0, note: 50, velocity: 64 }]);
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("node.midi is an empty object for a processor with no MIDI rings", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    expect(node.midi).toEqual({});
  } finally {
    h.cleanup();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// node.snapshot() / node.restore() (`05-client.md` §2.6, `01-dsl.md` §8).
// Request-response over the port: snapshot() awaits the worklet's captured
// slots and wraps them in a blob; restore() migrates + decodes the blob, hands
// slots to the worklet, applies param values to AudioParams, and returns the
// worklet's authoritative applied/skipped/missing report.
// ───────────────────────────────────────────────────────────────────────────

const findPosted = (posted: unknown[], kind: string): Record<string, unknown> | undefined =>
  posted.find((m) => (m as Record<string, unknown>)?.["kind"] === kind) as
    | Record<string, unknown>
    | undefined;

test("node.snapshot(): request → worklet response slots → encodeSnapshot blob", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    const posted: unknown[] = [];
    h.lastNode!.port.postMessage = (m: unknown) => posted.push(m);
    const p = node.snapshot({ profile: "preset" });
    const req = findPosted(posted, "snapshot-request")!;
    expect(req).toBeDefined();
    expect(req["profile"]).toBe("preset");
    for (const l of h.lastNode!.port.__listeners) {
      l({
        data: {
          kind: "snapshot-response",
          requestId: req["requestId"],
          slots: [{ name: "gain", kind: "state", type: "f32", data: encodeScalar("f32", 0.5) }],
        },
      } as MessageEvent);
    }
    const blob = await p;
    const decoded = decodeSnapshot(blob);
    expect(decoded.schemaHash).toBe("test");
    expect(decoded.profile).toBe("preset");
    expect(decoded.slots).toHaveLength(1);
    expect(decoded.slots[0]!.name).toBe("gain");
  } finally {
    h.cleanup();
  }
});

test("node.restore(blob): ok path → worklet applies + param set on AudioParam + RestoreOk", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ params: [{ name: "freq" }] })),
      h.fireReady,
    );
    const posted: unknown[] = [];
    h.lastNode!.port.postMessage = (m: unknown) => posted.push(m);
    const blob = encodeSnapshot("test", null, [
      { name: "gain", kind: "state", type: "f32", data: encodeScalar("f32", 0.5) },
      { name: "freq", kind: "param", type: "f32", data: encodeScalar("f32", 440) },
    ]);
    const p = node.restore(blob);
    const req = findPosted(posted, "restore")!;
    expect((req["slots"] as unknown[]).length).toBe(2);
    for (const l of h.lastNode!.port.__listeners) {
      l({
        data: {
          kind: "restore-done",
          requestId: req["requestId"],
          applied: ["gain", "freq"],
          skipped: [],
          missing: [],
        },
      } as MessageEvent);
    }
    const result = await p;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applied).toEqual(["gain", "freq"]);
      expect(result.restored).toBe(2);
    }
    // the param slot was applied to the live AudioParam
    expect(node.params["freq"]!.value).toBeCloseTo(440);
  } finally {
    h.cleanup();
  }
});

test("node.restore(blob): worklet skipped / missing report is forwarded verbatim", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    const posted: unknown[] = [];
    h.lastNode!.port.postMessage = (m: unknown) => posted.push(m);
    const blob = encodeSnapshot("test", null, [
      { name: "ghost", kind: "state", type: "f32", data: encodeScalar("f32", 1) },
    ]);
    const p = node.restore(blob);
    const req = findPosted(posted, "restore")!;
    for (const l of h.lastNode!.port.__listeners) {
      l({
        data: {
          kind: "restore-done",
          requestId: req["requestId"],
          applied: [],
          skipped: ["ghost"],
          missing: ["gain"],
        },
      } as MessageEvent);
    }
    const result = await p;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applied).toEqual([]);
      expect(result.skipped).toEqual(["ghost"]);
      expect(result.missing).toEqual(["gain"]);
      expect(result.restored).toBe(0);
    }
  } finally {
    h.cleanup();
  }
});

// ── hang safety: pending snapshot / restore must always settle ────────────────
// The worklet response is the only resolve signal. If the node is torn down or
// the audio thread dies, an un-settled promise hangs the caller forever. These
// guard the dispose / processorerror / post-dispose settle paths.

test("node.snapshot() after dispose() rejects instead of hanging", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    node.dispose();
    await expect(node.snapshot()).rejects.toThrow(/dispos/i);
  } finally {
    h.cleanup();
  }
});

test("node.restore() after dispose() resolves ok:false instead of hanging", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    node.dispose();
    const blob = encodeSnapshot("test", null, [
      { name: "gain", kind: "state", type: "f32", data: encodeScalar("f32", 0.5) },
    ]);
    const result = await node.restore(blob);
    expect(result.ok).toBe(false);
  } finally {
    h.cleanup();
  }
});

test("dispose() while a snapshot() is pending rejects the pending promise (no hang)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    // The default mock port swallows the request (never responds).
    const p = node.snapshot();
    node.dispose();
    await expect(p).rejects.toThrow(/dispos/i);
  } finally {
    h.cleanup();
  }
});

test("processorerror while a restore() is pending settles it as ok:false (no hang)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    const blob = encodeSnapshot("test", null, [
      { name: "gain", kind: "state", type: "f32", data: encodeScalar("f32", 0.5) },
    ]);
    const p = node.restore(blob);
    h.fireProcessorError("boom"); // audio thread died → it will never respond
    const result = await p;
    expect(result.ok).toBe(false);
  } finally {
    h.cleanup();
  }
});

test("node.restore() forwards the blob's profile to the worklet (= profile-scoped missing)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    const posted: unknown[] = [];
    h.lastNode!.port.postMessage = (m: unknown) => posted.push(m);
    const blob = encodeSnapshot("test", "preset", [
      { name: "a", kind: "state", type: "f32", data: encodeScalar("f32", 1) },
    ]);
    const p = node.restore(blob);
    const req = findPosted(posted, "restore")!;
    // The worklet needs the profile to scope its `missing` report correctly.
    expect(req["profile"]).toBe("preset");
    for (const l of h.lastNode!.port.__listeners) {
      l({
        data: {
          kind: "restore-done",
          requestId: req["requestId"],
          applied: ["a"],
          skipped: [],
          missing: [],
        },
      } as MessageEvent);
    }
    await p;
  } finally {
    h.cleanup();
  }
});

test("node.restore(blob): a throwing migration step fails the restore (RestoreFailure)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            migrations: [
              {
                from: "old",
                to: "test",
                migrate: () => {
                  throw new Error("migration boom");
                },
              },
            ],
          }),
        ),
      h.fireReady,
    );
    // Blob minted under the OLD hash → migration path old → test runs → throws.
    const blob = encodeSnapshot("old", null, [
      { name: "gain", kind: "state", type: "f32", data: encodeScalar("f32", 1) },
    ]);
    const result = await node.restore(blob);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("migration boom");
      expect(result.restored).toBe(0);
    }
  } finally {
    h.cleanup();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// replaceProcessor (`05-client.md` §8) — snapshot old → createNode new →
// restore → ReplaceResult. Orchestration of already-tested pieces; the test
// auto-responds to the snapshot / restore port round-trips + fires the new
// node's ready handshake so the full async chain resolves.
// ───────────────────────────────────────────────────────────────────────────

const macrotask = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// Patch a mock node so its port auto-answers snapshot-request → snapshot-response
// and restore → restore-done (with the given report), letting snapshot()/restore()
// resolve without manual message firing.
const autoAnswer = (
  mockNode: MockAudioWorkletNode,
  report: { applied: string[]; skipped: string[]; missing: string[] },
): void => {
  mockNode.port.postMessage = (m: unknown) => {
    const msg = m as { kind?: string; requestId?: number };
    if (msg?.kind === "snapshot-request") {
      for (const l of mockNode.port.__listeners) {
        l({
          data: { kind: "snapshot-response", requestId: msg.requestId, slots: [] },
        } as MessageEvent);
      }
    } else if (msg?.kind === "restore") {
      for (const l of mockNode.port.__listeners) {
        l({ data: { kind: "restore-done", requestId: msg.requestId, ...report } } as MessageEvent);
      }
    }
  };
};

test("replaceProcessor: snapshots old, stands up new node, restores, returns ReplaceResult", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const oldNode = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    const oldMock = h.lastNode!;
    autoAnswer(oldMock, { applied: [], skipped: [], missing: [] });

    const newProc = makeMockProcessor({
      processorName: "new-proc",
      moduleUrl: "/new.worklet.js",
      wasmUrl: "/new.wasm",
      params: [{ name: "gain" }],
    });
    const p = replaceProcessor(oldNode, newProc as never);

    // Wait for createNode(newProc) to construct the new node, then wire it up.
    for (let i = 0; i < 20 && h.lastNode === oldMock; i++) await macrotask();
    const newMock = h.lastNode!;
    expect(newMock).not.toBe(oldMock);
    autoAnswer(newMock, { applied: ["gain"], skipped: [], missing: [] });
    for (const l of newMock.port.__listeners) l({ data: { kind: "ready" } } as MessageEvent);

    const result = await p;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applied).toEqual(["gain"]);
      expect(result.restored).toBe(1);
    }
    // The returned node is the freshly-created wrapper, not the old one.
    expect(result.node).toBeDefined();
    expect(result.node.node).toBe(newMock as unknown);
  } finally {
    h.cleanup();
  }
});

test("replaceProcessor: a failed migration still returns a running node (ok:false + node)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    // The new processor has a migration that throws; the old node's snapshot blob
    // is minted under "test", so the migrate path runs + fails inside restore.
    const oldNode = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    const oldMock = h.lastNode!;
    // snapshot returns a blob under hash "test"; the new proc's current hash is
    // "v2" with a throwing migration test → v2, so restore fails before the port.
    oldMock.port.postMessage = (m: unknown) => {
      const msg = m as { kind?: string; requestId?: number };
      if (msg?.kind === "snapshot-request") {
        for (const l of oldMock.port.__listeners) {
          l({
            data: { kind: "snapshot-response", requestId: msg.requestId, slots: [] },
          } as MessageEvent);
        }
      }
    };
    const newProc = {
      ...makeMockProcessor({ processorName: "v2-proc", moduleUrl: "/v2.js", wasmUrl: "/v2.wasm" }),
      schemaHash: "v2",
      migrations: [
        {
          from: "test",
          to: "v2",
          migrate: () => {
            throw new Error("swap migration boom");
          },
        },
      ],
    };
    const p = replaceProcessor(oldNode, newProc as never);
    for (let i = 0; i < 20 && h.lastNode === oldMock; i++) await macrotask();
    const newMock = h.lastNode!;
    for (const l of newMock.port.__listeners) l({ data: { kind: "ready" } } as MessageEvent);

    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("swap migration boom");
    }
    // Even on failure the new node is returned (runs on declaration defaults).
    expect(result.node).toBeDefined();
  } finally {
    h.cleanup();
  }
});

test("replaceProcessor: warns once it exceeds 50 swaps on one AudioContext (Q63)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    let current = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    autoAnswer(h.lastNode!, { applied: [], skipped: [], missing: [] });

    const swap = async (): Promise<void> => {
      const prevMock = h.lastNode!;
      const newProc = makeMockProcessor({
        processorName: "swap-proc",
        moduleUrl: "/swap.worklet.js",
        wasmUrl: "/swap.wasm",
      });
      const p = replaceProcessor(current, newProc as never);
      for (let i = 0; i < 20 && h.lastNode === prevMock; i++) await macrotask();
      const mock = h.lastNode!;
      autoAnswer(mock, { applied: [], skipped: [], missing: [] });
      for (const l of mock.port.__listeners) l({ data: { kind: "ready" } } as MessageEvent);
      const result = await p;
      current = result.node as never;
    };

    // 50 swaps: still under the threshold, no warning.
    for (let i = 0; i < 50; i++) await swap();
    expect(warnSpy).not.toHaveBeenCalled();
    // 51st swap crosses the threshold (count > 50) and warns.
    await swap();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toContain("more than 50 times");
    // The warning is one-shot per AudioContext — further swaps must NOT re-warn.
    await swap();
    await swap();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  } finally {
    warnSpy.mockRestore();
    h.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// DevTools dev-node registry + dev-dump round-trip (gated on __UNWORKLET_DEVTOOLS__)
// ─────────────────────────────────────────────────────────────────────────

test("devtools off (default): createNode does not register the node", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    expect(getDevNodes().some((x) => x.node === node)).toBe(false);
  } finally {
    h.cleanup();
  }
});

test("devtools on: createNode auto-registers, devDump round-trips, dispose unregisters", async () => {
  (globalThis as { __UNWORKLET_DEVTOOLS__?: boolean }).__UNWORKLET_DEVTOOLS__ = true;
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    const handle = getDevNodes().find((x) => x.node === node);
    expect(handle).toBeDefined();
    expect(handle!.processorName).toBe("stereoGain");
    // No `worklet.displayName` supplied → handle falls back to processorName.
    expect(handle!.displayName).toBe("stereoGain");

    // devDump posts a dev-dump-request; capture it + reply with a response.
    const posted: unknown[] = [];
    h.lastNode!.port.postMessage = (m: unknown) => {
      posted.push(m);
    };
    const dumpPromise = handle!.devDump();
    const req = posted.find(
      (m): m is { kind: string; requestId: number } =>
        typeof m === "object" &&
        m !== null &&
        (m as { kind?: unknown }).kind === "dev-dump-request",
    );
    expect(req).toBeDefined();
    for (const listener of h.lastNode!.port.__listeners) {
      listener({
        data: {
          kind: "dev-dump-response",
          requestId: req!.requestId,
          slots: [
            { name: "meterL", kind: "state", type: "f32", data: new Uint8Array([0, 0, 128, 63]) },
          ],
        },
      } as MessageEvent);
    }
    const slots = await dumpPromise;
    expect(slots).toHaveLength(1);
    expect(slots[0]!.name).toBe("meterL");

    node.dispose();
    expect(getDevNodes().some((x) => x.node === node)).toBe(false);
  } finally {
    delete (globalThis as { __UNWORKLET_DEVTOOLS__?: boolean }).__UNWORKLET_DEVTOOLS__;
    h.cleanup();
  }
});

test("devtools on: handle carries the clean displayName, not the hashed processorName", async () => {
  (globalThis as { __UNWORKLET_DEVTOOLS__?: boolean }).__UNWORKLET_DEVTOOLS__ = true;
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    // The plugin mints `processorName` with HMR hash suffixes and carries the
    // clean export name separately as `worklet.displayName`.
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            processorName: "tapeDelay__24133496__81634d92",
            displayName: "tapeDelay",
          }),
        ),
      h.fireReady,
    );
    const handle = getDevNodes().find((x) => x.node === node);
    expect(handle).toBeDefined();
    expect(handle!.processorName).toBe("tapeDelay__24133496__81634d92");
    expect(handle!.displayName).toBe("tapeDelay");
    node.dispose();
  } finally {
    delete (globalThis as { __UNWORKLET_DEVTOOLS__?: boolean }).__UNWORKLET_DEVTOOLS__;
    h.cleanup();
  }
});

test("devtools on: devDump on a disposed node rejects instead of hanging", async () => {
  (globalThis as { __UNWORKLET_DEVTOOLS__?: boolean }).__UNWORKLET_DEVTOOLS__ = true;
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    const handle = getDevNodes().find((x) => x.node === node)!;
    node.dispose();
    await expect(handle.devDump()).rejects.toThrow(/disposed/);
  } finally {
    delete (globalThis as { __UNWORKLET_DEVTOOLS__?: boolean }).__UNWORKLET_DEVTOOLS__;
    h.cleanup();
  }
});

test("rAF loop does not re-arm after dispose() is called from inside a subscriber handler", async () => {
  const raf = installRafMock();
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(
          h.context as never,
          makeMockProcessor({
            publishSlots: [{ name: "v", type: "i32", sharedOffset: 0, counterOffset: 4 }],
          }),
        ),
      h.fireReady,
    );
    const buf = h.lastNode!.__constructorRecord.options.processorOptions!
      .publishBuffer as SharedArrayBuffer;
    const view = new Int32Array(buf);
    // Self-dispose from inside the handler (a normal one-shot pattern).
    node.state["v"]!.subscribe(() => node.dispose());
    // Publish version 1 → handler fires → disposes the node mid-tick.
    Atomics.store(view, 0, 42);
    Atomics.store(view, 2, 1);
    raf.flush();
    // dispose()'s stopRafLoop ran during the tick; the loop must NOT re-arm itself
    // (a trailing re-arm would poll every frame for the page lifetime, pinning the SAB).
    expect(raf.pending).toBe(0);
  } finally {
    h.cleanup();
    raf.restore();
  }
});
