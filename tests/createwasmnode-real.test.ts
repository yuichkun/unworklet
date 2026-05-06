// End-to-end test of `createWasmNode` itself (not just the worklet
// codepath underneath). We provide a fake BaseAudioContext +
// AudioWorkletNode that pipe through our locally-instantiated WASM module,
// then drive snapshot / restore / inspect / lifecycle from the test side.
import { describe, expect, test } from "vite-plus/test";
import vm from "node:vm";
import { createWasmNode } from "@unworklet/worklet";
import {
  defineProcessor,
  audioOutput,
  state,
  forSample,
  add,
} from "@unworklet/core";

const SR = 48000;

// Fake BaseAudioContext + AudioWorkletNode. The fake `addModule` runs the
// worklet source in a sandbox that captures its registerProcessor call;
// constructing AudioWorkletNode then instantiates the recorded class and
// wires its postMessage / onmessage to the main-thread side.
function makeMockContext() {
  let registeredCtor: any = null;
  let registeredName: string | null = null;
  const ctx: any = {
    sampleRate: SR,
    audioWorklet: {
      async addModule(url: string) {
        // Decode the Blob URL synchronously by calling URL.createObjectURL's
        // backing data — we stash the source on the URL string when we
        // emit it. Easier: read the Blob via fetch — but Node has no
        // fetch+Blob protocol for object URLs. So use the side channel:
        // tests/createwasmnode-real.test.ts intercepts URL.createObjectURL
        // (see installFakeURL) to remember each blob's source.
        const source = blobSourceByUrl.get(url);
        if (!source) throw new Error("addModule: blob source not found for " + url);
        const sandbox: any = {
          AudioWorkletProcessor: class {
            port: any;
            constructor() {
              this.port = sandboxPort;
            }
          },
          registerProcessor: (n: string, c: any) => {
            registeredName = n;
            registeredCtor = c;
          },
          sampleRate: SR,
          WebAssembly, URL, Blob, Math, console,
          Number, Symbol, Map, Object, JSON, String, Array, Promise,
          Uint8Array, Float32Array, Int32Array, DataView, Atomics, SharedArrayBuffer,
          setTimeout, clearTimeout, btoa: undefined, atob: undefined,
        };
        vm.createContext(sandbox);
        vm.runInContext(source, sandbox);
        if (!registeredCtor) throw new Error("worklet did not register a processor");
      },
    },
  };
  // Per-AudioWorkletNode port + the sandbox port the AudioWorkletProcessor sees.
  const sandboxPort: any = {
    _onmessage: null,
    _outbound: [] as any[],
    set onmessage(h: any) { this._onmessage = h; },
    postMessage(m: any) {
      // Side: worklet → main (forwarded to mainPort listeners)
      sandboxToMainBridge.deliver(m);
    },
  };
  const mainPortListeners: Array<(e: { data: any }) => void> = [];
  const pendingForMain: any[] = [];
  let mainStarted = false;
  const mainPort: any = {
    addEventListener(type: string, l: any) {
      if (type !== "message") return;
      mainPortListeners.push(l);
      if (mainStarted && pendingForMain.length) {
        const drain = pendingForMain.splice(0);
        for (const m of drain) for (const lst of mainPortListeners) lst({ data: m } as any);
      }
    },
    removeEventListener(type: string, l: any) {
      if (type !== "message") return;
      const i = mainPortListeners.indexOf(l);
      if (i >= 0) mainPortListeners.splice(i, 1);
    },
    start() {
      mainStarted = true;
      const drain = pendingForMain.splice(0);
      for (const m of drain) for (const l of mainPortListeners) l({ data: m } as any);
    },
    close() {},
    postMessage(m: any, _transfer?: any[]) {
      sandboxPort._onmessage?.({ data: m });
    },
  };
  const sandboxToMainBridge = {
    deliver(m: any) {
      // Real MessagePort buffers until start() / onmessage is set.
      if (!mainStarted || mainPortListeners.length === 0) {
        pendingForMain.push(m);
      } else {
        for (const l of mainPortListeners) l({ data: m } as any);
      }
    },
  };
  // The AudioWorkletNode constructor — invoke the worklet ctor + return
  // an object whose .port forwards through the bridge.
  (globalThis as any).AudioWorkletNode = class {
    port: any = mainPort;
    parameters: Map<string, any> = new Map();
    constructor(_ctx: any, name: string, _opts?: any) {
      if (!registeredCtor) throw new Error("addModule must be called first");
      if (name !== registeredName) throw new Error("processor name mismatch: " + name);
      // Construct the worklet processor; this triggers ready postMessage.
      new registeredCtor();
    }
    connect() {}
    disconnect() {}
  };
  return { ctx, getInst: () => registeredCtor };
}

const blobSourceByUrl = new Map<string, string>();
const origCreate = (URL as any).createObjectURL;
const origRevoke = (URL as any).revokeObjectURL;
let urlCounter = 0;
function installFakeURL() {
  (URL as any).createObjectURL = (b: Blob) => {
    const url = "blob:fake/" + ++urlCounter;
    // Read the blob synchronously by reading its `parts` via Symbol-tag.
    // In Node 22, Blob.text() is async; do a synchronous read by accessing
    // its slice → arrayBuffer via FileReader… not present. Instead use
    // (b as any).stream or a simple mock: we know our caller passes a
    // single string source.
    const parts = (b as any)._parts ?? (b as any).parts ?? null;
    if (parts && parts[0]) {
      blobSourceByUrl.set(url, String(parts[0]));
    } else {
      // Fallback: blocking read via Bun-style hack — but Node doesn't
      // have one. Make Blob carry its source on a side channel:
      blobSourceByUrl.set(url, (b as any).__source ?? "");
    }
    return url;
  };
  (URL as any).revokeObjectURL = () => {};
}
function restoreURL() {
  (URL as any).createObjectURL = origCreate;
  (URL as any).revokeObjectURL = origRevoke;
}

describe("createWasmNode end-to-end via mock AudioWorkletNode", () => {
  test("inspect() decodes the snapshot blob the worklet returns", async () => {
    const proc = defineProcessor(() => {
      const out = audioOutput({ channels: 1, name: "main" });
      const counter = state.f32(0, { name: "counter", snapshot: "persistent" });
      return {
        process: () => {
          forSample((i) => {
            counter.store(add(counter.load(), 1));
            out.set(0, i, counter.load());
          });
        },
      };
    });
    // Patch Blob to carry the source for our mock URL implementation.
    const OrigBlob = Blob;
    (globalThis as any).Blob = class extends OrigBlob {
      __source: string;
      constructor(parts: any[], options?: BlobPropertyBag) {
        super(parts, options);
        this.__source = String(parts[0] ?? "");
      }
    };
    installFakeURL();
    try {
      const { ctx } = makeMockContext();
      const node = await createWasmNode(ctx, proc, "uwReal");
      const blob = await node.snapshot();
      const meta = node.inspect(blob);
      expect(meta.format).toBe("wasm");
      expect(meta.version).toBe(1);
      expect(typeof meta.schemaHash).toBe("string");
      expect(meta.stateBytes).toBeGreaterThan(0);
    } finally {
      restoreURL();
      (globalThis as any).Blob = OrigBlob;
    }
  });
});
