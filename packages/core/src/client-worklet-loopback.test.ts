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

import { expect, test, vi } from "vite-plus/test";

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
  repeatLastRaf: () => void;
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
  let lastRaf: (() => void) | undefined;
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
      for (const cb of batch) {
        lastRaf = cb;
        cb();
      }
    },
    repeatLastRaf: () => lastRaf?.(),
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
const makeSysexEchoProcessor = (capacity: 16 | 512 = CAPACITY_16) =>
  defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const sysexIn = event.midi({ from: "main", name: "sin", capacity });
    const sysexOut = event.midi({ to: "main", name: "sout", capacity });
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
      const events = session.node.events as unknown as Record<
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
      const events = session.node.events as unknown as Record<
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

const makeSequenceProcessor = () =>
  defineProcessor(() => {
    const n = state.f32(0);
    const data = state.buffer.f32({ size: 4 });
    const tick = event<{ n: number; data: Float32Array }>({
      to: "main",
      name: "tick",
      capacity: CAPACITY_16,
    });
    return {
      process: () => {
        data.write(0, n.read());
        data.write(1, n.read().add(100));
        data.write(2, n.read().add(200));
        data.write(3, n.read().add(300));
        tick.emitIf(true, { n: n.read(), data, length: 4 });
        n.write(n.read().add(1));
      },
    };
  });

type SequenceEvent = { n: number; data: Float32Array };
const sequenceSurface = (session: LoopbackSession) =>
  (
    session.node.events as unknown as Record<
      string,
      {
        on(handler: (value: SequenceEvent) => void): () => void;
        diagnostics: { overflowCount(): number };
      }
    >
  ).tick!;

