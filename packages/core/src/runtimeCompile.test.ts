/**
 * `compileForContext` — compiles a `?worklet` processor for an AudioContext whose
 * sample rate or render quantum differs from the build's, in a page Web Worker
 * started from `worklet.compileWorkerUrl`, then registers the returned worklet
 * module on the context from a Blob URL.
 *
 * Node has no `Worker`; each test installs a scripted one that speaks the
 * compile-worker protocol (`ready`, then one `result` / `error` per request).
 */

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import "./dsl/primitives.ts";
import { compile } from "./compile/index.ts";
import type { CapturedGraph } from "./compile/ast.ts";
import { f32 } from "./dsl/constructors.ts";
import { audioOutput, event } from "./dsl/declarations.ts";
import { forSample } from "./dsl/loop.ts";
import { defineProcessor } from "./processor.ts";
import type { WorkletNamespace } from "./types.ts";
import { extractWorkletMeta } from "./worklet.ts";

import { compileForContext } from "./runtimeCompile.ts";

const tone = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  const meter = event<{ value: number }>({ to: "main", name: "meter", capacity: 16 });
  return {
    process: () => {
      meter.emitIf(false, { value: 0 });
      forSample((i) =>
        out
          .ch(0)
          .at(i)
          .write(f32(440 / ctx.sampleRate)),
      );
    },
  };
});

type Reply = { type: "result" | "error"; [key: string]: unknown };
type Behaviour = "reply" | "error" | "crash" | "crash-silently" | "silent";

/** What a scripted worker does with the requests it receives. */
let behaviour: Behaviour = "reply";
const workers: FakeWorker[] = [];

