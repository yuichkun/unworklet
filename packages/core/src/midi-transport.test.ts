/**
 * Worklet-side MIDI transport (`11-midi.md` §4.4) round-trip behavior against a
 * REAL compiled WASM module. The strong oracle here is **round-trip identity**:
 * a MIDI event injected on the inbound ring must reappear, unchanged, on the
 * outbound ring after a pure MIDI-thru processor re-emits it. If the worklet's
 * inbound inject, the WASM handler drain, or the outbound drain corrupts or
 * drops anything, the decoded event diverges from what was sent.
 *
 * Inbound bytes are encoded with the production `midiEventToWire` codec and
 * outbound bytes decoded with `wireToMidiEvent` — the same independently-tested
 * functions the client surface uses — so the test never reimplements the wire
 * format. Both transports are covered: `postMessage` (mock port loopback) and
 * `sab` (a plain `ArrayBuffer` shared between the simulated main + worklet,
 * exercising the same `Atomics` header + bulk-copy logic the browser runs).
 */

import "./dsl/primitives.ts"; // method form registration side-effect

import { expect, test, vi } from "vite-plus/test";

import { compile } from "./compile/index.ts";
import { CAPACITY_16 } from "./dsl/constants.ts";
import { event } from "./dsl/declarations.ts";
import { egressPoolBufferBytes } from "./egressFrame.ts";
import { SAMPLES_PER_BLOCK } from "./dsl/constants.ts";
import { midiEventToWire, wireToMidiEvent } from "./midiWire.ts";
import { defineProcessor } from "./processor.ts";
import type { MidiEvent, MidiRingSlotDescriptor } from "./types.ts";

// ── mock self (audio-thread stand-in) ──────────────────────────────────────

type PortListener = (event: MessageEvent) => void;
type MockSelf = {
  port: {
    postMessage: (m: unknown) => void;
    addEventListener: (kind: string, fn: PortListener) => void;
    start: () => void;
    __listeners: PortListener[];
  };
  messages: unknown[];
};

