/**
 * Behavioral tests for `createNode(ctx, processor, options?)` — Phase 6 A-3
 * implementation of `05-client.md` §1 + §2 (= minimum surface for AudioWorklet
 * 経 由 で processor を 起 動 す る main thread entrypoint)。
 *
 * Mock 戦 略:
 * - `audioContext.audioWorklet.addModule` を Promise を 返 す Mock 関 数 に
 * - `globalThis.fetch` を WASM bytes Promise に 返 す Mock 関 数 に
 * - `globalThis.AudioWorkletNode` を Mock class に (= constructor が options
 *   を 受 け 取 り、 `port` field と `parameters` field を 露 出)
 * - test 側 で 「ready ack を post す る」 タ イ ミ ン グ を コ ン ト ロ ー ル
 *   す る た め mock port は `postMessage` 経 由 で 自 分 自 身 へ message を
 *   配 送 す る path を 持 つ
 */

import { expect, test, vi } from "vite-plus/test";

import { createNode, inspect } from "./client.ts";
import type { CompiledProcessor } from "./types.ts";

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
   * the cleanup-on-throw branch inside `awaitReady`。
   */
  portStartThrows?: boolean;
  /**
   * crossOriginIsolated を mock global に 設 定 す る か。 default true (= 既 test
   * の 多 数 が SAB available 想 定 で 書 か れ て いる)、 sab-unavailable path を 試
   * す test で `false` or `undefined` を 渡 す path。 `false` = explicit deny、
   * `undefined` = delete property (= 既 environment と 同 形)。
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
  // 既 test の 多 数 が 「SAB available」 path 想 定 で 書 か れ て いる (= sub-phase
  // 7.4 で sab-unavailable が 1 度 fire さ れ る 経 路 が 増 え た た め、 default
  // で SAB available 環 境 を mock = 既 test の onError 経 路 で 余 計 な
  // sab-unavailable 通 知 を 生 ま な い)。 sab-unavailable path を 試 す test は
  // option で `crossOriginIsolated: 'deleted'` を 渡 し て delete 環 境 を mock。
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
  // Web Audio engine。
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

  // Stub `WebAssembly.compile` so tests run without real WASM bytes。
  // The returned object only needs an identity the production path can
  // forward through `processorOptions.module`; createNode tests assert
  // it round-trips, no Module method is invoked。
  const originalWasmCompile = WebAssembly.compile;
  const compiledModuleSentinels: unknown[] = [];
  WebAssembly.compile = ((_bytes: BufferSource) => {
    const sentinel = { __mockModuleId: compiledModuleSentinels.length };
    compiledModuleSentinels.push(sentinel);
    return Promise.resolve(sentinel as unknown as WebAssembly.Module);
  }) as typeof WebAssembly.compile;

  class MockWorkletNodeImpl {
    port: MockAudioWorkletNode["port"];
    parameters: MockAudioWorkletNode["parameters"];
    __constructorRecord: ConstructorRecord;
    __processorErrorListeners: NodeListener[];
    constructor(ctx: unknown, name: string, opts: AudioWorkletNodeOptions) {
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
}): CompiledProcessor<unknown> =>
  ({
    graph: {} as never,
    schemaHash: "test",
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
      moduleUrl:
        overrides && "moduleUrl" in overrides ? overrides.moduleUrl : "/_assets/x.worklet.js",
      wasmUrl: overrides && "wasmUrl" in overrides ? overrides.wasmUrl : "/_assets/x.wasm",
      processorName:
        overrides && "processorName" in overrides ? overrides.processorName : "stereoGain",
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
    // so the audio thread can `new WebAssembly.Instance(module)` directly。
    expect(sent).toBeDefined();
    expect((sent as unknown as { __mockModuleId?: number }).__mockModuleId).toBe(0);
    // Old bytes-bag path must NOT be sent on the declarative path α (= avoids
    // sync `new WebAssembly.Module(bytes)` on the audio thread)。
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
  // parallel loads would crash on real engines。
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  // Replace the synchronous mock addModule with an async one that resolves
  // only when the test releases it, so both `createNode` invocations are
  // genuinely in-flight when the cache lookup happens。
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
    // cache decision is made before addModule settles。
    await new Promise((r) => setTimeout(r, 0));
    expect(h.addModuleCalls).toEqual(["/_assets/x.worklet.js"]);
    releaseAddModule();
    // Allow `addModule` to resolve and both flows to construct their nodes
    // before we fire the ready ack for both。
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

    // AudioNode-shape destination (= has `.connect` method)。
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

    // AudioParam shape = no `.connect` method。
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
    // input port at `portIdx`。 The plugin uses a passthrough GainNode
    // proxy per port (= GainNode is an AudioNode and stays out of the
    // user's way)。
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
    // the input proxies (= user owns the upstream graph)。
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
    // dispatcher。
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
    // MDN: `processorerror` is a plain `Event` with no portable payload。
    // Real structured trap info comes through the port message。 Verify
    // the fallback marker does NOT read non-existent `.message`。
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
    // subscriber。
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
  // constructed AudioWorkletNode themselves。 createNode() must clean up
  // the half-built node before rejecting, otherwise silent processors
  // accumulate inside the AudioContext。
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    let disconnectCalls = 0;
    let closeCalls = 0;
    const promise = createNode(h.context as never, makeMockProcessor(), undefined);
    await new Promise((r) => setTimeout(r, 0));
    // Hook the constructed node's cleanup paths before firing init-error。
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
    // firing before the .rejects handler observes it。
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
  // InvalidStateError。 Cover the cleanup-on-throw branch so the Promise
  // rejects cleanly + listeners / timer are not left pinned。
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
      // first subscriber throwing。 The throw is surfaced via console.error。
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
    // a no-op (= we never added the handler in the first place)。
    expect(() => unsub()).not.toThrow();
    // Dispatching after dispose cannot reach the late subscriber because
    // the listener has been removed from the underlying port + the
    // subscriber Set is cleared。 Verify the late subscriber stays empty。
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
  // (context, moduleUrl)。 First call rejects → cache entry removed →
  // second call enters addModule fresh。
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
    // Second attempt enters addModule again (= cache evicted)。
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
  // fires for application/wasm + the bytes path is skipped。
  const originalCompileStreaming = WebAssembly.compileStreaming;
  let streamingCalls = 0;
  const fakeModule = { __via: "streaming" };
  WebAssembly.compileStreaming = ((_response: Response | Promise<Response>) => {
    streamingCalls++;
    return Promise.resolve(fakeModule as unknown as WebAssembly.Module);
  }) as typeof WebAssembly.compileStreaming;
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    // Override the mock fetch to advertise application/wasm。
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
    // === "string"` false branch in awaitReady's onMessage handler。
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
      // Non-string code → early return。
      listener({ data: { kind: "error", code: 42 } });
      // Unknown code (= future / typo) → early return = guard against the
      // structured-union contract widening silently。
      listener({ data: { kind: "error", code: "some-future-code" } });
    }
    expect(received).toEqual([]);
  } finally {
    h.cleanup();
  }
});

test("UnworkletNode.dispose() is idempotent (= second call is a no-op)", async () => {
  // Cover the `if (disposed) return` guard。
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
    // Second dispose() must short-circuit before re-running cleanup。
    expect(disconnectCalls).toBe(1);
  } finally {
    h.cleanup();
  }
});

test("awaitReady: stray events after settle are early-returned (= no double settle)", async () => {
  // Cover the `if (settled) return` guards in onMessage / onProcessorError /
  // timer。 Drive a ready ack first (= settles)、 then fire init-error /
  // processorerror / advance the timer past timeout = no rejection should
  // occur because the promise already resolved。
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
    // reachable through any closure。 In practice cleanup removes them, so
    // these calls just verify no throws & no spurious rejection。
    expect(() => h.fireInitError("late")).not.toThrow();
    expect(() => h.fireProcessorError("late")).not.toThrow();
    await vi.advanceTimersByTimeAsync(15_000);
  } finally {
    vi.useRealTimers();
    h.cleanup();
  }
});

test("`inspect(blob)` stub throws", () => {
  expect(() => inspect(new Uint8Array(0))).toThrow(/not implemented/);
});

test("fetchAndCompileWasm falls back to '' when the response exposes no headers / get accessor", async () => {
  // Cover the `?? ""` fallback in `response.headers?.get?.("Content-Type") ?? ""`。
  // Some fetch polyfills / non-standard responses can omit `headers` entirely
  // or omit the `get` method on the headers bag — optional chaining must
  // resolve to "" so the regex test runs against an empty string rather than
  // throwing。
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    globalThis.fetch = ((url: string) => {
      h.fetchCalls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        // No `headers` property at all = optional chain resolves to undefined。
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
  // engines may return undefined if parameterData is partially populated)。
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    // Override the parameters.get to return undefined for `cutoff`、 a valid
    // AudioParam shape for `gain`。
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
    // should appear on the node。
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
  // `{ kind: "ready" }` ack arrives。
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const promise = createNode(h.context as never, makeMockProcessor(), undefined);
    await new Promise((r) => setTimeout(r, 0));
    for (const listener of h.lastNode!.port.__listeners) {
      // Each of these must be ignored by awaitReady (= no resolve, no reject)。
      listener({ data: null });
      listener({ data: 42 });
      listener({ data: "string event" });
    }
    // Now send the real ready — promise should still resolve cleanly。
    h.fireReady();
    const node = await promise;
    expect(node).toBeDefined();
  } finally {
    h.cleanup();
  }
});

test("awaitReady ignores object data whose kind is neither 'ready' nor 'init-error'", async () => {
  // Cover the `if (data.kind === 'init-error')` else branch inside awaitReady。
  // An out-of-band message during handshake (= the long-lived runtime path
  // may post `{ kind: "error", ... }` before ready in some test orderings)
  // must be ignored by the handshake handler so the real `ready` still settles。
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const promise = createNode(h.context as never, makeMockProcessor(), undefined);
    await new Promise((r) => setTimeout(r, 0));
    for (const listener of h.lastNode!.port.__listeners) {
      // Object with a kind that is neither "ready" nor "init-error" = no-op。
      listener({ data: { kind: "error", code: "wasm-trap", message: "stray" } });
      listener({ data: { kind: "future-handshake-frame" } });
      // Object without a `kind` field at all。
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
  // surfaces in conformant engines。
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const promise = createNode(h.context as never, makeMockProcessor(), undefined);
    await new Promise((r) => setTimeout(r, 0));
    // Fire with NO message field = `errEvent.message` is undefined =
    // falsy → fallback string is used。
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
  // plain object (= non-Error) in obscure polyfilled engines。 The Promise
  // must still reject with an Error so downstream `.catch()` consumers see
  // a uniform shape。
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    // Re-install the mock node so port.start throws a non-Error string。
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
// transport mode 検 出 + SAB / fallback buffer allocate (= sub-phase 7.4)
// ─────────────────────────────────────────────────────────────────────────

test("createNode without publishSlots = buffer ナ シ + processorOptions に publishBuffer 含 ま な い", async () => {
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

test("createNode with messageRings + crossOriginIsolated = SAB allocate + messageRings hand", async () => {
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
    // ring 1 個 = header 12 + 16 × 4 = 76
    expect((opts.messageRingsBuffer as SharedArrayBuffer).byteLength).toBe(76);
    expect(opts.messageRingSabOffsets).toEqual([0]);
    expect(opts.transport).toBe("sab");
  } finally {
    h.cleanup();
  }
});

test("createNode without messageRings = processorOptions に messageRingsBuffer hand な し", async () => {
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

test("createNode with messageRings + !crossOriginIsolated = messageRingsBuffer な し + descriptor hand", async () => {
  // postMessage path = messageRingsBuffer を hand し な い (= main 側 が
  // `port.postMessage({ kind: 'message', ... })` で 直 送、 worklet 側 が
  // self.port.onmessage で receive + WASM ring に inject = buffer 自 体 不 要)。
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

test("createNode with eventRings + crossOriginIsolated = SAB allocate + eventRings hand", async () => {
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
    // ring 1 個 = header 12 + 16 × 8 = 140
    expect((opts.eventRingsBuffer as SharedArrayBuffer).byteLength).toBe(140);
    expect(opts.eventRingSabOffsets).toEqual([0]);
    expect(opts.transport).toBe("sab");
  } finally {
    h.cleanup();
  }
});

test("createNode with 2 eventRings = SAB に 連 続 配 置 + sabOffsets で 累 計", async () => {
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
    // evt1 = 140 byte、 evt2 = 12 + 4 × 4 = 28 byte、 合 計 168
    expect(opts.eventRingsBuffer.byteLength).toBe(168);
    expect(opts.eventRingSabOffsets).toEqual([0, 140]);
  } finally {
    h.cleanup();
  }
});

test("createNode without eventRings = processorOptions に eventRingsBuffer hand な し", async () => {
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

test("createNode with eventRings + !crossOriginIsolated = eventRingsBuffer な し + descriptor hand", async () => {
  // postMessage path = eventRingsBuffer を hand し な い (= structured clone で
  // main / worklet が 別 ring instance に な る = mirror 不 能、 worklet 側 が
  // port.postMessage で 新 emit 分 を 個 別 配 送 す る path)。 eventRings
  // descriptor + transport だ け hand。
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

test("createNode with publishSlots + !crossOriginIsolated = publishBuffer な し + transport 'postMessage' + descriptor hand", async () => {
  // postMessage path = publishBuffer を hand し な い (= structured clone で 別
  // ArrayBuffer instance に な る = mirror 不 能、 worklet 側 が port.postMessage
  // 経 路 で 通 知 す る = main 側 buffer 自 体 不 要)。 publishSlots descriptor +
  // transport だ け hand し て worklet template が postMessage 経 路 を 走 ら す。
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

test("onError 1 番 目 subscriber は sab-unavailable env で `{ code: 'sab-unavailable' }` を 1 度 受 信", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ publishSlots: [] })),
      h.fireReady,
    );
    const events: unknown[] = [];
    node.onError((e) => events.push(e));
    expect(events).toEqual([{ code: "sab-unavailable" }]);
    // 2 番 目 subscriber は pending 既 clear で 受 信 し な い
    const events2: unknown[] = [];
    node.onError((e) => events2.push(e));
    expect(events2).toEqual([]);
  } finally {
    h.cleanup();
  }
});

test("onError は SAB available env で sab-unavailable を fire し ない (= regression)", async () => {
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

test("node.state.<name>.value = SAB mode で publish 済 値 を 同 期 read (= f32 / i32 / bool 各 型)", async () => {
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
    // SAB に 値 を 直 接 write (= worklet が copy す る 経 路 を mock)
    const buf = h.lastNode!.__constructorRecord.options.processorOptions!
      .publishBuffer as SharedArrayBuffer;
    const view = new Int32Array(buf);
    // f32 0.5 を bit pattern で write
    const f32Buf = new Float32Array([0.5]);
    const f32Bits = new Int32Array(f32Buf.buffer)[0]!;
    Atomics.store(view, 0, f32Bits);
    Atomics.store(view, 3, 42); // i32
    Atomics.store(view, 6, 1); // bool true
    expect(node.state["vF32"]!.value).toBe(0.5);
    expect(node.state["vI32"]!.value).toBe(42);
    expect(node.state["vBool"]!.value).toBe(true);
    // bool 0 case
    Atomics.store(view, 6, 0);
    expect(node.state["vBool"]!.value).toBe(false);
  } finally {
    h.cleanup();
  }
});

test("node.state.<name>.value = postMessage mode で onPublishMessage 経 由 で mirror 更 新 + read 可", async () => {
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
    // 初 期 値 = mirror 0 で .value も 0
    expect(node.state["vI32"]!.value).toBe(0);
    // worklet が version advance 時 に 投 げ る publish message を simulate
    // (= port listener 経 由 で onPublishMessage が mirror 更 新)
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

test("node.state.<name>.subscribe(handler) は subscriber を 保 持 + unsubscribe 返 却", async () => {
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
    // unsub 後 の handler は polling driver fill 後 で fire ナ シ = 当 commit で は subscriber set 削 除 だ け 確 認
    expect(calls).toEqual([]);
  } finally {
    h.cleanup();
  }
});

test("publish ナ シ processor は node.state = 空 object (= regression)", async () => {
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
 * rAF mock = requestAnimationFrame を 手 動 step 経 由 で 走 ら せ る path。
 * raf(tick) で tick を 集 め、 `flushRaf` で 1 度 だ け 同 期 invoke (= test
 * 経 路 で polling driver の 動 作 を 観 測 可)。 cancelAnimationFrame で handle
 * を 削 除 = dispose 時 の 停 止 check が 可 能。
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
      // 現 在 pending な callback を 全 invoke (= snapshot 経 由 で flush 中 の
      // re-schedule を 次 flush に 回 す)。
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

test("polling driver = subscribe 後 raf tick で version 増 加 検 出 → handler fire", async () => {
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

    // 1 度 目 flush: version 0 = 変 化 ナ シ = fire ナ シ
    raf.flush();
    expect(calls).toEqual([]);

    // worklet が publish した path を mock = value 42、 version 1 を SAB に 直 接 write
    Atomics.store(view, 0, 42);
    Atomics.store(view, 2, 1);
    raf.flush();
    expect(calls).toEqual([42]);

    // 2 度 目 publish: value 99、 version 2
    Atomics.store(view, 0, 99);
    Atomics.store(view, 2, 2);
    raf.flush();
    expect(calls).toEqual([42, 99]);
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("polling driver = 全 subscriber unsubscribe で rAF loop 停 止 (= zero-subscriber で polling 浪 費 し ない)", async () => {
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
    // SAB mode = subscribe で rAF polling 開 始 (= 1 tick scheduled)
    expect(raf.pending).toBe(1);

    unsub();
    // 全 surface の subscriber が 0 に な っ た = rAF loop 停 止 (= node 生 存 中 に
    // temporary subscribe → unsubscribe し た 後、 dispose ま で 毎 frame polling
    // し 続 け る main-thread 浪 費 を 回 避)。
    expect(raf.pending).toBe(0);
    expect(raf.cancelledHandles.length).toBeGreaterThan(0);
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("polling driver = 同 値 publish でも version 増 加 で fire (= no-dedupe、 Q39-b)", async () => {
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
    Atomics.store(view, 0, 50); // 同 値
    Atomics.store(view, 2, 2); // version は 増 加
    raf.flush();
    expect(calls).toEqual([50, 50]);
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("polling driver = multiple subscribers で 同 値 fire + 1 番 目 throw で 2 番 目 fire 継 続", async () => {
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

test("polling driver = unsubscribe で 該 当 handler skip + dispose で raf 停 止", async () => {
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
    expect(calls).toEqual([1]); // 増 加 ナ シ
    // dispose で raf 停 止 = pending 0 + 直 前 handle が cancel
    node.dispose();
    expect(raf.cancelledHandles.length).toBeGreaterThan(0);
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("publish dispatch = postMessage mode で port.onmessage 経 由 で subscriber 即 時 fire (= no rAF polling)", async () => {
  // postMessage path で は rAF polling 不 要 = port.onmessage が dispatched す る と
  // 即 時 subscriber fire。 rAF mock を 入 れ て も flush 前 に fire し て いる こ と
  // を 担 保 (= polling driver 起 動 さ れ て い な い)。
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
    // worklet publish を simulate (= rAF flush せ ず に subscriber fire を 担 保)
    for (const listener of h.lastNode!.port.__listeners) {
      listener({
        data: { kind: "publish", slotIndex: 0, valueBits: 88, sampleCounter: 0, version: 1 },
      } as MessageEvent);
    }
    expect(calls).toEqual([88]);
    // rAF flush し て も 追 加 fire ナ シ (= polling driver は postMessage path で 起
    // 動 し て い な い、 既 fire は port driven な の で raf tick で 増 え な い)
    raf.flush();
    expect(calls).toEqual([88]);
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("polling driver = cancelAnimationFrame 不 在 環 境 で dispose は ハ ン ド ル null 化 だ け で skip", async () => {
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
    // dispose で cancelAnimationFrame 不 在 = guard で skip + rafHandle null 化
    expect(() => node.dispose()).not.toThrow();
  } finally {
    h.cleanup();
    if (prevRaf !== undefined) target.requestAnimationFrame = prevRaf;
    else delete target.requestAnimationFrame;
    if (prevCancel !== undefined) target.cancelAnimationFrame = prevCancel;
  }
});

test("polling driver = requestAnimationFrame 不 在 環 境 で subscribe は subscriber set add だ け (= raf skip)", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  // rAF を 削 除 (= polyfill ナ シ environment mock)
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

test("onError 1 番 目 subscriber が throw し て も pending sab-unavailable は clear (= 2 番 目 fire ナ シ)", async () => {
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
// node.events.<name>.on / diagnostics (= sub-phase 7.6 commit 6)
//
// worklet → main moment-in-time delivery 経 路 の main 側 surface。 既 state
// subscribe path (= rAF polling) と zip path で SAB から drain、 各 slot を
// per-field reinterpret し て plain JS 値 で handler に hand。
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

test("node.events.<name>.on: subscribe + emit simulation で rAF tick で handler fire", async () => {
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

    // head = 0 = drain ナ シ
    raf.flush();
    expect(calls).toEqual([]);

    // worklet emit を simulate: head = 1, slot 0 = atSample 5 / level 0.75
    const header = new Int32Array(eventBuf, 0, 3);
    const slot0 = new DataView(eventBuf, 12);
    slot0.setInt32(0, 5, true);
    slot0.setFloat32(4, 0.75, true);
    Atomics.store(header, 0, 1);
    raf.flush();
    expect(calls).toEqual([{ atSample: 5, level: 0.75 }]);

    // 2 emit 目: head = 2, slot 1 = atSample 7 / level 0.5
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

test("node.events.<name>.on: 多 重 subscribe = registration order で fire", async () => {
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

test("node.events.<name>.on: unsubscribe 後 fire ナ シ", async () => {
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
    expect(calls.length).toBe(1); // unsubscribe 後 = fire ナ シ
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("node.events.<name>.diagnostics.overflowCount: SAB から Atomics.load", async () => {
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
    Atomics.store(header, 2, 42); // overflowCount = 42
    expect(node.events["peak"]!.diagnostics.overflowCount()).toBe(42);
  } finally {
    h.cleanup();
  }
});

test("node.events.<name>.on: dispose で 全 subscriber clear + 後 続 fire ナ シ", async () => {
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

test("node.events: event ナ シ processor で 空 object", async () => {
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

test("node.events.<name>.on: f64 / i64 / bool field を plain JS 値 で 受 領", async () => {
  const raf = installRafMock();
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const wideRing = {
      name: "wide",
      wasmRingBase: 0,
      capacity: 4,
      slotSize: 24, // atSample(4) + f64(8) + i64(8) + bool(4) = 24
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

test("node.events.<name>.on: postMessage transport で port.onmessage 経 由 で subscriber + diagnostics 即 時 更 新", async () => {
  // postMessage path = worklet 側 が `port.postMessage({ kind: 'event', ringIndex,
  // newSlotsBytes, newSlotCount, overflowCount })` を 投 げ る = main 側 onEventMessage
  // 経 由 で payload 解 読 + subscriber 即 時 fire + overflowCount mirror 更 新。
  // rAF flush 不 要。
  const raf = installRafMock();
  const h = installMockGlobals(new Uint8Array([0, 1, 2]), { crossOriginIsolated: "deleted" });
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ eventRings: [peakEventRing] })),
      h.fireReady,
    );
    const calls: unknown[] = [];
    node.events["peak"]!.on((p) => calls.push(p));
    // 1 slot 分 (= atSample i32 + level f32 = 8 byte) の newSlotsBytes を 構 築。
    const slotBuf = new ArrayBuffer(8);
    const view = new DataView(slotBuf);
    view.setInt32(0, 3, true);
    view.setFloat32(4, 0.5, true);
    // port listener 経 由 で event message dispatch を simulate
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
    // rAF flush し て も 追 加 fire ナ シ (= polling 不 要 = port driven)
    raf.flush();
    expect(calls).toEqual([{ atSample: 3, level: 0.5 }]);
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("node.events.<name>.on: drop-oldest 経 由 で sabTail 進 ん だ ら main local tail を 巻 き 直 す", async () => {
  // worklet 側 で drop-oldest 発 動 → SAB tail が main local tail を 越 え る path =
  // main 側 で max(localTail, sabTail) で drain 開 始 を 巻 き 直 す。
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
    // worklet で 多 数 emit 後 drop-oldest 連 発 = head 20, tail 4 (= 16 個 ring 内 で
    // 16 個 fill 済 + 4 個 drop)。 main local tail = 0、 sabTail = 4 = 巻 き 直 し で
    // tail = 4 か ら drain。
    for (let i = 0; i < 16; i++) {
      const slotIdx = (4 + i) % 16;
      slotsView.setInt32(slotIdx * 8, 4 + i, true); // atSample
      slotsView.setFloat32(slotIdx * 8 + 4, (4 + i) * 0.01, true); // level
    }
    Atomics.store(header, 1, 4); // tail = 4
    Atomics.store(header, 0, 20); // head = 20
    raf.flush();
    // 巻 き 直 し で tail = 4 か ら 16 個 drain、 atSample 4..19 の 順
    expect(calls.length).toBe(16);
    expect(calls[0]).toEqual({ atSample: 4, level: Math.fround(0.04) });
    expect(calls[15]).toEqual({ atSample: 19, level: Math.fround(0.19) });
  } finally {
    h.cleanup();
    raf.restore();
  }
});

test("node.events.<name>.on: handler が throw して も catch + console.error + 後続 fire 続 行", async () => {
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
    expect(errs.length).toBeGreaterThan(0); // throw が console.error に 流 れ た
    expect(goodCalls.length).toBe(1); // 後 続 handler は fire 続 行
  } finally {
    console.error = originalConsoleError;
    h.cleanup();
    raf.restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// node.messages.<name>(payload) sender + diagnostics (= sub-phase 7.7e)
// ─────────────────────────────────────────────────────────────────────────

const presetMessageRing = {
  name: "preset",
  wasmRingBase: 0,
  capacity: 16,
  slotSize: 4,
  fields: [{ name: "slot", wireType: "i32" as const, offsetInSlot: 0, byteSize: 4 }],
};

test("node.messages.<name>(payload): SAB slot に field 値 push + head += 1", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(h.context as never, makeMockProcessor({ messageRings: [presetMessageRing] })),
      h.fireReady,
    );
    const msgBuf = h.lastNode!.__constructorRecord.options.processorOptions!
      .messageRingsBuffer as SharedArrayBuffer;
    (node.messages["preset"] as (p: { slot: number }) => void)({ slot: 42 });
    const header = new Int32Array(msgBuf, 0, 3);
    expect(Atomics.load(header, 0)).toBe(1);
    const slotsView = new Int32Array(msgBuf, 12);
    expect(slotsView[0]).toBe(42);
  } finally {
    h.cleanup();
  }
});

test("node.messages.<name>(payload): 連 続 send で slot 列 順 fill", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () =>
        createNode(h.context as never, makeMockProcessor({ messageRings: [presetMessageRing] })),
      h.fireReady,
    );
    const msgBuf = h.lastNode!.__constructorRecord.options.processorOptions!
      .messageRingsBuffer as SharedArrayBuffer;
    const send = node.messages["preset"] as (p: { slot: number }) => void;
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

test("node.messages.<name>(payload): overflow path = capacity 4 で 5 send で overflowCount = 1", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const smallRing = { ...presetMessageRing, capacity: 4 };
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor({ messageRings: [smallRing] })),
      h.fireReady,
    );
    const msgBuf = h.lastNode!.__constructorRecord.options.processorOptions!
      .messageRingsBuffer as SharedArrayBuffer;
    const send = node.messages["preset"] as (p: { slot: number }) => void;
    send({ slot: 1 });
    send({ slot: 2 });
    send({ slot: 3 });
    send({ slot: 4 });
    send({ slot: 5 });
    const header = new Int32Array(msgBuf, 0, 3);
    expect(Atomics.load(header, 0)).toBe(5);
    expect(Atomics.load(header, 1)).toBe(1);
    expect(Atomics.load(header, 2)).toBe(1);
    expect(
      (
        node.messages["preset"] as { diagnostics: { overflowCount: () => number } }
      ).diagnostics.overflowCount(),
    ).toBe(1);
  } finally {
    h.cleanup();
  }
});

test("node.messages.<name>.diagnostics.overflowCount: SAB か ら Atomics.load", async () => {
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
    const diag = (node.messages["preset"] as { diagnostics: { overflowCount: () => number } })
      .diagnostics;
    expect(diag.overflowCount()).toBe(0);
    Atomics.store(header, 2, 77);
    expect(diag.overflowCount()).toBe(77);
  } finally {
    h.cleanup();
  }
});

test("node.messages.<name>(): void payload (= fields ナ シ) で fire = head += 1 + slot 書 込 ナ シ", async () => {
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
    const ping = node.messages["ping"] as unknown as () => void;
    ping();
    ping();
    const header = new Int32Array(msgBuf, 0, 3);
    expect(Atomics.load(header, 0)).toBe(2);
  } finally {
    h.cleanup();
  }
});

test("node.messages: message ナ シ processor で 空 object", async () => {
  const h = installMockGlobals(new Uint8Array([0, 1, 2]));
  try {
    const node = await startCreate(
      () => createNode(h.context as never, makeMockProcessor()),
      h.fireReady,
    );
    expect(node.messages).toEqual({});
  } finally {
    h.cleanup();
  }
});

test("node.messages.<name>(payload): boolean field を 0/1 i32 で push (= Q46 lift)", async () => {
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
    (node.messages["toggle"] as (p: { active: boolean }) => void)({ active: true });
    (node.messages["toggle"] as (p: { active: boolean }) => void)({ active: false });
    const slotsView = new Int32Array(msgBuf, 12);
    expect(slotsView[0]).toBe(1);
    expect(slotsView[1]).toBe(0);
  } finally {
    h.cleanup();
  }
});

test("node.messages.<name>(payload): postMessage transport = port.postMessage 直 送 + overflow は worklet 側 通 知 経 由 で mirror 更 新", async () => {
  // 新 仕 様: main 側 sender は SAB write じ ゃ な く `port.postMessage({ kind:
  // 'message', ringIndex, payload })` で 直 送。 overflow は worklet 側 で WASM ring
  // が 容 量 超 え 時 に drop-oldest 発 動 + port.postMessage({ kind: 'message-overflow',
  // ringIndex, overflowCount }) で main へ 通 知 = main 側 mirror 更 新 = diagnostics
  // で read。 ここ で は spy で port.postMessage を hook し て 5 件 全 送 信 担 保 +
  // worklet 通 知 を simulate し て mirror 更 新 + diagnostics 観 測。
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
    const send = node.messages["preset"] as (p: { slot: number }) => void;
    send({ slot: 1 });
    send({ slot: 2 });
    send({ slot: 3 });
    send({ slot: 4 });
    send({ slot: 5 });
    // 5 件 全 port.postMessage で 直 送
    expect(posted).toHaveLength(5);
    expect(posted[0]).toEqual({ kind: "message", ringIndex: 0, payload: { slot: 1 } });
    expect(posted[4]).toEqual({ kind: "message", ringIndex: 0, payload: { slot: 5 } });
    // 初 期 overflow = 0 (= worklet 通 知 未 受 領)
    const diag = (node.messages["preset"] as { diagnostics: { overflowCount: () => number } })
      .diagnostics;
    expect(diag.overflowCount()).toBe(0);
    // worklet が drop-oldest 発 動 を 通 知 する path を simulate
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

test("node.messages.<name>(payload): postMessage transport = port.postMessage 直 送 (= payload そ の ま ま carry)", async () => {
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
    (node.messages["preset"] as (p: { slot: number }) => void)({ slot: 99 });
    expect(posted).toEqual([{ kind: "message", ringIndex: 0, payload: { slot: 99 } }]);
  } finally {
    h.cleanup();
  }
});
