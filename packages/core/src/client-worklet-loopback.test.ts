/**
 * Loopback harness: the REAL `createNode` main-thread transport wired to the
 * REAL worklet namespace over an in-process port bridge, running real WASM —
 * a node-runnable stand-in for the browser's client ↔ worklet pair.
 *
 * Exists to prove cross-thread ring-protocol properties that neither side's
 * isolated mocks can see. The offline renderer cannot stand in here: it owns
 * both sides of the ring and commits `tail = head` after every quantum, so the
 * consumer→producer feedback path it exercises is not the one `client.ts`
 * ships.
 *
 * The property under test (issue #5): a worklet→main ring drained promptly by
 * the consumer must never report overflow, no matter how many events the
 * producer emits over its lifetime. The producer-side check is
 * `head - tail >= capacity` inside WASM, so the consumer's drain position has
 * to flow back: main commits its consumed tail into the shared header, and the
 * worklet mirrors it into the WASM header before each `process()`. Without
 * that feedback the check saturates after `capacity` lifetime emits and every
 * later emit false-fires drop-oldest.
 */

import "./dsl/primitives.ts"; // side-effect: register `Node<T>` method forms

import { expect, test } from "vite-plus/test";

import { createNode } from "./client.ts";
import { compile } from "./compile/index.ts";
import { CAPACITY_16, SAMPLES_PER_BLOCK } from "./dsl/constants.ts";
import { audioOutput, event, state } from "./dsl/declarations.ts";
import { forSample } from "./dsl/loop.ts";
import { defineProcessor } from "./processor.ts";
import type { CompiledProcessor, MidiEvent } from "./types.ts";

type PortListener = (e: { data: unknown }) => void;

type LoopbackHarness = {
  context: { sampleRate: number; audioWorklet: { addModule: (url: string) => Promise<void> } };
  workletSelf: {
    port: {
      postMessage: (m: unknown) => void;
      addEventListener: (kind: string, fn: PortListener) => void;
      start: () => void;
    };
  };
  /** processorOptions captured from the mock AudioWorkletNode constructor. */
  capturedProcessorOptions: () => Record<string, unknown>;
  /** True once the mock node exists and the client's port listener is attached. */
  readyToInitialize: () => boolean;
  /** Fire every rAF callback queued at entry (one main-thread drain pass). */
  pumpRaf: () => void;
  cleanup: () => void;
};

/**
 * Install the loopback globals. Unlike `client.test.ts`'s mock harness this
 * keeps `WebAssembly.compile` REAL (the worklet side instantiates the module)
 * and bridges the two ports so `ready` / fallback data messages actually flow.
 */