for (const boundary of ["slots", "content"] as const) {
  test(`SAB snapshot: drain during ${boundary} publication never delivers an overwritten slot`, async () => {
    const session = await bootLoopback(makeSequenceProcessor(), { crossOriginIsolated: true });
    const received: SequenceEvent[] = [];
    const surface = sequenceSurface(session);
    surface.on((value) => received.push(value));
    const options = session.harness.capturedProcessorOptions();
    const target = options[boundary === "slots" ? "eventRingsBuffer" : "eventContentBuffer"];
    // oxlint-disable-next-line typescript/unbound-method -- restored in finally and invoked with an explicit receiver
    const realSet = Uint8Array.prototype.set;
    let interrupted = false;
    try {
      for (let q = 0; q < 16; q++) session.runQuantum();
      Uint8Array.prototype.set = function (source, offset) {
        if (this.buffer !== target || interrupted) return realSet.call(this, source, offset);
        interrupted = true;
        const bytes = source as Uint8Array;
        const midpoint = Math.floor(bytes.length / 2);
        realSet.call(this, bytes.subarray(0, midpoint), offset);
        session.harness.pumpRaf();
        return realSet.call(this, bytes.subarray(midpoint), (offset ?? 0) + midpoint);
      };
      session.runQuantum();
      Uint8Array.prototype.set = realSet;
      session.harness.pumpRaf();
      expect(interrupted).toBe(true);
      expect(received.map((value) => value.n)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
      for (const value of received) {
        expect(Array.from(value.data)).toEqual([
          value.n,
          value.n + 100,
          value.n + 200,
          value.n + 300,
        ]);
      }
      expect(surface.diagnostics.overflowCount()).toBe(1);
    } finally {
      Uint8Array.prototype.set = realSet;
      session.node.dispose();
      session.harness.cleanup();
    }
  });
}

test("SAB snapshot: callbacks can advance the producer and reenter draining without rewriting the captured batch", async () => {
  const session = await bootLoopback(makeSequenceProcessor(), { crossOriginIsolated: true });
  const received: SequenceEvent[] = [];
  const surface = sequenceSurface(session);
  let interrupted = false;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  surface.on((value) => {
    received.push(value);
    if (!interrupted) {
      interrupted = true;
      for (let q = 0; q < 16; q++) session.runQuantum();
      session.harness.repeatLastRaf();
      throw new Error("subscriber failed");
    }
  });
  try {
    for (let q = 0; q < 4; q++) session.runQuantum();
    session.harness.pumpRaf();
    session.harness.pumpRaf();
    expect(received.map((value) => value.n)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(Array.from(received[0]!.data)).toEqual([0, 100, 200, 300]);
    expect(Array.from(received[3]!.data)).toEqual([3, 103, 203, 303]);
    expect(surface.diagnostics.overflowCount()).toBe(0);
    expect(error).toHaveBeenCalledOnce();
  } finally {
    error.mockRestore();
    session.node.dispose();
    session.harness.cleanup();
  }
});

for (const boundary of ["slots", "sysex"] as const) {
  test(`SAB snapshot: MIDI drain during ${boundary} publication keeps complete sysex messages`, async () => {
    const processor = makeSysexEchoProcessor();
    const session = await bootLoopback(processor, { crossOriginIsolated: true });
    const received: number[][] = [];
    const midi = session.node.midi as Record<
      string,
      {
        send(event: MidiEvent): void;
        onEvent(
          type: "sysex",
          handler: (event: Extract<MidiEvent, { type: "sysex" }>) => void,
        ): () => void;
        diagnostics: { overflowCount(): number };
      }
    >;
    midi.sout!.onEvent("sysex", (event) => received.push(Array.from(event.data)));
    const options = session.harness.capturedProcessorOptions();
    const target = options[boundary === "slots" ? "midiRingsBuffer" : "sysexContentBuffer"];
    // oxlint-disable-next-line typescript/unbound-method -- restored in finally and invoked with an explicit receiver
    const realSet = Uint8Array.prototype.set;
    let interrupted = false;
    const bytes = (n: number) => [0xf0, 0x7e, n, n + 1, n + 2, 0xf7];
    try {
      for (let n = 0; n < 16; n++)
        midi.sin!.send({ type: "sysex", data: Uint8Array.from(bytes(n)) });
      session.runQuantum();
      midi.sin!.send({ type: "sysex", data: Uint8Array.from(bytes(16)) });
      Uint8Array.prototype.set = function (source, offset) {
        if (this.buffer !== target || interrupted) return realSet.call(this, source, offset);
        interrupted = true;
        const bytes = source as Uint8Array;
        const midpoint = Math.floor(bytes.length / 2);
        realSet.call(this, bytes.subarray(0, midpoint), offset);
        session.harness.pumpRaf();
        return realSet.call(this, bytes.subarray(midpoint), (offset ?? 0) + midpoint);
      };
      session.runQuantum();
      Uint8Array.prototype.set = realSet;
      session.harness.pumpRaf();
      expect(interrupted).toBe(true);
      expect(received).toEqual(Array.from({ length: 16 }, (_, i) => bytes(i + 1)));
      expect(midi.sout!.diagnostics.overflowCount()).toBe(1);
    } finally {
      Uint8Array.prototype.set = realSet;
      session.node.dispose();
      session.harness.cleanup();
    }
  });
}

for (const quanta of [3, 20]) {
  test(`SAB snapshot: a busy reader delays ${quanta} publications and recovers with bounded overflow`, async () => {
    const session = await bootLoopback(makeSequenceProcessor(), { crossOriginIsolated: true });
    const options = session.harness.capturedProcessorOptions();
    const access = new Int32Array(options.egressAccessBuffer as SharedArrayBuffer);
    const received: number[] = [];
    const surface = sequenceSurface(session);
    surface.on((value) => received.push(value.n));
    const attempts = vi.spyOn(Atomics, "compareExchange");
    try {
      Atomics.store(access, 0, 1);
      for (let q = 0; q < quanta; q++) session.runQuantum();
      const attemptsAtRing = attempts.mock.calls.filter(([view]) => view.buffer === access.buffer);
      expect(attemptsAtRing).toHaveLength(quanta);
      expect(new Int32Array(options.eventRingsBuffer as SharedArrayBuffer)[0]).toBe(0);
      Atomics.store(access, 0, 0);
      session.runQuantum();
      session.harness.pumpRaf();
      const total = quanta + 1;
      const dropped = Math.max(0, total - 16);
      expect(received).toEqual(Array.from({ length: Math.min(total, 16) }, (_, i) => i + dropped));
      expect(surface.diagnostics.overflowCount()).toBe(dropped);
    } finally {
      attempts.mockRestore();
      session.node.dispose();
      session.harness.cleanup();
    }
  });
}

for (const crossOriginIsolated of [false, true]) {
  test(`uploaded state publishes typed content and scalar fields across content reuse (SAB=${crossOriginIsolated})`, async () => {
    const processor = defineProcessor(() => {
      const upload = event<{ samples: Float32Array; enabled: boolean; gain: number }>({
        from: "main",
        name: "upload",
        payloadCapacity: 16,
      });
      const result = event<{ data: Float32Array; enabled: boolean; gain: number }>({
        to: "main",
        name: "result",
        payloadCapacity: 16,
      });
      const buf = state.buffer.f32({ size: 3 });
      const changed = state.bool(false);
      const enabledState = state.bool(false);
      const gainState = state.f32(0);
      return {
        process: () => {
          upload.onReceive(({ samples, enabled, gain }) => {
            buf.copyFrom(samples);
            enabledState.write(enabled);
            gainState.write(gain);
            changed.write(true);
          });
          result.emitIf(changed.read(), {
            data: buf,
            length: 3,
            enabled: enabledState.read(),
            gain: gainState.read(),
          });
          changed.write(false);
        },
      };
    });
    const session = await bootLoopback(processor, { crossOriginIsolated });
    const received: unknown[] = [];
    const events = session.node.events as Record<
      string,
      {
        emit(value: unknown): void;
        on(handler: (value: unknown) => void): () => void;
      }
    >;
    events.result!.on((value) => received.push(value));
    try {
      for (let n = 0; n < 25; n++) {
        const samples = Float32Array.from([n, n + 1, n + 2]);
        events.upload!.emit({ samples, enabled: n % 2 === 0, gain: 0.5 });
        session.runQuantum();
        session.harness.pumpRaf();
        expect(received[n]).toEqual({
          atSample: 0,
          data: samples,
          enabled: n % 2 === 0,
          gain: 0.5,
        });
      }
      session.runQuantum();
      session.harness.pumpRaf();
      expect(received).toHaveLength(25);
    } finally {
      session.node.dispose();
      session.harness.cleanup();
    }
  });
}

test("SAB snapshot: dispose inside a subscriber releases the guard and stops the captured batch", async () => {
  const session = await bootLoopback(makeSequenceProcessor(), { crossOriginIsolated: true });
  const options = session.harness.capturedProcessorOptions();
  const received: number[] = [];
  sequenceSurface(session).on((value) => {
    received.push(value.n);
    session.node.dispose();
  });
  try {
    for (let q = 0; q < 3; q++) session.runQuantum();
    session.harness.pumpRaf();
    expect(received).toEqual([0]);
    expect(new Int32Array(options.egressAccessBuffer as SharedArrayBuffer)[0]).toBe(0);
    expect(new Int32Array(options.eventRingsBuffer as SharedArrayBuffer)[1]).toBe(3);
  } finally {
    session.node.dispose();
    session.harness.cleanup();
  }
});

test("SAB snapshot: audio advances during a main-thread copy and publishes the backlog on release", async () => {
  const session = await bootLoopback(makeSequenceProcessor(), { crossOriginIsolated: true });
  const shared = session.harness.capturedProcessorOptions().eventRingsBuffer;
  const received: number[] = [];
  const surface = sequenceSurface(session);
  surface.on((value) => received.push(value.n));
  // oxlint-disable-next-line typescript/unbound-method -- restored in finally and invoked with an explicit receiver
  const realSet = Uint8Array.prototype.set;
  let interrupted = false;
  try {
    session.runQuantum();
    Uint8Array.prototype.set = function (source, offset) {
      const bytes = source as Uint8Array;
      if (bytes.buffer !== shared || interrupted) return realSet.call(this, source, offset);
      interrupted = true;
      const midpoint = Math.floor(bytes.length / 2);
      realSet.call(this, bytes.subarray(0, midpoint), offset);
      session.runQuantum();
      expect(new Int32Array(shared as SharedArrayBuffer)[0]).toBe(1);
      return realSet.call(this, bytes.subarray(midpoint), (offset ?? 0) + midpoint);
    };
    session.harness.pumpRaf();
    Uint8Array.prototype.set = realSet;
    session.runQuantum();
    session.harness.pumpRaf();
    expect(interrupted).toBe(true);
    expect(received).toEqual([0, 1, 2]);
    expect(surface.diagnostics.overflowCount()).toBe(0);
  } finally {
    Uint8Array.prototype.set = realSet;
    session.node.dispose();
    session.harness.cleanup();
  }
});

for (const quanta of [3, 20]) {
  test(`SAB snapshot: MIDI input keeps draining while its output defers ${quanta} publications`, async () => {
    const processor = makeSysexEchoProcessor();
    const session = await bootLoopback(processor, { crossOriginIsolated: true });
    const midi = session.node.midi as Record<
      string,
      {
        send(event: MidiEvent): void;
        onEvent(
          type: "sysex",
          handler: (event: Extract<MidiEvent, { type: "sysex" }>) => void,
        ): () => void;
        diagnostics: { overflowCount(): number };
      }
    >;
    const options = session.harness.capturedProcessorOptions();
    const access = new Int32Array(options.egressAccessBuffer as SharedArrayBuffer);
    const outIndex = processor.worklet.midiRings.findIndex((ring) => ring.direction === "out");
    const accessIndex = processor.worklet.eventRings.length + outIndex;
    const received: number[] = [];
    midi.sout!.onEvent("sysex", (event) => received.push(event.data[2]!));
    const compare = vi.spyOn(Atomics, "compareExchange");
    try {
      access[accessIndex] = 1;
      for (let n = 0; n < quanta; n++) {
        midi.sin!.send({ type: "sysex", data: Uint8Array.from([0xf0, 0x7e, n, 0xf7]) });
        session.runQuantum();
      }
      expect(compare.mock.calls.filter(([view]) => view.buffer === access.buffer)).toHaveLength(
        quanta,
      );
      expect(midi.sin!.diagnostics.overflowCount()).toBe(0);
      access[accessIndex] = 0;
      session.runQuantum();
      session.harness.pumpRaf();
      const dropped = Math.max(0, quanta - 16);
      expect(received).toEqual(Array.from({ length: Math.min(16, quanta) }, (_, i) => i + dropped));
      expect(midi.sout!.diagnostics.overflowCount()).toBe(dropped);
    } finally {
      compare.mockRestore();
      session.node.dispose();
      session.harness.cleanup();
    }
  });
}

test("SAB ingress snapshots input while a producer sends across the copy", async () => {
  const processor = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    const incoming = event<{ n: number }>({
      from: "main",
      name: "incoming",
      capacity: CAPACITY_16,
    });
    const sum = state.f32(0);
    return {
      process: () => {
        incoming.onReceive(({ n }) => sum.write(sum.read().add(n)));
        forSample((i) => out.ch(0).at(i).write(sum.read()));
      },
    };
  });
  const session = await bootLoopback(processor, { crossOriginIsolated: true });
  const incoming = session.node.events.incoming!;
  const shared = session.harness.capturedProcessorOptions().messageRingsBuffer;
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  // oxlint-disable-next-line typescript/unbound-method -- restored in finally
  const realSet = Uint8Array.prototype.set;
  let injected = false;
  try {
    for (let n = 0; n < 16; n++) incoming.emit({ n });
    Uint8Array.prototype.set = function (source, offset) {
      if ((source as Uint8Array).buffer === shared && !injected) {
        injected = true;
        incoming.emit({ n: 16 });
      }
      return realSet.call(this, source, offset);
    };
    processor.worklet.process(session.harness.workletSelf as never, [], outputs, {});
    Uint8Array.prototype.set = realSet;
    expect(injected).toBe(true);
    expect(outputs[0]![0]![0]).toBe(120);
    await new Promise((resolve) => setTimeout(resolve, 25));
    processor.worklet.process(session.harness.workletSelf as never, [], outputs, {});
    expect(outputs[0]![0]![0]).toBe(136);
    expect(incoming.diagnostics.overflowCount()).toBe(0);
  } finally {
    Uint8Array.prototype.set = realSet;
    session.node.dispose();
    session.harness.cleanup();
  }
});

