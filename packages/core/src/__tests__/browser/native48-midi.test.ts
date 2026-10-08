import { commands } from "vite-plus/test/browser";
import { expect, test, vi } from "vite-plus/test";
import { createNode } from "../../index.ts";
import type { MidiEvent, NodeErrorEvent } from "../../types.ts";
import worklet from "./fixtures/native48-midi.processor.ts?worklet";
import {
  assertMidiObservation,
  decodeShortSlot,
  inputs,
  offsets,
  pcmBits,
  replies,
} from "./fixtures/native48-midi-observation.ts";

import { driveNative48Midi, freshProgress } from "./fixtures/native48-midi-driver.ts";

type Fault = {
  kind:
    | "boundary-first"
    | "boundary-third"
    | "ingress-overflow"
    | "egress-overflow"
    | "runtime-error"
    | "observer-error"
    | "pm-parser"
    | "pm-overflow"
    | "sab-overflow"
    | "sab-head"
    | "sab-tail";
  error: Error;
};

async function renderNativeMidi(fault?: Fault, progress = freshProgress()) {
  const slots: Uint8Array[] = [];
  const NativeNode = globalThis.AudioWorkletNode;
  let options: {
    midiRingsBuffer?: SharedArrayBuffer;
    egressAccessBuffer?: SharedArrayBuffer;
    midiRingSabOffsets: number[];
    midiRings: { name: string; capacity: number }[];
    eventRings?: unknown[];
  };
  const frames: Uint8Array[] = [];
  const observerErrors: unknown[] = [];
  let removeObserver = () => {};
  // Copy only, before the client recycles. Parsing/assertions run in the awaited
  // boundary driver. These main-thread copies are observation overhead.
  const copyEgress = (event: MessageEvent) => {
    try {
      if (event.data.kind !== "egress") return;
      if (fault?.kind === "observer-error") throw fault.error;
      frames.push(new Uint8Array(event.data.buffer).slice());
    } catch (error) {
      observerErrors.push(error);
    }
  };
  class ObservedNode extends NativeNode {
    constructor(context: BaseAudioContext, name: string, init?: AudioWorkletNodeOptions) {
      super(context, name, init);
      options = init!.processorOptions;
      this.port.addEventListener("message", copyEgress);
      removeObserver = () => this.port.removeEventListener("message", copyEgress);
    }
  }
  const parseFrames = () => {
    for (let copy of frames.splice(0)) {
      // Faults touch owned copies only, never the transferred original.
      if (fault?.kind === "pm-parser") copy = copy.slice(0, 8);
      const view = new DataView(copy.buffer);
      if (fault?.kind === "pm-overflow") view.setUint32(20, 1, true);
      expect(view.getUint32(0, true)).toBe(0);
      let cursor = 8;
      for (let i = 0; i < view.getUint32(4, true); i++) {
        expect(options.midiRings[view.getUint32(cursor, true)]!.name).toBe("replies");
        const count = view.getUint32(cursor + 8, true);
        expect(view.getUint32(cursor + 12, true), "PM egress overflow").toBe(0);
        expect(view.getUint32(cursor + 16, true)).toBe(0);
        cursor += 20;
        for (let j = 0; j < count; j++, cursor += 8) slots.push(copy.slice(cursor, cursor + 8));
      }
    }
  };
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 640, sampleRate: 48000 });
  vi.stubGlobal("AudioWorkletNode", ObservedNode);
  let node;
  try {
    node = await createNode(ctx, worklet);
  } catch (error) {
    removeObserver();
    throw error;
  } finally {
    vi.unstubAllGlobals();
  }
  const errors: NodeErrorEvent[] = [];
  const unsubscribeErrors = node.onError((error) => errors.push(error));
  const assertHealth = () => {
    expect(node.midi.commands!.diagnostics.overflowCount(), "MIDI ingress overflow").toBe(0);
    expect(node.midi.replies!.diagnostics.overflowCount(), "MIDI egress overflow").toBe(0);
    expect(errors, "MIDI runtime errors").toEqual(
      globalThis.crossOriginIsolated ? [] : [{ code: "sab-unavailable" }],
    );
  };
  const received: MidiEvent[] = [];
  const unsubscribers = (["noteOn", "noteOff", "cc"] as const).map((type) =>
    node.midi.replies!.onEvent(type, (event) => received.push(event)),
  );
  let observerCursor = 0;
  const observeSuspendedSab = () => {
    if (!options.midiRingsBuffer) return;
    const index = options.midiRings.findIndex((ring) => ring.name === "replies");
    const guard = new Int32Array(options.egressAccessBuffer!);
    const guardIndex = (options.eventRings?.length ?? 0) + index;
    // Single normal try-acquire. Never force ownership, drain, or acknowledge.
    expect(Atomics.compareExchange(guard, guardIndex, 0, 1)).toBe(0);
    try {
      const base = options.midiRingSabOffsets[index]!;
      const sharedHeader = new Int32Array(options.midiRingsBuffer, base, 3);
      const before = [Atomics.load(sharedHeader, 0), Atomics.load(sharedHeader, 1)];
      const header = sharedHeader.slice();
      if (fault?.kind === "sab-overflow") header[2] = 1;
      expect(header[2], "SAB egress overflow").toBe(0);
      const head = header[0]!;
      expect(head - observerCursor).toBeLessThanOrEqual(16);
      while (observerCursor < head) {
        slots.push(
          new Uint8Array(options.midiRingsBuffer, base + 12 + (observerCursor % 16) * 8, 8).slice(),
        );
        observerCursor++;
      }
      const after = [Atomics.load(sharedHeader, 0), Atomics.load(sharedHeader, 1)];
      // Inject into observer-owned values; never write shared head/tail.
      if (fault?.kind === "sab-head") after[0]! += 1;
      if (fault?.kind === "sab-tail") after[1]! += 1;
      expect(after, "SAB observer changed head/tail").toEqual(before);
    } finally {
      Atomics.store(guard, guardIndex, 0);
    }
  };
  let restoreDiagnostic = () => {};
  try {
    expect(node.diagnostics.transport).toBe(globalThis.crossOriginIsolated ? "sab" : "postMessage");
    node.outputs.main!.connect(ctx.destination);
    node.midi.commands!.send(inputs[0]!, offsets[0]! / 48000);
    // Same-port FIFO fence for PM. SAB enqueue flushes synchronously here,
    // with no rendering consumer; snapshot is not a general SAB staging flush.
    await node.snapshot();
    assertHealth();
    let snapshot: number[] = [];
    const rendered = await driveNative48Midi(
      ctx,
      async (block) => {
        expect(ctx.currentTime * 48000).toBe((block + 1) * 128);
        await expect.poll(() => received.length).toBe(block + 1);
        snapshot = Array.from(await node.snapshot());
        if (block === 0) {
          if (fault?.kind === "runtime-error") node.node.dispatchEvent(new Event("processorerror"));
          if (fault?.kind === "ingress-overflow" || fault?.kind === "egress-overflow") {
            const port =
              fault.kind === "ingress-overflow" ? node.midi.commands! : node.midi.replies!;
            const spy = vi.spyOn(port.diagnostics, "overflowCount").mockReturnValue(1);
            restoreDiagnostic = () => spy.mockRestore();
          }
        }
        assertHealth();
        if (observerErrors.length > 0) throw observerErrors[0];
        parseFrames();
        observeSuspendedSab();
        expect(slots).toHaveLength(block + 1);
        if (
          (fault?.kind === "boundary-first" && block === 0) ||
          (fault?.kind === "boundary-third" && block === 2)
        )
          throw fault.error;
        if (block < 3) {
          node.midi.commands!.send(
            inputs[block + 1]!,
            ctx.currentTime + offsets[block + 1]! / 48000,
          );
          await node.snapshot();
          assertHealth();
        }
      },
      progress,
    );
    // The tail quantum has no input. Fence its control messages before checking
    // health one last time; the comparison snapshot remains the fourth block.
    await node.snapshot();
    assertHealth();
    if (observerErrors.length > 0) throw observerErrors[0];
    parseFrames();
    const observed = {
      pcm: pcmBits(rendered.getChannelData(0).slice(0, 512)),
      packets: slots.map(decodeShortSlot),
      snapshot,
    };
    return { observed, received, slots };
  } finally {
    restoreDiagnostic();
    unsubscribeErrors();
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    removeObserver();
    node.dispose();
  }
}

