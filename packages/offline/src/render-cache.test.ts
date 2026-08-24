/**
 * `renderOffline` compile caching (issue #39): the compile pipeline (graph
 * re-capture → analysis → binaryen emit) dominates wall time by an order of
 * magnitude on a mid-size processor (~8 s reported), so a naturally-written
 * test suite — one render per test — times out. Repeat renders of the SAME
 * processor at the SAME sample rate must reuse the compiled artifact; only
 * the WASM instantiation (fresh per render, so state never leaks between
 * renders) repeats.
 *
 * The observable is the platform seam, not unworklet internals: every path to
 * a runnable module goes through `WebAssembly.compile`, exactly once per
 * distinct (processor, sampleRate) — a second call means either the compile
 * result or the driver's module was rebuilt.
 */

import { expect, test, vi } from "vite-plus/test";

import { audioOutput, defineProcessor, forSample, state } from "@unworklet/core";

import { renderOffline } from "./index.ts";

const makeCounter = () =>
  defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const n = state.f32(0);
    return {
      process: () => {
        forSample((i) => {
          n.write(n.read().add(1));
          out.ch(0).at(i).write(n.read().mul(0.001));
        });
      },
    };
  });

// This package's lib set types `WebAssembly` as a namespace only; reach the
// runtime value through globalThis for the spy.
type WasmCompile = (bytes: ArrayBuffer | ArrayBufferView) => Promise<WebAssembly.Module>;
const wasmGlobal = (globalThis as unknown as { WebAssembly: { compile: WasmCompile } }).WebAssembly;

const countWasmCompiles = async (run: () => Promise<void>): Promise<number> => {
  const real = wasmGlobal.compile.bind(wasmGlobal);
  let calls = 0;
  const spy = vi.spyOn(wasmGlobal, "compile").mockImplementation((bytes) => {
    calls++;
    return real(bytes);
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return calls;
};

test("repeat renders of one processor at one rate compile exactly once", async () => {
  const proc = makeCounter();
  const calls = await countWasmCompiles(async () => {
    await renderOffline(proc, { sampleRate: 48000, duration: 128 / 48000 });
    await renderOffline(proc, { sampleRate: 48000, duration: 128 / 48000 });
    await renderOffline(proc, { sampleRate: 48000, duration: 256 / 48000 });
  });
  expect(calls).toBe(1);
});

test("cached renders are bit-identical to each other and state does not leak between them", async () => {
  const proc = makeCounter();
  const a = await renderOffline(proc, { sampleRate: 48000, duration: 128 / 48000 });
  const b = await renderOffline(proc, { sampleRate: 48000, duration: 128 / 48000 });
  // A fresh instance per render: the accumulator restarts, so outputs match
  // exactly. A shared instance would keep counting and diverge.
  expect(Array.from(b.outputs.main![0]!)).toEqual(Array.from(a.outputs.main![0]!));
  expect(a.outputs.main![0]![0]).toBeCloseTo(0.001, 6);
});

test("concurrent renders of one processor coalesce onto a single compile", async () => {
  const proc = makeCounter();
  const calls = await countWasmCompiles(async () => {
    await Promise.all([
      renderOffline(proc, { sampleRate: 48000, duration: 128 / 48000 }),
      renderOffline(proc, { sampleRate: 48000, duration: 128 / 48000 }),
    ]);
  });
  expect(calls).toBe(1);
});

test("a different sample rate is a different compile (rate-dependent folding must not be reused)", async () => {
  const proc = makeCounter();
  const calls = await countWasmCompiles(async () => {
    await renderOffline(proc, { sampleRate: 48000, duration: 128 / 48000 });
    await renderOffline(proc, { sampleRate: 44100, duration: 128 / 44100 });
  });
  expect(calls).toBe(2);
});