const installLoopback = (
  wasmBytes: Uint8Array,
  opts: { crossOriginIsolated: boolean },
): LoopbackHarness => {
  const coiTarget = globalThis as unknown as { crossOriginIsolated?: boolean };
  const prevCoi = coiTarget.crossOriginIsolated;
  if (opts.crossOriginIsolated) {
    coiTarget.crossOriginIsolated = true;
  } else {
    delete coiTarget.crossOriginIsolated;
  }

  // ---- port bridge ----
  // Client→worklet messages posted before the worklet attaches its listener
  // (e.g. the egress pool seed sent during createNode, before initialize runs)
  // are queued and flushed on attach — mirroring real MessagePort semantics,
  // where messages buffer until the receiving side starts listening.
  const clientPortListeners: PortListener[] = [];
  const workletPortListeners: PortListener[] = [];
  const pendingToWorklet: unknown[] = [];
  const workletSelf: LoopbackHarness["workletSelf"] = {
    port: {
      postMessage: (m: unknown) => {
        // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot: a listener (awaitReady) removes itself during dispatch
        for (const fn of [...clientPortListeners]) fn({ data: m });
      },
      addEventListener: (kind: string, fn: PortListener) => {
        if (kind !== "message") return;
        workletPortListeners.push(fn);
        const backlog = pendingToWorklet.splice(0, pendingToWorklet.length);
        for (const m of backlog) fn({ data: m });
      },
      start: () => {},
    },
  };

  let captured: Record<string, unknown> | null = null;
  const readyToInitialize = (): boolean => captured !== null && clientPortListeners.length > 0;
  class LoopbackWorkletNode {
    port = {
      postMessage: (m: unknown) => {
        if (workletPortListeners.length === 0) {
          pendingToWorklet.push(m);
          return;
        }
        // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot against listener-list mutation during dispatch
        for (const fn of [...workletPortListeners]) fn({ data: m });
      },
      onmessage: null as PortListener | null,
      addEventListener: (kind: string, fn: PortListener) => {
        if (kind === "message") clientPortListeners.push(fn);
      },
      removeEventListener: (_kind: string, fn: PortListener) => {
        const idx = clientPortListeners.indexOf(fn);
        if (idx >= 0) clientPortListeners.splice(idx, 1);
      },
      start: () => {},
      close: () => {},
    };
    parameters = { get: (_name: string) => ({ value: 0 }) };
    context: unknown;
    constructor(ctx: unknown, _name: string, nodeOptions: { processorOptions?: unknown }) {
      this.context = ctx;
      captured = (nodeOptions.processorOptions ?? {}) as Record<string, unknown>;
    }
    addEventListener(_kind: string, _fn: unknown): void {}
    removeEventListener(_kind: string, _fn: unknown): void {}
    connect(target: unknown): unknown {
      return target;
    }
    disconnect(): void {}
  }
  (globalThis as Record<string, unknown>).AudioWorkletNode = LoopbackWorkletNode;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      // Not `application/wasm`: that routes into `WebAssembly.compileStreaming`,
      // which node rejects for a mock (non-Response) object. The octet-stream
      // fallback path compiles from the ArrayBuffer instead.
      headers: { get: (_name: string) => "application/octet-stream" },
      arrayBuffer: (): Promise<ArrayBuffer> =>
        Promise.resolve(
          wasmBytes.buffer.slice(
            wasmBytes.byteOffset,
            wasmBytes.byteOffset + wasmBytes.byteLength,
          ) as ArrayBuffer,
        ),
    })) as unknown as typeof globalThis.fetch;

  // ---- manual rAF pump ----
  const rafQueue: Array<() => void> = [];
  const rafTarget = globalThis as unknown as {
    requestAnimationFrame?: (cb: () => void) => number;
    cancelAnimationFrame?: (h: number) => void;
  };
  const prevRaf = rafTarget.requestAnimationFrame;
  const prevCancelRaf = rafTarget.cancelAnimationFrame;
  rafTarget.requestAnimationFrame = (cb: () => void): number => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  rafTarget.cancelAnimationFrame = (_h: number): void => {};

  const context = {
    sampleRate: 48000,
    audioWorklet: { addModule: (_url: string) => Promise.resolve() },
  };

  return {
    context,
    workletSelf,
    capturedProcessorOptions: () => {
      if (captured === null) throw new Error("AudioWorkletNode not constructed yet");
      return captured;
    },
    readyToInitialize,
    pumpRaf: () => {
      const batch = rafQueue.splice(0, rafQueue.length);
      for (const cb of batch) cb();
    },
    cleanup: () => {
      globalThis.fetch = originalFetch;
      delete (globalThis as Record<string, unknown>).AudioWorkletNode;
      if (prevRaf !== undefined) rafTarget.requestAnimationFrame = prevRaf;
      else delete rafTarget.requestAnimationFrame;
      if (prevCancelRaf !== undefined) rafTarget.cancelAnimationFrame = prevCancelRaf;
      else delete rafTarget.cancelAnimationFrame;
      if (prevCoi === undefined) delete coiTarget.crossOriginIsolated;
      else coiTarget.crossOriginIsolated = prevCoi;
    },
  };
};