test("native48 MIDI: complete PCM, packets, offsets and persistent bytes match offline", async () => {
  const oracle = await commands.renderNative48MidiOracle();
  assertMidiObservation(oracle);
  const { observed, received, slots } = await renderNativeMidi();
  expect(received).toEqual(replies);
  assertMidiObservation(observed);
  expect(observed).toEqual(oracle);
  // Mutate captured wire bytes before decoding: public callbacks omit offsets.
  for (const byte of [1, 4]) {
    const corrupted = slots.map((slot) => slot.slice());
    corrupted[2]![byte]! ^= 1;
    expect(() =>
      assertMidiObservation({ ...observed, packets: corrupted.map(decodeShortSlot) }),
    ).toThrow();
  }
});

for (const kind of [
  "boundary-first",
  "boundary-third",
  "ingress-overflow",
  "egress-overflow",
  "runtime-error",
] as const) {
  test(`native48 MIDI: ${kind} fails after all four suspensions are released`, async () => {
    const progress = freshProgress();
    const error = new Error(`injected ${kind}`);
    const running = renderNativeMidi({ kind, error }, progress);
    if (kind.startsWith("boundary")) await expect(running).rejects.toBe(error);
    else
      await expect(running).rejects.toThrow(
        kind === "runtime-error" ? /runtime errors/ : /overflow/,
      );
    expect(progress).toEqual({
      boundaries: [128, 256, 384, 512],
      resumed: [128, 256, 384, 512],
      cleanupFailures: [],
      settled: true,
      state: "closed",
    });
  });
}

