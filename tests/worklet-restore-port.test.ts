// Pins the wire-format contract on the worklet side: a snapshot blob
// delivered through the {type:"restore"} port-message protocol must be
// accepted by `_handleRestore` and applied to the linear-memory state
// region. The production `createWasmNode.restore()` uses the same wire
// format; the full host-wrapper roundtrip is covered separately in
// tests/createwasmnode-real.test.ts.
import { describe, expect, test } from "vite-plus/test";
import vm from "node:vm";
import {
  compileToWasm,
  generateWorkletModule,
} from "@unworklet/compiler";
import {
  defineProcessor,
  audioOutput,
  state,
  forSample,
  add,
} from "@unworklet/core";

const SR = 48000;

function bootWorkletInstance(source: string, processorName: string) {
  let RegisteredCtor: any = null;
  const port = {
    _onmessage: null as any,
    _outbound: [] as any[],
    set onmessage(h: any) { this._onmessage = h; },
    postMessage(m: any) { this._outbound.push(m); },
  };
  const ctx: any = {
    AudioWorkletProcessor: class {
      port: any;
      constructor() { this.port = port; }
    },
    registerProcessor: (name: string, ctor: any) => {
      if (name === `uw:${processorName}`) RegisteredCtor = ctor;
    },
    sampleRate: SR,
    WebAssembly, URL, Blob,
    Uint8Array, Float32Array, Int32Array, DataView, Atomics, SharedArrayBuffer,
    Math, console, Number, Symbol, Map, Object, JSON, String, Array, Promise,
    setTimeout, clearTimeout, btoa: undefined, atob: undefined,
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  if (!RegisteredCtor) throw new Error("worklet did not register processor");
  const inst = new RegisteredCtor();
  return { inst, port };
}

describe("worklet wire-format restore (port message)", () => {
  test("restore message reaches _handleRestore and the state region is updated", async () => {
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
    const r = compileToWasm(proc, { sampleRate: SR });
    const source = generateWorkletModule(r.graph, r.layout, r.binary, {
      processorName: "uwR",
    });
    // Snapshot path: drive instance A, ask for snapshot.
    const a = bootWorkletInstance(source, "uwR");
    for (let i = 0; i < 4; i++) a.inst.exports.process(128);
    // counter is at 4*128 = 512.
    a.port._onmessage({ data: { type: "snapshot", id: 1 } });
    const snap = a.port._outbound.find(
      (m: any) => m.type === "snapshot-response" && m.id === 1,
    );
    expect(snap).toBeTruthy();
    expect(snap.blob).toBeInstanceOf(Uint8Array);

    // Restore path: deliver the blob to a fresh instance via the same
    // port-message protocol createWasmNode.restore() uses.
    const b = bootWorkletInstance(source, "uwR");
    b.port._onmessage({ data: { type: "restore", id: 99, blob: snap.blob } });
    const resp = b.port._outbound.find(
      (m: any) => m.type === "restore-response" && m.id === 99,
    );
    expect(resp).toBeTruthy();
    expect(resp.result.error).toBeUndefined();
    expect(resp.result.restored).toBeGreaterThan(0);

    // Run one block on B: counter should now be 512 + 128.
    b.inst.exports.process(128);
    const cOff = r.layout.stateRegion.slots.find((s) => s.type === "f32")!.offset;
    const counter = new Float32Array(b.inst.exports.memory.buffer)[cOff >> 2]!;
    expect(counter).toBe(512 + 128);
  });
});