const makeMockSelf = (): MockSelf => {
  const messages: unknown[] = [];
  const listeners: PortListener[] = [];
  const self: MockSelf = {
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
  return self;
};

const fireToWorklet = (self: MockSelf, data: unknown): void => {
  for (const listener of self.port.__listeners) listener({ data } as MessageEvent);
};

const emptyQuantum = (): {
  inputs: Float32Array[][];
  outputs: Float32Array[][];
  parameters: Record<string, Float32Array>;
} => ({
  inputs: [],
  outputs: [[new Float32Array(SAMPLES_PER_BLOCK)]],
  parameters: {},
});

// MIDI-only thru: each inbound event of these types is re-emitted unchanged on
// the out port. `emitIf(true, ...)` inside a handler is the canonical 1:1
// projection form (`11-midi.md` §2.4). No audio I/O is declared, but the host
// still hands an output buffer, so the namespace tolerates an unused output.
const makeThru = () =>
  defineProcessor(() => {
    const midiIn = event.midi({ from: "main", name: "in" });
    const midiOut = event.midi({ to: "main", name: "out" });
    return {
      process: () => {
        midiIn.onEvent("noteOn", ({ channel, note, velocity, atSample }) => {
          midiOut.emitIf(true, { type: "noteOn", channel, note, velocity, atSample });
        });
        midiIn.onEvent("cc", ({ channel, controller, value, atSample }) => {
          midiOut.emitIf(true, { type: "cc", channel, controller, value, atSample });
        });
        midiIn.onEvent("pitchBend", ({ channel, value, atSample }) => {
          midiOut.emitIf(true, { type: "pitchBend", channel, value, atSample });
        });
      },
    };
  });

// Compute per-ring SAB byte offsets the same way the client does (12-byte header
// + capacity × 8-byte slots, concatenated in declaration order).
const ringOffsets = (rings: readonly MidiRingSlotDescriptor[]): number[] => {
  const offsets: number[] = [];
  let total = 0;
  for (const ring of rings) {
    offsets.push(total);
    total += 12 + ring.capacity * 8;
  }
  return offsets;
};
const ringsTotalBytes = (rings: readonly MidiRingSlotDescriptor[]): number =>
  rings.reduce((acc, r) => acc + 12 + r.capacity * 8, 0);

// Seed the worklet's postMessage egress pool (the frame buffers main would
// pre-allocate and transfer; see `egressFrame.ts`).
const seedEgressPool = (self: MockSelf, midiRings: readonly MidiRingSlotDescriptor[]): void => {
  fireToWorklet(self, {
    kind: "egress-buffer",
    buffer: new ArrayBuffer(egressPoolBufferBytes([], midiRings)),
  });
};

// Collect the `{ kind: 'egress' }` frames the worklet posted and decode the
// requested MIDI section's 8-byte slots back into `MidiEvent` (+ raw atSample)
// via the production codec. These fixtures declare no event rings, so the
// event-section half of the frame is asserted empty rather than parsed.
const drainPostedMidiOut = (
  self: MockSelf,
  ringIndex: number,
): Array<{ event: MidiEvent; atSample: number }> => {
  const out: Array<{ event: MidiEvent; atSample: number }> = [];
  for (const msg of self.messages) {
    const m = msg as { kind?: string; buffer?: ArrayBuffer };
    if (m.kind !== "egress" || !(m.buffer instanceof ArrayBuffer)) continue;
    const view = new DataView(m.buffer);
    expect(view.getUint32(0, true)).toBe(0); // no event sections in these fixtures
    const midiSections = view.getUint32(4, true);
    let cursor = 8;
    for (let s = 0; s < midiSections; s++) {
      const sectionRing = view.getUint32(cursor, true);
      const slotCount = view.getUint32(cursor + 8, true);
      const sysexLen = view.getUint32(cursor + 16, true);
      cursor += 20;
      for (let k = 0; k < slotCount; k++) {
        if (sectionRing !== ringIndex) continue;
        const off = cursor + k * 8;
        out.push({
          event: wireToMidiEvent(
            view.getUint8(off),
            view.getUint8(off + 1),
            view.getUint8(off + 2),
          ),
          atSample: view.getUint32(off + 4, true),
        });
      }
      cursor += slotCount * 8;
      cursor = (cursor + sysexLen + 3) & ~3;
    }
  }
  return out;
};

// ── postMessage transport ───────────────────────────────────────────────────

test("postMessage: an inbound noteOn round-trips unchanged through the WASM thru", async () => {
  const thru = makeThru();
  const { wasm } = await compile(thru);
  const self = makeMockSelf();
  const midiRings = thru.worklet.midiRings;
  thru.worklet.initialize(self, {
    processorOptions: {
      wasm,
      transport: "postMessage",
      midiRings,
      midiRingSabOffsets: ringOffsets(midiRings),
      sysexContentSabOffsets: midiRings.map(() => 0),
    },
  });
  seedEgressPool(self, midiRings);
  const inIndex = midiRings.findIndex((r) => r.direction === "in");
  const outIndex = midiRings.findIndex((r) => r.direction === "out");

  const sent = { type: "noteOn", channel: 3, note: 60, velocity: 100 } as const;
  fireToWorklet(self, {
    kind: "midi",
    ringIndex: inIndex,
    item: { ...midiEventToWire(sent), atSample: 5 },
  });

  const q = emptyQuantum();
  thru.worklet.process(self, q.inputs, q.outputs, q.parameters);

  const received = drainPostedMidiOut(self, outIndex);
  expect(received).toHaveLength(1);
  expect(received[0]!.event).toEqual(sent);
  expect(received[0]!.atSample).toBe(5);
});

test("postMessage: cc and pitchBend survive the 14-bit / controller encoding round-trip", async () => {
  const thru = makeThru();
  const { wasm } = await compile(thru);
  const self = makeMockSelf();
  const midiRings = thru.worklet.midiRings;
  thru.worklet.initialize(self, {
    processorOptions: {
      wasm,
      transport: "postMessage",
      midiRings,
      midiRingSabOffsets: ringOffsets(midiRings),
      sysexContentSabOffsets: midiRings.map(() => 0),
    },
  });
  seedEgressPool(self, midiRings);
  const inIndex = midiRings.findIndex((r) => r.direction === "in");
  const outIndex = midiRings.findIndex((r) => r.direction === "out");

  const cc = { type: "cc", channel: 1, controller: 74, value: 99 } as const;
  const bend = { type: "pitchBend", channel: 9, value: 8191 } as const; // 14-bit
  fireToWorklet(self, {
    kind: "midi",
    ringIndex: inIndex,
    item: { ...midiEventToWire(cc), atSample: 0 },
  });
  fireToWorklet(self, {
    kind: "midi",
    ringIndex: inIndex,
    item: { ...midiEventToWire(bend), atSample: 12 },
  });

  const q = emptyQuantum();
  thru.worklet.process(self, q.inputs, q.outputs, q.parameters);

  const received = drainPostedMidiOut(self, outIndex);
  expect(received.map((r) => r.event)).toEqual([cc, bend]);
});

test("postMessage: two inbound events in one quantum both drain (handler not broken by emit)", async () => {
  const thru = makeThru();
  const { wasm } = await compile(thru);
  const self = makeMockSelf();
  const midiRings = thru.worklet.midiRings;
  thru.worklet.initialize(self, {
    processorOptions: {
      wasm,
      transport: "postMessage",
      midiRings,
      midiRingSabOffsets: ringOffsets(midiRings),
      sysexContentSabOffsets: midiRings.map(() => 0),
    },
  });
  seedEgressPool(self, midiRings);
  const inIndex = midiRings.findIndex((r) => r.direction === "in");
  const outIndex = midiRings.findIndex((r) => r.direction === "out");

  const a = { type: "noteOn", channel: 0, note: 60, velocity: 1 } as const;
  const b = { type: "noteOn", channel: 0, note: 64, velocity: 1 } as const;
  fireToWorklet(self, {
    kind: "midi",
    ringIndex: inIndex,
    item: { ...midiEventToWire(a), atSample: 0 },
  });
  fireToWorklet(self, {
    kind: "midi",
    ringIndex: inIndex,
    item: { ...midiEventToWire(b), atSample: 8 },
  });

  const q = emptyQuantum();
  thru.worklet.process(self, q.inputs, q.outputs, q.parameters);

  const received = drainPostedMidiOut(self, outIndex);
  expect(received.map((r) => r.event)).toEqual([a, b]);
  expect(received.map((r) => r.atSample)).toEqual([0, 8]);
});

// ── SAB transport ─────────────────────────────────────────────────────────

test("sab: an inbound noteOn written to the shared ring round-trips through the WASM thru", async () => {
  const thru = makeThru();
  const { wasm } = await compile(thru);
  const self = makeMockSelf();
  const midiRings = thru.worklet.midiRings;
  const offsets = ringOffsets(midiRings);
  // A plain ArrayBuffer stands in for the SharedArrayBuffer — single-threaded in
  // node, but the same Atomics header ops + bulk copy the browser path runs.
  const midiBuf = new ArrayBuffer(ringsTotalBytes(midiRings));
  thru.worklet.initialize(self, {
    processorOptions: {
      wasm,
      transport: "sab",
      midiRings,
      midiRingsBuffer: midiBuf,
      midiRingSabOffsets: offsets,
      sysexContentSabOffsets: midiRings.map(() => 0),
    },
  });
  const inIndex = midiRings.findIndex((r) => r.direction === "in");
  const outIndex = midiRings.findIndex((r) => r.direction === "out");

  // Main writes one inbound slot to the SAB in-ring (head 0 → 1), exactly as the
  // client `send` SAB path does.
  const inOffset = offsets[inIndex]!;
  const inHeader = new Int32Array(midiBuf, inOffset, 3);
  const dv = new DataView(midiBuf);
  const sent = { type: "noteOn", channel: 7, note: 48, velocity: 120 } as const;
  const wire = midiEventToWire(sent);
  const slotBase = inOffset + 12; // slot 0 = right after the 12-byte header
  dv.setUint8(slotBase, wire.status);
  dv.setUint8(slotBase + 1, wire.data1);
  dv.setUint8(slotBase + 2, wire.data2);
  dv.setUint32(slotBase + 4, 33, true);
  Atomics.store(inHeader, 0, 1); // head = 1

  const q = emptyQuantum();
  thru.worklet.process(self, q.inputs, q.outputs, q.parameters);

  // Worklet mirrored the WASM out-ring into the SAB out-ring; read it like the
  // client rAF poll does (tail → head).
  const outOffset = offsets[outIndex]!;
  const outHeader = new Int32Array(midiBuf, outOffset, 3);
  const head = Atomics.load(outHeader, 0);
  expect(head).toBe(1);
  const outSlot = outOffset + 12; // slot 0 = right after the 12-byte header
  const event = wireToMidiEvent(
    dv.getUint8(outSlot),
    dv.getUint8(outSlot + 1),
    dv.getUint8(outSlot + 2),
  );
  expect(event).toEqual(sent);
  expect(dv.getUint32(outSlot + 4, true)).toBe(33);
});

// ── overflow ────────────────────────────────────────────────────────────────

test("sab: inbound ring overflow drops oldest and advances the overflow counter", async () => {
  // A tiny capacity-16 in port. The simulated main writes 20 events with
  // drop-oldest (the client `send` SAB protocol), so the overflow counter must
  // read 4 and the ring retains the most-recent 16.
  const proc = defineProcessor(() => {
    const midiIn = event.midi({ from: "main", name: "in", capacity: CAPACITY_16 });
    const midiOut = event.midi({ to: "main", name: "out" });
    return {
      process: () => {
        midiIn.onEvent("noteOn", ({ channel, note, velocity, atSample }) => {
          midiOut.emitIf(true, { type: "noteOn", channel, note, velocity, atSample });
        });
      },
    };
  });
  const { wasm } = await compile(proc);
  const self = makeMockSelf();
  const midiRings = proc.worklet.midiRings;
  const offsets = ringOffsets(midiRings);
  const midiBuf = new ArrayBuffer(ringsTotalBytes(midiRings));
  proc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      transport: "sab",
      midiRings,
      midiRingsBuffer: midiBuf,
      midiRingSabOffsets: offsets,
      sysexContentSabOffsets: midiRings.map(() => 0),
    },
  });
  const inIndex = midiRings.findIndex((r) => r.direction === "in");
  const inOffset = offsets[inIndex]!;
  const inHeader = new Int32Array(midiBuf, inOffset, 3);
  const dv = new DataView(midiBuf);

  // 20 writes with drop-oldest (head - tail >= 16 → tail++ + overflow++).
  for (let n = 0; n < 20; n++) {
    const head = Atomics.load(inHeader, 0);
    const tail = Atomics.load(inHeader, 1);
    if (head - tail >= 16) {
      Atomics.store(inHeader, 1, tail + 1);
      Atomics.store(inHeader, 2, Atomics.load(inHeader, 2) + 1);
    }
    const wire = midiEventToWire({ type: "noteOn", channel: 0, note: n, velocity: 1 });
    const slotBase = inOffset + 12 + (head % 16) * 8;
    dv.setUint8(slotBase, wire.status);
    dv.setUint8(slotBase + 1, wire.data1);
    dv.setUint8(slotBase + 2, wire.data2);
    dv.setUint32(slotBase + 4, 0, true);
    Atomics.store(inHeader, 0, head + 1);
  }

  expect(Atomics.load(inHeader, 2)).toBe(4); // 20 - 16 = 4 dropped

  const q = emptyQuantum();
  proc.worklet.process(self, q.inputs, q.outputs, q.parameters);

  // The 16 retained inbound events (notes 4..19) all re-emit on the out ring.
  const outIndex = midiRings.findIndex((r) => r.direction === "out");
  const outHeader = new Int32Array(midiBuf, offsets[outIndex]!, 3);
  expect(Atomics.load(outHeader, 0)).toBe(16);
});

