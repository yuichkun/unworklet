/**
 * Layer B — conformance binding for the SAB ring transport.
 *
 * The model in `ring-model.ts` proves a *protocol shape* safe or unsafe. That
 * proof is only worth something if the shape it reasons about is the shape the
 * REAL `worklet.ts` emits — otherwise the model could drift into a false green.
 *
 * This test closes that gap: it drives one real compiled-WASM quantum in SAB
 * mode, captures the actual op-order the worklet performs on the shared ring
 * (every `Atomics.store` to the header, and whether the bulk `.set()` copy
 * touches the 12-byte header), abstracts it to the same vocabulary the model
 * uses, and deep-equals it to the canonical safe sequence. If the worklet ever
 * regresses to a header-touching copy or reorders the release stores, this fails
 * — and the model's safety proof becomes binding on the real code.
 */

import "./../dsl/primitives.ts"; // method form registration side-effect

import { expect, test, vi } from "vite-plus/test";

import { compile } from "./../compile/index.ts";
import { audioOutput, event } from "./../dsl/declarations.ts";
import { midiEventToWire } from "./../midiWire.ts";
import { defineProcessor } from "./../processor.ts";
import { type AbstractRingOp, OUT_RING_PUBLISH_OPS } from "./ring-model.ts";

// ── mock audio-thread `self` ────────────────────────────────────────────────

type PortListener = (event: MessageEvent) => void;
interface MockSelf {
  port: {
    postMessage: (m: unknown) => void;
    addEventListener: (kind: string, fn: PortListener) => void;
    start: () => void;
    __listeners: PortListener[];
  };
  messages: unknown[];
}

const makeMockSelf = (): MockSelf => {
  const messages: unknown[] = [];
  const listeners: PortListener[] = [];
  return {
    port: {
      postMessage: (m: unknown) => messages.push(m),
      addEventListener: (kind: string, fn: PortListener) => {
        if (kind === "message") listeners.push(fn);
      },
      start: () => {},
      __listeners: listeners,
    },
    messages,
  };
};

const emptyQuantum = () => ({
  inputs: [] as Float32Array[][],
  outputs: [[new Float32Array(128)]] as Float32Array[][],
  parameters: {} as Record<string, Float32Array>,
});

/**
 * Run `run()` while recording, in execution order, the worklet's writes to one
 * out-ring's SAB region: each header `Atomics.store` and the bulk `.set()` copy
 * (tagged with whether its destination overlaps the 12-byte header).
 */
const capturePublish = (
  sab: ArrayBuffer,
  ringSabOffset: number,
  ringTotalBytes: number,
  run: () => void,
): AbstractRingOp[] => {
  const captured: AbstractRingOp[] = [];

  const realStore = Atomics.store.bind(Atomics);
  const storeSpy = vi.spyOn(Atomics, "store").mockImplementation(((
    ta: Int32Array,
    index: number,
    value: number,
  ): number => {
    if (ta.buffer === sab && ta.byteOffset === ringSabOffset && ta.length === 3) {
      captured.push({
        op: "atomic-store",
        word: index === 0 ? "head" : index === 1 ? "tail" : "overflow",
      });
    }
    return realStore(ta, index, value);
  }) as typeof Atomics.store);

  const realSet = Uint8Array.prototype.set;
  // eslint-disable-next-line no-extend-native -- restored in finally
  Uint8Array.prototype.set = function (this: Uint8Array, src: ArrayLike<number>, offset?: number) {
    if (
      this.buffer === sab &&
      this.byteOffset >= ringSabOffset &&
      this.byteOffset < ringSabOffset + ringTotalBytes
    ) {
      captured.push({ op: "bulk-copy", touchesHeader: this.byteOffset === ringSabOffset });
    }
    return offset === undefined ? realSet.call(this, src) : realSet.call(this, src, offset);
  };

  try {
    run();
  } finally {
    storeSpy.mockRestore();
    Uint8Array.prototype.set = realSet;
  }
  return captured;
};

// ── event out-ring (worklet.ts event publish) ───────────────────────────────

test("conformance: the event out-ring publish matches the model's safe op-order", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    const peak = event<{ level: number }>({ to: "main", name: "peak", capacity: 16 });
    return {
      process: () => {
        peak.emitIf(true, { atSample: 0, level: 0.5 });
        out.ch(0).at(0).write(0);
      },
    };
  });
  const { wasm } = await compile(proc);
  const eventRings = proc.worklet.eventRings;
  let total = 0;
  const offsets: number[] = [];
  for (const r of eventRings) {
    offsets.push(total);
    total += 12 + r.capacity * r.slotSize;
  }
  const sab = new ArrayBuffer(total);
  const self = makeMockSelf();
  proc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      transport: "sab",
      eventRings,
      eventRingsBuffer: sab,
      eventRingSabOffsets: offsets,
    },
  });

  const ringSabOffset = offsets[0]!;
  const ringTotalBytes = 12 + eventRings[0]!.capacity * eventRings[0]!.slotSize;
  const q = emptyQuantum();
  const captured = capturePublish(sab, ringSabOffset, ringTotalBytes, () => {
    proc.worklet.process(self, q.inputs, q.outputs, q.parameters);
  });

  expect(captured).toEqual(OUT_RING_PUBLISH_OPS);
});

// ── MIDI out-ring (worklet.ts MIDI publish) ─────────────────────────────────

test("conformance: the MIDI out-ring publish matches the model's safe op-order", async () => {
  const thru = defineProcessor(() => {
    const midiIn = event.midi({ from: "main", name: "in" });
    const midiOut = event.midi({ to: "main", name: "out" });
    return {
      process: () => {
        midiIn.onEvent("noteOn", ({ channel, note, velocity, atSample }) => {
          midiOut.emitIf(true, { type: "noteOn", channel, note, velocity, atSample });
        });
      },
    };
  });
  const { wasm } = await compile(thru);
  const midiRings = thru.worklet.midiRings;
  let total = 0;
  const offsets: number[] = [];
  for (const r of midiRings) {
    offsets.push(total);
    total += 12 + r.capacity * 8;
  }
  const sab = new ArrayBuffer(total);
  const self = makeMockSelf();
  thru.worklet.initialize(self, {
    processorOptions: {
      wasm,
      transport: "sab",
      midiRings,
      midiRingsBuffer: sab,
      midiRingSabOffsets: offsets,
      sysexContentSabOffsets: midiRings.map(() => 0),
    },
  });

  const inIndex = midiRings.findIndex((r) => r.direction === "in");
  const outIndex = midiRings.findIndex((r) => r.direction === "out");
  // Inject one inbound noteOn so the thru re-emits on the out ring (producer path).
  const inOffset = offsets[inIndex]!;
  const inHeader = new Int32Array(sab, inOffset, 3);
  const dv = new DataView(sab);
  const wire = midiEventToWire({ type: "noteOn", channel: 0, note: 60, velocity: 100 });
  dv.setUint8(inOffset + 12, wire.status);
  dv.setUint8(inOffset + 13, wire.data1);
  dv.setUint8(inOffset + 14, wire.data2);
  dv.setUint32(inOffset + 16, 0, true);
  Atomics.store(inHeader, 0, 1);

  const outOffset = offsets[outIndex]!;
  const ringTotalBytes = 12 + midiRings[outIndex]!.capacity * 8;
  const q = emptyQuantum();
  const captured = capturePublish(sab, outOffset, ringTotalBytes, () => {
    thru.worklet.process(self, q.inputs, q.outputs, q.parameters);
  });

  expect(captured).toEqual(OUT_RING_PUBLISH_OPS);
});
