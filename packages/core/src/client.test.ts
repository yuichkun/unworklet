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

const installMockGlobals = (wasmBytes: Uint8Array, opts: MockHarnessOptions = {}): MockHarness => {
  const fetchOk = opts.fetchOk ?? true;
  const fetchStatus = opts.fetchStatus ?? 200;
  const fetchStatusText = opts.fetchStatusText ?? "OK";

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
        start: () => {},
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

test("`inspect(blob)` stub throws", () => {
  expect(() => inspect(new Uint8Array(0))).toThrow(/not implemented/);
});