for (const crossOriginIsolated of [true, false]) {
  test(`typed ingress batches retain differently sized payloads (SAB=${crossOriginIsolated})`, async () => {
    const processor = defineProcessor(() => {
      const incoming = event<{ samples: Float32Array }>({
        from: "main",
        name: "incoming",
        capacity: CAPACITY_16,
        payloadCapacity: 16,
      });
      const result = event<{ first: number; length: number }>({
        to: "main",
        name: "result",
        capacity: CAPACITY_16,
      });
      return {
        process: () =>
          incoming.onReceive(({ samples }) => {
            result.emitIf(true, { first: samples.at(0), length: samples.length });
          }),
      };
    });
    const session = await bootLoopback(processor, { crossOriginIsolated });
    const received: Array<{ first: number; length: number }> = [];
    session.node.events.result!.on((value) =>
      received.push(value as { first: number; length: number; atSample: number }),
    );
    try {
      for (let batch = 0; batch < 3; batch++) {
        for (let i = 0; i < 20; i++) {
          session.node.events.incoming!.emit({
            samples: new Float32Array(1 + (i % 4)).fill(batch * 20 + i),
          });
        }
        session.runQuantum();
        session.harness.pumpRaf();
      }
      expect(received.map(({ first, length }) => [first, length])).toEqual(
        Array.from({ length: 3 }, (_, batch) =>
          Array.from({ length: 16 }, (_, i) => [batch * 20 + 4 + i, 1 + (i % 4)]),
        ).flat(),
      );
      expect(session.node.events.incoming!.diagnostics.overflowCount()).toBe(12);
    } finally {
      session.node.dispose();
      session.harness.cleanup();
    }
  });
}

