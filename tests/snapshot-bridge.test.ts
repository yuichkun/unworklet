// Direct unit test for engineSnapshotToWasm: the host-walked migration
// helper that converts a JS-engine UWS1 blob into a WASM-format UWSN blob
// the worklet's _handleRestore consumes. The previous migration test
// (tests/migration-wasm.test.ts) only drove the JS Engine; this one
// exercises the bridge in both directions and asserts the worklet can
// re-load a state-only round-trip via the bridge.
import { describe, expect, test } from "vite-plus/test";
import { engineSnapshotToWasm } from "@unworklet/worklet";
import { compileToWasm, generateWorkletModule } from "@unworklet/compiler";
import {
  defineProcessor,
  audioOutput,
  state,
  forSample,
  add,
} from "@unworklet/core";
// @ts-ignore — internal subpath
import { Engine } from "@unworklet/core/internal";
import vm from "node:vm";

const SR = 48000;

function bootWorklet(source: string, processorName: string) {
  let RegisteredCtor: any = null;
  const port: any = {
    _onmessage: null,
    _outbound: [] as any[],
    set onmessage(h: any) { this._onmessage = h; },
    postMessage(m: any) { this._outbound.push(m); },
  };
  const ctx: any = {
    AudioWorkletProcessor: class { port: any; constructor() { this.port = port; } },
    registerProcessor: (n: string, c: any) => { if (n === `uw:${processorName}`) RegisteredCtor = c; },
    sampleRate: SR,
    WebAssembly, URL, Blob, Math, console,
    Number, Symbol, Map, Object, JSON, String, Array, Promise,
    Uint8Array, Float32Array, Int32Array, DataView, Atomics, SharedArrayBuffer,
    setTimeout, clearTimeout, btoa: undefined, atob: undefined,
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return { inst: new RegisteredCtor(), port };
}

describe("engineSnapshotToWasm bridge", () => {
  test("UWS1 blob → engineSnapshotToWasm → worklet _handleRestore preserves state", async () => {
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
      processorName: "uwBridge",
    });
    // Drive a JS Engine to mutate, snapshot in UWS1.
    const eng = new Engine(proc, { sampleRate: SR, blockSize: 128 });
    eng.rt.allScopes
      .flatMap((s: any) => s.states)
      .find((s: any) => s.slot.name === "counter")!.write(777);
    const uws1 = eng.snapshot();
    expect(uws1[0]).toBe(0x55); // 'U'
    expect(uws1[1]).toBe(0x57); // 'W'
    expect(uws1[2]).toBe(0x53); // 'S'
    expect(uws1[3]).toBe(0x31); // '1'
    // Bridge → UWSN.
    const uwsn = await engineSnapshotToWasm(proc, uws1, {
      schemaHash: r.graph.schemaHash,
      stateRegion: {
        offset: r.layout.stateRegion.offset,
        size: r.layout.stateRegion.size,
        slots: r.layout.stateRegion.slots.map((sl) => {
          const decl = r.graph.declarations.states.find((s) => s.id === sl.slotId)!;
          return { ...sl, path: decl.path, snapshot: decl.snapshot };
        }),
      },
      bufferRegion: {
        offset: r.layout.bufferRegion.offset,
        size: r.layout.bufferRegion.size,
        buffers: r.layout.bufferRegion.buffers.map((bl) => {
          const decl = r.graph.declarations.buffers.find((b) => b.id === bl.bufferId)!;
          return { ...bl, path: decl.path, snapshot: decl.snapshot };
        }),
      },
    });
    expect(uwsn).toBeTruthy();
    expect(uwsn![0]).toBe(0x55);
    expect(uwsn![1]).toBe(0x57);
    expect(uwsn![2]).toBe(0x53);
    expect(uwsn![3]).toBe(0x4e); // 'N'

    // Boot the worklet, deliver the bridged blob to _handleRestore.
    const w = bootWorklet(source, "uwBridge");
    w.port._onmessage({ data: { type: "restore", id: 1, blob: uwsn } });
    const resp = w.port._outbound.find(
      (m: any) => m.type === "restore-response" && m.id === 1,
    );
    expect(resp).toBeTruthy();
    expect(resp.result.error).toBeUndefined();
    // Run one block; counter must be 777 + 128.
    w.inst.exports.process(128);
    const cOff = r.layout.stateRegion.slots.find((s) => s.type === "f32")!.offset;
    const counter = new Float32Array(w.inst.exports.memory.buffer)[cOff >> 2]!;
    expect(counter).toBe(777 + 128);
  });
});