/** Give a compiled processor the bundler-derived namespace fields createNode requires. */
const withWorkletUrls = <C>(p: CompiledProcessor<C>): CompiledProcessor<C> =>
  ({
    ...p,
    worklet: {
      ...p.worklet,
      moduleUrl: "/loopback.worklet.js",
      wasmUrl: "/loopback.wasm",
      processorName: "loopback__test__test",
    },
  }) as CompiledProcessor<C>;

/** One event emit per quantum (at sample 0), ring capacity 16. */
const makeTickProcessor = () =>
  defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const tick = event<{ n: number }>({ to: "main", name: "tick", capacity: CAPACITY_16 });
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(0);
          tick.emitIf(i.eq(0), { n: i });
        });
      },
    };
  });

/** One outbound MIDI noteOn per quantum (at sample 0), ring capacity 16. */
const makeMidiTickProcessor = () =>
  defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const mo = event.midi({ to: "main", name: "mo", capacity: CAPACITY_16 });
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(0);
          mo.emitIf(i.eq(0), { type: "noteOn", atSample: i, note: 60, velocity: 100, channel: 0 });
        });
      },
    };
  });

type LoopbackSession = {
  node: Awaited<ReturnType<typeof createNode>>;
  runQuantum: () => void;
  harness: LoopbackHarness;
};

/** Boot the real client against the real worklet namespace and return both ends. */
const bootLoopback = async (
  processor: CompiledProcessor<unknown>,
  opts: { crossOriginIsolated: boolean },
): Promise<LoopbackSession> => {
  const { wasm } = await compile(processor);
  const harness = installLoopback(wasm, opts);
  const patched = withWorkletUrls(processor);
  const nodePromise = createNode(harness.context as never, patched, undefined);
  // Wait until addModule + fetch + the REAL WebAssembly.compile settled, the
  // mock AudioWorkletNode is constructed, and the client attached its port
  // listener — only then can the worklet's `ready` reach the awaiting client.
  for (let spin = 0; spin < 200 && !harness.readyToInitialize(); spin++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  processor.worklet.initialize(harness.workletSelf as never, {
    processorOptions: harness.capturedProcessorOptions(),
  });
  const node = await nodePromise;
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  return {
    node,
    harness,
    runQuantum: () => {
      processor.worklet.process(harness.workletSelf as never, [], outputs, {});
    },
  };
};

/** Emits a 4-element Float32Array payload once per quantum (typed-array field). */
const makeWaveProcessor = () =>
  defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = state.buffer.f32({ size: 4 });
    const wave = event<{ data: Float32Array }>({ to: "main", name: "wave", capacity: CAPACITY_16 });
    return {
      process: () => {
        wave.emitIf(true, { data: buf, length: 4 });
        forSample((i) => {
          out.ch(0).at(i).write(0);
          buf.write(0, 0.5);
          buf.write(1, 0.25);
          buf.write(2, -1);
          buf.write(3, 42);
        });
      },
    };
  });

/** Echoes inbound sysex back out through a u8 buffer (offline/midi.test.ts shape). */
const makeSysexEchoProcessor = () =>
  defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const sysexIn = event.midi({ from: "main", name: "sin" });
    const sysexOut = event.midi({ to: "main", name: "sout" });
    const buf = state.buffer.u8({ size: 16 });
    return {
      process: () => {
        sysexIn.onEvent("sysex", ({ data, length, atSample }) => {
          buf.copyFrom(data);
          sysexOut.emitIf(true, { type: "sysex", data: buf, length, atSample });
        });
        forSample((i) => {
          out.ch(0).at(i).write(0);
        });
      },
    };
  });

const LIFETIME_QUANTA = 40; // 2.5× the ring capacity of 16