for (const kind of [
  "observer-error",
  "pm-parser",
  "pm-overflow",
  "sab-overflow",
  "sab-head",
  "sab-tail",
] as const) {
  test.runIf(
    kind.startsWith("sab-") ? globalThis.crossOriginIsolated : !globalThis.crossOriginIsolated,
  )(`native48 MIDI: ${kind} is owned by the test and rendering settles`, async () => {
    const progress = freshProgress();
    const error = new Error(`injected ${kind}`);
    const running = renderNativeMidi({ kind, error }, progress);
    if (kind === "observer-error") await expect(running).rejects.toBe(error);
    else if (kind === "pm-parser") await expect(running).rejects.toBeInstanceOf(RangeError);
    else
      await expect(running).rejects.toThrow(
        kind === "sab-head" || kind === "sab-tail" ? /head\/tail/ : /overflow/,
      );
    expect(progress).toEqual({
      boundaries: [128, 256, 384, 512],
      resumed: [128, 256, 384, 512],
      cleanupFailures: [],
      settled: true,
      state: "closed",
    });
  });
}

for (const stage of ["resume", "render"] as const) {
  test(`native48 MIDI driver preserves the first failure when ${stage} also rejects`, async () => {
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 640, sampleRate: 48000 });
    const progress = freshProgress();
    const first = new Error("injected boundary failure");
    const later = new Error(`injected ${stage} failure`);
    // Complete the native operation before injecting its rejection, so the
    // test owns no abandoned rendering and does not change the browser clock.
    const resume = ctx.resume.bind(ctx);
    const render = ctx.startRendering.bind(ctx);
    const spy =
      stage === "resume"
        ? vi.spyOn(ctx, "resume").mockImplementation(async () => {
            await resume();
            throw later;
          })
        : vi.spyOn(ctx, "startRendering").mockImplementation(async () => {
            await render();
            throw later;
          });
    try {
      const outcome = await driveNative48Midi(
        ctx,
        async () => {
          throw first;
        },
        progress,
      ).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(AggregateError);
      expect((outcome as AggregateError).cause).toBe(first);
      expect((outcome as AggregateError).errors).toEqual([first, ...progress.cleanupFailures]);
      expect(progress.cleanupFailures).toEqual(Array(stage === "resume" ? 4 : 1).fill(later));
      expect(progress.boundaries).toEqual([128, 256, 384, 512]);
      expect(spy).toHaveBeenCalledTimes(stage === "resume" ? 4 : 1);
      expect(progress.settled).toBe(true);
      expect(progress.state).toBe("closed");
    } finally {
      spy.mockRestore();
    }
  });
}