test("SAB ingress retries without subscribers, snapshots caller bytes and cancels on dispose", async () => {
  const processor = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    const incoming = event<{ samples: Float32Array }>({
      from: "main",
      name: "incoming",
      capacity: CAPACITY_16,
      payloadCapacity: 16,
    });
    const sum = state.f32(0);
    return {
      process: () => {
        incoming.onReceive(({ samples }) => sum.write(sum.read().add(samples.at(0))));
        forSample((i) => out.ch(0).at(i).write(sum.read()));
      },
    };
  });
  const session = await bootLoopback(processor, { crossOriginIsolated: true });
  const options = session.harness.capturedProcessorOptions();
  const access = new Int32Array(options.ingressAccessBuffer as SharedArrayBuffer);
  const shared = new Int32Array(options.messageRingsBuffer as SharedArrayBuffer, 0, 3);
  const outputs = [[new Float32Array(SAMPLES_PER_BLOCK)]];
  vi.useFakeTimers();
  try {
    access[0] = 1;
    const samples = Float32Array.of(10);
    session.node.events.incoming!.emit({ samples });
    samples[0] = 99;
    session.node.events.incoming!.emit({ samples: Float32Array.of(20) });
    expect(vi.getTimerCount()).toBe(1);
    access[0] = 0;
    await vi.advanceTimersByTimeAsync(4);
    processor.worklet.process(session.harness.workletSelf as never, [], outputs, {});
    expect(outputs[0]![0]![0]).toBe(30);
    expect(vi.getTimerCount()).toBe(0);
    access[0] = 1;
    session.node.events.incoming!.emit({ samples });
    expect(vi.getTimerCount()).toBe(1);
    session.node.dispose();
    expect(vi.getTimerCount()).toBe(0);
    access[0] = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(shared[0]).toBe(2);
  } finally {
    vi.useRealTimers();
    session.node.dispose();
    session.harness.cleanup();
  }
});