for (const transport of ["sab", "postMessage"] as const) {
  const coi = transport === "sab";

  test(`event ring (${transport}): a promptly-drained ring never reports overflow across ${LIFETIME_QUANTA} lifetime emits`, async () => {
    const processor = makeTickProcessor() as unknown as CompiledProcessor<unknown>;
    const session = await bootLoopback(processor, { crossOriginIsolated: coi });
    try {
      const received: unknown[] = [];
      const events = session.node.events as Record<
        string,
        {
          on: (h: (p: unknown) => void) => void;
          diagnostics: { overflowCount(): number };
        }
      >;
      events.tick!.on((p) => received.push(p));
      for (let q = 0; q < LIFETIME_QUANTA; q++) {
        session.runQuantum();
        session.harness.pumpRaf(); // main drains what this quantum emitted
      }
      session.harness.pumpRaf();
      expect(received.length).toBe(LIFETIME_QUANTA);
      expect(events.tick!.diagnostics.overflowCount()).toBe(0);
    } finally {
      session.node.dispose();
      session.harness.cleanup();
    }
  });

  test(`midi out ring (${transport}): a promptly-drained ring never reports overflow across ${LIFETIME_QUANTA} lifetime emits`, async () => {
    const processor = makeMidiTickProcessor() as unknown as CompiledProcessor<unknown>;
    const session = await bootLoopback(processor, { crossOriginIsolated: coi });
    try {
      const received: MidiEvent[] = [];
      const midi = session.node.midi as Record<
        string,
        {
          onEvent: (type: "noteOn", h: (e: MidiEvent) => void) => void;
          diagnostics: { overflowCount(): number };
        }
      >;
      midi.mo!.onEvent("noteOn", (e) => received.push(e));
      for (let q = 0; q < LIFETIME_QUANTA; q++) {
        session.runQuantum();
        session.harness.pumpRaf();
      }
      session.harness.pumpRaf();
      expect(received.length).toBe(LIFETIME_QUANTA);
      expect(midi.mo!.diagnostics.overflowCount()).toBe(0);
    } finally {
      session.node.dispose();
      session.harness.cleanup();
    }
  });

  test(`event ring (${transport}): a typed-array payload arrives as a fresh Float32Array with the emitted values`, async () => {
    const processor = makeWaveProcessor() as unknown as CompiledProcessor<unknown>;
    const session = await bootLoopback(processor, { crossOriginIsolated: coi });
    try {
      const received: Array<Record<string, unknown>> = [];
      const events = session.node.events as Record<
        string,
        { on: (h: (p: Record<string, unknown>) => void) => void }
      >;
      events.wave!.on((p) => received.push(p));
      // Two quanta: the per-block emit runs before forSample's buffer writes,
      // so the first frame carries zeros and the second carries the values.
      session.runQuantum();
      session.harness.pumpRaf();
      session.runQuantum();
      session.harness.pumpRaf();
      expect(received.length).toBe(2);
      const data = received[received.length - 1]!.data as Float32Array;
      expect(data).toBeInstanceOf(Float32Array);
      expect(Array.from(data)).toEqual([0.5, 0.25, -1, 42]);
    } finally {
      session.node.dispose();
      session.harness.cleanup();
    }
  });

  test(`midi sysex (${transport}): inbound sysex echoes back out byte-identical`, async () => {
    const processor = makeSysexEchoProcessor() as unknown as CompiledProcessor<unknown>;
    const session = await bootLoopback(processor, { crossOriginIsolated: coi });
    try {
      const received: MidiEvent[] = [];
      const midi = session.node.midi as Record<
        string,
        {
          send: (e: MidiEvent) => void;
          onEvent: (type: "sysex", h: (e: MidiEvent) => void) => void;
        }
      >;
      midi.sout!.onEvent("sysex", (e) => received.push(e));
      const sent = new Uint8Array([0xf0, 0x7e, 0x01, 0x02, 0x03, 0xf7]);
      midi.sin!.send({ type: "sysex", data: sent });
      session.runQuantum();
      session.harness.pumpRaf();
      expect(received.length).toBe(1);
      const echoed = (received[0] as Extract<MidiEvent, { type: "sysex" }>).data;
      expect(Array.from(echoed)).toEqual(Array.from(sent));
    } finally {
      session.node.dispose();
      session.harness.cleanup();
    }
  });
}