class FakeWorker {
  readonly url: string;
  readonly options: unknown;
  readonly requests: Array<Record<string, unknown>> = [];
  terminated = false;
  private listeners: Record<string, Array<(event: unknown) => void>> = {};
  constructor(url: string, options: unknown) {
    this.url = url;
    this.options = options;
    workers.push(this);
    setTimeout(() => {
      if (behaviour === "crash") this.emit("error", { message: "worker script failed to load" });
      else if (behaviour === "crash-silently") this.emit("error", {});
      else this.emit("message", { data: { type: "ready" } });
    }, 0);
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  postMessage(request: Record<string, unknown>): void {
    this.requests.push(request);
    if (behaviour === "silent") return;
    void reply(request).then((data) => {
      if (!this.terminated) this.emit("message", { data });
    });
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Workers still running (constructed and not terminated). */
  static alive(): number {
    return workers.filter((w) => !w.terminated).length;
  }
  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

async function reply(request: Record<string, unknown>): Promise<Reply> {
  if (behaviour === "error") {
    return {
      type: "error",
      id: request.id,
      message: "unworklet: compile failed with 1 error(s):\n[illegal-stride] stride 64",
    };
  }
  const result = await compile(tone, {
    sampleRate: request.sampleRate as number,
    renderQuantumSize: request.renderQuantumSize as number,
  });
  return {
    type: "result",
    id: request.id,
    wasm: result.wasm,
    meta: extractWorkletMeta(result.graph as unknown as CapturedGraph),
    moduleSource: `registerProcessor(${JSON.stringify(request.processorName)}, class {});`,
  };
}

type FakeContext = { audioWorklet: { addModule: (url: string) => Promise<void> } };
const addModuleCalls: Array<{ context: FakeContext; url: string }> = [];
const makeContext = (): FakeContext => {
  const context: FakeContext = {
    audioWorklet: {
      addModule: (url: string) => {
        addModuleCalls.push({ context, url });
        return Promise.resolve();
      },
    },
  };
  return context;
};

const revoked: string[] = [];
let testIndex = 0;
/** A namespace whose worker URL is unique per test, so the page cache never leaks across tests. */
const namespace = (): WorkletNamespace => ({
  ...tone.worklet,
  processorName: "tone__abc",
  displayName: "tone",
  bakedSampleRate: 48000,
  compileWorkerUrl: `/assets/tone.compile-worker-${testIndex}.js`,
});

const realWorker = (globalThis as { Worker?: unknown }).Worker;
beforeEach(() => {
  testIndex++;
  behaviour = "reply";
  workers.length = 0;
  addModuleCalls.length = 0;
  revoked.length = 0;
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
    revoked.push(url);
  });
});
afterEach(() => {
  (globalThis as { Worker?: unknown }).Worker = realWorker;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const as = <T>(value: unknown): T => value as T;

test("the worker is started as a module, asked once ready, and terminated after its reply", async () => {
  const ns = namespace();
  const compiled = await compileForContext(as(makeContext()), ns, {
    sampleRate: 44100,
    renderQuantumSize: 128,
  });
  expect(workers).toHaveLength(1);
  expect(workers[0]!.url).toBe(ns.compileWorkerUrl);
  expect(workers[0]!.options).toEqual({ type: "module" });
  expect(workers[0]!.requests).toEqual([
    {
      type: "compile",
      id: 1,
      sampleRate: 44100,
      renderQuantumSize: 128,
      processorName: "tone__abc@44100x128",
    },
  ]);
  expect(workers[0]!.terminated).toBe(true);
  expect(compiled.wasmModule).toBeInstanceOf(WebAssembly.Module);
});

test("the namespace describes the compiled target and keeps the display name and worker", async () => {
  const ns = namespace();
  const { ns: runtime } = await compileForContext(as(makeContext()), ns, {
    sampleRate: 96000,
    renderQuantumSize: 32,
  });
  expect(runtime.processorName).toBe("tone__abc@96000x32");
  expect(runtime.displayName).toBe("tone");
  expect(runtime.bakedSampleRate).toBe(96000);
  expect(runtime.bakedRenderQuantumSize).toBe(32);
  expect(runtime.compileWorkerUrl).toBe(ns.compileWorkerUrl);
  // Descriptors come from the compiled layout, not from the build's.
  const expected = await compile(tone, { sampleRate: 96000, renderQuantumSize: 32 });
  const meta = extractWorkletMeta(expected.graph as unknown as CapturedGraph);
  expect(runtime.eventRings[0]!.wasmRingBase).toBe(
    meta.layout.regions.eventRings.slots.meter!.base,
  );
  expect(runtime.eventRings[0]!.wasmRingBase).not.toBe(ns.eventRings[0]!.wasmRingBase);
});

test("the module is registered from a Blob URL that is revoked once addModule settles", async () => {
  const context = makeContext();
  await compileForContext(as(context), namespace(), { sampleRate: 44100, renderQuantumSize: 128 });
  expect(addModuleCalls).toHaveLength(1);
  expect(addModuleCalls[0]!.url).toMatch(/^blob:/);
  expect(revoked).toEqual([addModuleCalls[0]!.url]);
});

test("one compile serves every context, and each context registers the module once", async () => {
  const ns = namespace();
  const target = { sampleRate: 44100, renderQuantumSize: 128 };
  const first = makeContext();
  const second = makeContext();
  await Promise.all([
    compileForContext(as(first), ns, target),
    compileForContext(as(first), ns, target),
    compileForContext(as(second), ns, target),
  ]);
  await compileForContext(as(second), ns, target);
  expect(workers).toHaveLength(1);
  expect(addModuleCalls.map((call) => call.context)).toEqual([first, second]);
});

test("a different target compiles again", async () => {
  const ns = namespace();
  const context = makeContext();
  await compileForContext(as(context), ns, { sampleRate: 44100, renderQuantumSize: 128 });
  await compileForContext(as(context), ns, { sampleRate: 44100, renderQuantumSize: 256 });
  expect(workers.map((w) => w.requests[0]!.processorName)).toEqual([
    "tone__abc@44100x128",
    "tone__abc@44100x256",
  ]);
  expect(addModuleCalls).toHaveLength(2);
});

test("at most two workers compile at once; the rest wait for a free slot", async () => {
  const ns = namespace();
  const context = makeContext();
  let peak = 0;
  const watch = setInterval(() => {
    peak = Math.max(peak, FakeWorker.alive());
  }, 0);
  try {
    await Promise.all(
      [22050, 32000, 44100, 88200].map((sampleRate) =>
        compileForContext(as(context), ns, { sampleRate, renderQuantumSize: 128 }),
      ),
    );
  } finally {
    clearInterval(watch);
  }
  expect(workers).toHaveLength(4);
  expect(peak).toBeGreaterThan(0);
  expect(peak).toBeLessThanOrEqual(2);
});

test("a compile error names the processor, the target and the diagnostic, and is retried next time", async () => {
  const ns = namespace();
  const context = makeContext();
  const target = { sampleRate: 48000, renderQuantumSize: 32 };
  behaviour = "error";
  await expect(compileForContext(as(context), ns, target)).rejects.toThrow(
    /could not compile tone for 48000 Hz and 32-sample render quanta[\s\S]*\[illegal-stride\]/,
  );
  expect(workers[0]!.terminated).toBe(true);
  expect(addModuleCalls).toEqual([]);
  behaviour = "reply";
  await compileForContext(as(context), ns, target);
  expect(workers).toHaveLength(2);
});

test("a worker that fails to start rejects with its error", async () => {
  behaviour = "crash";
  await expect(
    compileForContext(as(makeContext()), namespace(), {
      sampleRate: 44100,
      renderQuantumSize: 128,
    }),
  ).rejects.toThrow(/could not compile tone for 44100 Hz[\s\S]*worker script failed to load/);
  expect(workers[0]!.terminated).toBe(true);
});

test("a worker error without a message still rejects, and a namespace without a display name is named by its processor name", async () => {
  behaviour = "crash-silently";
  const { displayName: _omitted, ...unnamed } = namespace();
  await expect(
    compileForContext(as(makeContext()), unnamed, { sampleRate: 44100, renderQuantumSize: 128 }),
  ).rejects.toThrow(/could not compile tone__abc for 44100 Hz[\s\S]*failed to start/);
});

test("the namespace of a processor without a display name carries none", async () => {
  const { displayName: _omitted, ...unnamed } = namespace();
  const { ns: runtime } = await compileForContext(as(makeContext()), unnamed, {
    sampleRate: 44100,
    renderQuantumSize: 128,
  });
  expect("displayName" in runtime).toBe(false);
  expect(runtime.processorName).toBe("tone__abc@44100x128");
});

test("a worker that never replies is terminated after 60 seconds", async () => {
  vi.useFakeTimers();
  behaviour = "silent";
  const pending = compileForContext(as(makeContext()), namespace(), {
    sampleRate: 44100,
    renderQuantumSize: 128,
  });
  const settled = expect(pending).rejects.toThrow(/timed out after 60000 ms/);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(workers[0]!.terminated).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await settled;
  expect(workers[0]!.terminated).toBe(true);
});

test("a failed addModule is retried on the next call for that context", async () => {
  const ns = namespace();
  const target = { sampleRate: 44100, renderQuantumSize: 128 };
  const context = makeContext();
  let fail = true;
  const addModule = context.audioWorklet.addModule;
  context.audioWorklet.addModule = (url: string) =>
    fail ? Promise.reject(new Error("refused by Content-Security-Policy")) : addModule(url);
  await expect(compileForContext(as(context), ns, target)).rejects.toThrow(
    /Content-Security-Policy/,
  );
  fail = false;
  await compileForContext(as(context), ns, target);
  expect(addModuleCalls).toHaveLength(1);
  expect(workers).toHaveLength(1);
  expect(revoked).toHaveLength(2);
});

test("without Worker support the call rejects instead of compiling", async () => {
  (globalThis as { Worker?: unknown }).Worker = undefined;
  await expect(
    compileForContext(as(makeContext()), namespace(), {
      sampleRate: 44100,
      renderQuantumSize: 128,
    }),
  ).rejects.toThrow(/Web Workers are unavailable/);
});