for (const crossOriginIsolated of [true, false]) {
  test(`sysex ingress retains and rebases more than 256 payloads (SAB=${crossOriginIsolated})`, async () => {
    const session = await bootLoopback(makeSysexEchoProcessor(512), { crossOriginIsolated });
    const received: number[] = [];
    session.node.midi.sout!.onEvent("sysex", (value) =>
      received.push(value.data[2]! + 128 * value.data[3]!),
    );
    try {
      for (let n = 0; n < 600; n++) {
        session.node.midi.sin!.send({
          type: "sysex",
          data: Uint8Array.from([0xf0, 0x7e, n % 128, Math.floor(n / 128), 0xf7]),
        });
      }
      session.runQuantum();
      session.harness.pumpRaf();
      expect(received).toEqual(Array.from({ length: 512 }, (_, i) => i + 88));
      expect(session.node.midi.sin!.diagnostics.overflowCount()).toBe(88);
      expect(session.node.midi.sout!.diagnostics.overflowCount()).toBe(0);
    } finally {
      session.node.dispose();
      session.harness.cleanup();
    }
  });
}

test("SAB sysex sends during copying are queued as immutable complete messages", async () => {
  const session = await bootLoopback(makeSysexEchoProcessor(), { crossOriginIsolated: true });
  const options = session.harness.capturedProcessorOptions();
  const received: number[] = [];
  session.node.midi.sout!.onEvent("sysex", (value) => received.push(value.data[2]!));
  // oxlint-disable-next-line typescript/unbound-method -- restored in finally
  const realSet = Uint8Array.prototype.set;
  let injected = false;
  try {
    for (let n = 0; n < 16; n++)
      session.node.midi.sin!.send({ type: "sysex", data: Uint8Array.from([0xf0, 0x7e, n, 0xf7]) });
    Uint8Array.prototype.set = function (source, offset) {
      if ((source as Uint8Array).buffer === options.sysexContentBuffer && !injected) {
        injected = true;
        const data = Uint8Array.from([0xf0, 0x7e, 16, 0xf7]);
        session.node.midi.sin!.send({ type: "sysex", data });
        data[2] = 99;
      }
      return realSet.call(this, source, offset);
    };
    session.runQuantum();
    Uint8Array.prototype.set = realSet;
    session.harness.pumpRaf();
    expect(injected).toBe(true);
    expect(received).toEqual(Array.from({ length: 16 }, (_, i) => i));
    await new Promise((resolve) => setTimeout(resolve, 25));
    session.runQuantum();
    session.harness.pumpRaf();
    expect(received).toEqual(Array.from({ length: 17 }, (_, i) => i));
    expect(session.node.midi.sin!.diagnostics.overflowCount()).toBe(0);
  } finally {
    Uint8Array.prototype.set = realSet;
    session.node.dispose();
    session.harness.cleanup();
  }
});
