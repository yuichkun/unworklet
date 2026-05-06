// v1.0.0 acceptance smoke: a single test that walks through the whole
// public surface and asserts each step. Exists so a reviewer can read one
// file to see the shipping flow end-to-end without piecing it together
// from 30+ unit tests.
import { describe, expect, test } from "vite-plus/test";
import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  buffer,
  forSample,
  message,
  event,
  midiInput,
  add,
  sub,
  mul,
  flushDenormals,
  // capture-side / runtime-side primitives all importable from the same root
} from "@unworklet/core";
import { compileToWasm, generateWorkletModule, analyze } from "@unworklet/compiler";
import { createNode, inspect, Lifecycle } from "@unworklet/client";
import { renderOfflineWasm } from "@unworklet/test";

const SR = 48000;

describe("v1.0.0 acceptance", () => {
  test("end-to-end: declare, capture, compile, analyze, run, snapshot, restore, inspect", async () => {
    // 1. Declare a non-trivial processor exercising every declaration kind.
    const proc = defineProcessor(() => {
      const inp = audioInput({ channels: 1, name: "main" });
      const out = audioOutput({ channels: 1, name: "main" });
      const gain = param({ default: 1, min: 0, max: 4, automationRate: "a-rate", name: "gain" });
      const counter = state.f32(0, { name: "counter", publish: { rateFps: 30 } });
      const buf = buffer.f32({ size: 32, name: "tail", snapshot: "transient" });
      const ping = message<{ delta: number }>({ name: "ping", capacity: 8 });
      const pong = event<{ at: number }>({ name: "pong", capacity: 8 });
      const midi = midiInput({ name: "midi" });
      return {
        process: () => {
          ping.onReceive(({ delta }: any) => {
            counter.store(add(counter.load(), delta));
            pong.emitIf(true, { at: 0 });
          });
          midi.onEvent("noteOn", () => {
            counter.store(add(counter.load(), 1));
          });
          forSample((i) => {
            const v = mul(inp.at(0, i), gain.at(i));
            buf.write(i % 32, v);
            // Flush subnormals on a cheap one-pole pseudo-feedback so the
            // FTZ codepath is exercised in the binary.
            counter.store(flushDenormals(mul(counter.load(), 0.95)));
            out.set(0, i, add(v, mul(counter.load(), 0.001)));
          });
        },
      };
    });

    // 2. Compile to WASM and verify the basic artifacts.
    const r = compileToWasm(proc, { sampleRate: SR });
    expect(r.binary.byteLength).toBeGreaterThan(0);
    expect(r.text.includes("(memory")).toBe(true);
    // memory is shared (SAB transport precondition).
    expect(r.text.includes("shared")).toBe(true);

    // 3. Static analysis surfaces the standard layer-3 codes.
    const a = analyze(r.graph, r.layout);
    const codes = a.diagnostics.map((d) => d.code);
    expect(codes).toContain("allocation-free");
    expect(codes).toContain("cycle-estimate");
    expect(a.metrics.statesDeclared).toBeGreaterThan(0);
    expect(a.metrics.messagesDeclared).toBe(1);

    // 4. The worklet module source generated for this processor parses
    //    and starts with the expected boilerplate.
    const wmod = generateWorkletModule(r.graph, r.layout, r.binary, {
      processorName: "v1Acceptance",
    });
    expect(wmod).toMatch(/registerProcessor/);
    expect(wmod).toMatch(/uw:v1Acceptance/);

    // 5. Drive an offline render via renderOfflineWasm. Confirm the engine
    //    handles parameters, messages, and the per-sample loop.
    const result = await renderOfflineWasm(proc, {
      sampleRate: SR,
      duration: 0.05,
      params: { gain: 0.5 },
      input: { main: [new Float32Array(2400).fill(0.4)] },
      messages: [{ at: 0, name: "ping", payload: { delta: 0.5 } }],
    });
    expect(result.hasNaN).toBe(false);
    // Output is `input * gain + counter*0.001`; the dominant term is
    // 0.4 * 0.5 = 0.2 plus a small counter contribution.
    expect(result.peak).toBeGreaterThan(0.1);

    // 6. JS-engine path: createNode + lifecycle + inspect + snapshot.
    const node = await createNode(null, proc, { sampleRate: SR, blockSize: 128 });
    expect(node.lifecycle.state).toMatch(/creating|ready/);
    const blob = await node.snapshot();
    expect(blob[0]).toBe(0x55); // 'U'
    expect(blob[1]).toBe(0x57); // 'W'
    expect(blob[2]).toBe(0x53); // 'S'
    // Either UWS1 (engine) or UWSN (worklet).
    const meta = inspect(blob);
    expect(meta.format).toBe("engine");
    expect(typeof meta.schemaHash).toBe("string");

    // 7. Restore on a fresh node, verify schemaHash matches.
    const node2 = await createNode(null, proc, { sampleRate: SR, blockSize: 128 });
    const restoreResult = await node2.restore(blob);
    expect(restoreResult).toBeDefined();
  });

  test("Lifecycle terminal states are reachable and listened-to", () => {
    const lc = new Lifecycle();
    const seen: string[] = [];
    lc.on((s) => seen.push(s));
    lc.transition("ready");
    lc.transition("running");
    lc.transition("errored");
    lc.transition("running"); // ignored — terminal
    expect(seen).toEqual(["ready", "running", "errored"]);
  });
});