// ── header release order ──────────────────────────────────────────────────────

test("sab: the out-ring producer stores head LAST (release order, not torn)", async () => {
  // head is the release point: a consumer that acquire-loads the new head must
  // already see the matching tail + overflow. Storing head first lets a main-
  // thread reader pair a new head with a stale tail and miscompute drop-oldest.
  const thru = makeThru();
  const { wasm } = await compile(thru);
  const self = makeMockSelf();
  const midiRings = thru.worklet.midiRings;
  const offsets = ringOffsets(midiRings);
  const midiBuf = new ArrayBuffer(ringsTotalBytes(midiRings));
  thru.worklet.initialize(self, {
    processorOptions: {
      wasm,
      transport: "sab",
      midiRings,
      midiRingsBuffer: midiBuf,
      midiRingSabOffsets: offsets,
      sysexContentSabOffsets: midiRings.map(() => 0),
    },
  });
  const inIndex = midiRings.findIndex((r) => r.direction === "in");
  const outIndex = midiRings.findIndex((r) => r.direction === "out");
  const outOffset = offsets[outIndex]!;

  // One inbound event so the thru re-emits on the out ring (= producer path).
  const inOffset = offsets[inIndex]!;
  const inHeader = new Int32Array(midiBuf, inOffset, 3);
  const dv = new DataView(midiBuf);
  const wire = midiEventToWire({ type: "noteOn", channel: 0, note: 60, velocity: 100 });
  dv.setUint8(inOffset + 12, wire.status);
  dv.setUint8(inOffset + 13, wire.data1);
  dv.setUint8(inOffset + 14, wire.data2);
  dv.setUint32(inOffset + 16, 0, true);
  Atomics.store(inHeader, 0, 1);

  // Record the index order of the producer's writes to the OUT-ring header.
  const realStore = Atomics.store.bind(Atomics);
  const outHeaderWrites: number[] = [];
  const spy = vi.spyOn(Atomics, "store").mockImplementation(((
    ta: Int32Array,
    index: number,
    value: number,
  ): number => {
    if (ta.buffer === midiBuf && ta.byteOffset === outOffset && ta.length === 3) {
      outHeaderWrites.push(index);
    }
    return realStore(ta, index, value);
  }) as typeof Atomics.store);
  try {
    const q = emptyQuantum();
    thru.worklet.process(self, q.inputs, q.outputs, q.parameters);
  } finally {
    spy.mockRestore();
  }

  // head = index 0, tail = 1, overflow = 2. head must be written last.
  expect(outHeaderWrites).toContain(0);
  const headPos = outHeaderWrites.indexOf(0);
  expect(headPos).toBeGreaterThan(outHeaderWrites.indexOf(1));
  expect(headPos).toBeGreaterThan(outHeaderWrites.indexOf(2));
});
