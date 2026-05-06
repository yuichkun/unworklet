// state.publish through the WASM worklet codepath. Mounts the generated
// worklet source in a Node vm, runs blocks, asserts a `publish` message
// arrives on the port carrying the changed value at the spec'd rate.
import { describe, expect, test } from "vite-plus/test";
import vm from "node:vm";
import { compileToWasm, generateWorkletModule } from "@unworklet/compiler";
import {
  defineProcessor,
  audioOutput,
  state,
  forSample,
  add,
} from "@unworklet/core";

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
    WebAssembly, URL, Blob,
    Uint8Array, Float32Array, Int32Array, DataView, Atomics, SharedArrayBuffer,
    Math, console, Number, Symbol, Map, Object, JSON, String, Array, Promise,
    setTimeout, clearTimeout, btoa: undefined, atob: undefined,
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  if (!RegisteredCtor) throw new Error("worklet did not register processor");
  return { inst: new RegisteredCtor(), port };
}

describe("state.publish in WASM worklet", () => {
  test("publishedStates drain emits a port message at the configured rate", () => {
    // 30 fps × (48000 / 30) = 1600 samples per publish → 1600 / 128 = 12.5
    // blocks. So after 16 blocks the worklet should have posted at least
    // one publish message containing `counter`.
    const proc = defineProcessor(() => {
      const out = audioOutput({ channels: 1, name: "main" });
      const counter = state.f32(0, { name: "counter", publish: { rateFps: 30 } });
      return {
        process: () => {
          forSample((i) => {
            counter.store(add(counter.load(), 1));
            out.set(0, i, 0);
          });
        },
      };
    });
    const r = compileToWasm(proc, { sampleRate: SR });
    const source = generateWorkletModule(r.graph, r.layout, r.binary, {
      processorName: "uwPub",
    });
    const w = bootWorklet(source, "uwPub");
    // The ready message fires on construction; its layout should include
    // the published-state entry for `counter`.
    const ready = w.port._outbound.find((m: any) => m.type === "ready");
    expect(ready).toBeTruthy();
    expect(ready.layout.publishedStates.length).toBeGreaterThan(0);
    expect(ready.layout.publishedStates[0].path).toMatch(/counter$/);

    // Run blocks; we don't have AudioWorklet's own process() driving us, so
    // call the WASM exports directly and then drive the worklet's process()
    // loop manually by mimicking what AudioWorklet would invoke.
    // The worklet's process() takes inputs/outputs/parameters arrays. We
    // pass enough structure for it to do its marshalling work (1 input
    // port × 1 channel × 128 samples; same for output).
    const inputs = [[new Float32Array(128)]];
    const outputs = [[new Float32Array(128)]];
    const params = {};
    for (let block = 0; block < 16; block++) {
      w.inst.process(inputs, outputs, params);
    }
    const publishes = w.port._outbound.filter((m: any) => m.type === "publish");
    expect(publishes.length).toBeGreaterThan(0);
    // The last publish should carry the cumulative counter value.
    const last = publishes[publishes.length - 1];
    const path = ready.layout.publishedStates[0].path;
    expect(typeof last.values[path]).toBe("number");
    expect(last.values[path]).toBeGreaterThan(0);
  });
});
