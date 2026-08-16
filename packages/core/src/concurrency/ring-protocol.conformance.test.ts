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
import { i32 } from "./../dsl/constructors.ts";
import { audioOutput, event, state as stateDecl } from "./../dsl/declarations.ts";
import { forSample } from "./../dsl/loop.ts";
import { midiEventToWire } from "./../midiWire.ts";
import { defineProcessor } from "./../processor.ts";
import { type AbstractRingOp, IN_RING_MIRROR_OPS, OUT_RING_PUBLISH_OPS } from "./ring-model.ts";

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

  // oxlint-disable-next-line typescript/unbound-method -- saved to restore the native method; only ever invoked via .call(this)
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

/**
 * Run `run()` while recording, in execution order, the worklet's in-ring mirror
 * of one ring: each header `Atomics.load` (acquire) and the bulk `.set()` copy
 * whose SOURCE is the SAB ring (tagged with whether the source starts at the
 * header — i.e. whether the copy spans the 12-byte header).
 */
const captureMirror = (
  sab: ArrayBuffer,
  sabRingOffset: number,
  ringTotalBytes: number,
  run: () => void,
): AbstractRingOp[] => {
  const captured: AbstractRingOp[] = [];
  // The mirror runs at the START of the quantum and ends at its bulk copy; stop
  // recording after it so a later same-ring access (e.g. the tail-commit load)
  // is not folded into the mirror sequence.
  let done = false;

  const realLoad = Atomics.load.bind(Atomics);
  const loadSpy = vi.spyOn(Atomics, "load").mockImplementation(((
    ta: Int32Array,
    index: number,
  ): number => {
    if (!done && ta.buffer === sab && ta.byteOffset === sabRingOffset && ta.length === 3) {
      captured.push({
        op: "atomic-load",
        word: index === 0 ? "head" : index === 1 ? "tail" : "overflow",
      });
    }
    return realLoad(ta, index);
  }) as typeof Atomics.load);

  // oxlint-disable-next-line typescript/unbound-method -- saved to restore the native method; only ever invoked via .call(this)
  const realSet = Uint8Array.prototype.set;
  // eslint-disable-next-line no-extend-native -- restored in finally
  Uint8Array.prototype.set = function (this: Uint8Array, src: ArrayLike<number>, offset?: number) {
    if (!done && ArrayBuffer.isView(src)) {
      const v = src as ArrayBufferView;
      if (
        v.buffer === sab &&
        v.byteOffset >= sabRingOffset &&
        v.byteOffset < sabRingOffset + ringTotalBytes
      ) {
        captured.push({ op: "bulk-copy", touchesHeader: v.byteOffset === sabRingOffset });
        done = true;
      }
    }
    return offset === undefined ? realSet.call(this, src) : realSet.call(this, src, offset);
  };

  try {
    run();
  } finally {
    loadSpy.mockRestore();
    Uint8Array.prototype.set = realSet;
  }
  return captured;
};

/**
 * Run `run()` while recording, in order, how the worklet writes the `tail` word
 * (index 1) of one in-ring's SAB header: via a plain `Atomics.store` (the lost-
 * update-prone form) or an `Atomics.compareExchange` (the monotone-max form).
 * The in-ring tail has a second writer (the main drop-oldest), so the safe form
 * is the compare-exchange.
 */
const captureTailCommit = (
  sab: ArrayBuffer,
  ringSabOffset: number,
  run: () => void,
): Array<"store" | "cas"> => {
  const writes: Array<"store" | "cas"> = [];
  const isTail = (ta: Int32Array, index: number): boolean =>
    ta.buffer === sab && ta.byteOffset === ringSabOffset && ta.length === 3 && index === 1;

  const realStore = Atomics.store.bind(Atomics);
  const storeSpy = vi.spyOn(Atomics, "store").mockImplementation(((
    ta: Int32Array,
    index: number,
    value: number,
  ): number => {
    if (isTail(ta, index)) writes.push("store");
    return realStore(ta, index, value);
  }) as typeof Atomics.store);

  const realCx = Atomics.compareExchange.bind(Atomics);
  const cxSpy = vi.spyOn(Atomics, "compareExchange").mockImplementation(((
    ta: Int32Array,
    index: number,
    expected: number,
    replacement: number,
  ): number => {
    if (isTail(ta, index)) writes.push("cas");
    return realCx(ta, index, expected, replacement);
  }) as typeof Atomics.compareExchange);

  try {
    run();
  } finally {
    storeSpy.mockRestore();
    cxSpy.mockRestore();
  }
  return writes;
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

// ── message in-ring (worklet.ts message mirror) ─────────────────────────────

test("conformance: the message in-ring mirror matches the model's safe op-order", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    const captured = stateDecl.named("captured").i32(0);
    const ctrl = event<{ slot: number }>({ from: "main", name: "ctrl", capacity: 16 });
    return {
      process: () => {
        ctrl.onReceive(({ slot }) => {
          // `slot` is a `number` field → `Node<'f32'>` on the wire; convert to the
          // i32 counter slot explicitly.
          captured.write(i32(slot));
        });
        forSample((i) => {
          out.ch(0).at(i).write(0);
        });
      },
    };
  });
  const { wasm } = await compile(proc);
  const messageRings = proc.worklet.messageRings;
  const ring = messageRings[0]!;
  const ringTotalBytes = 12 + ring.capacity * ring.slotSize;
  const sab = new ArrayBuffer(ringTotalBytes);
  const self = makeMockSelf();
  proc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      transport: "sab",
      messageRings,
      messageRingsBuffer: sab,
      messageRingSabOffsets: [0],
    },
  });
  // Simulate a main-side push: write slot 0 and release head = 1.
  const headerView = new Int32Array(sab, 0, 3);
  // The inbound `slot` field rides the f32 wire — push 42.0 as f32 bits.
  const slotsView = new Float32Array(sab, 12);
  slotsView[0] = 42;
  Atomics.store(headerView, 0, 1);

  const q = emptyQuantum();
  const captured = captureMirror(sab, 0, ringTotalBytes, () => {
    proc.worklet.process(self, q.inputs, q.outputs, q.parameters);
  });

  expect(captured).toEqual(IN_RING_MIRROR_OPS);
});

// ── MIDI in-ring (worklet.ts MIDI mirror) ───────────────────────────────────

test("conformance: the MIDI in-ring mirror matches the model's safe op-order", async () => {
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
  const inOffset = offsets[inIndex]!;
  const inHeader = new Int32Array(sab, inOffset, 3);
  const dv = new DataView(sab);
  const wire = midiEventToWire({ type: "noteOn", channel: 0, note: 60, velocity: 100 });
  dv.setUint8(inOffset + 12, wire.status);
  dv.setUint8(inOffset + 13, wire.data1);
  dv.setUint8(inOffset + 14, wire.data2);
  dv.setUint32(inOffset + 16, 0, true);
  Atomics.store(inHeader, 0, 1);

  const inRingTotalBytes = 12 + midiRings[inIndex]!.capacity * 8;
  const q = emptyQuantum();
  const captured = captureMirror(sab, inOffset, inRingTotalBytes, () => {
    thru.worklet.process(self, q.inputs, q.outputs, q.parameters);
  });

  expect(captured).toEqual(IN_RING_MIRROR_OPS);
});

// ── in-ring tail commit mechanism (bug #3: split-writer tail) ───────────────

test("conformance: the worklet commits the message in-ring tail via compare-exchange", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    const captured = stateDecl.named("captured").i32(0);
    const ctrl = event<{ slot: number }>({ from: "main", name: "ctrl", capacity: 16 });
    return {
      process: () => {
        ctrl.onReceive(({ slot }) => {
          // `slot` is a `number` field → `Node<'f32'>` on the wire; convert to the
          // i32 counter slot explicitly.
          captured.write(i32(slot));
        });
        forSample((i) => {
          out.ch(0).at(i).write(0);
        });
      },
    };
  });
  const { wasm } = await compile(proc);
  const messageRings = proc.worklet.messageRings;
  const ring = messageRings[0]!;
  const ringTotalBytes = 12 + ring.capacity * ring.slotSize;
  const sab = new ArrayBuffer(ringTotalBytes);
  const self = makeMockSelf();
  proc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      transport: "sab",
      messageRings,
      messageRingsBuffer: sab,
      messageRingSabOffsets: [0],
    },
  });
  // One pending message so the worklet drains (advances tail) and commits it.
  const headerView = new Int32Array(sab, 0, 3);
  new Float32Array(sab, 12)[0] = 42; // inbound `slot` rides the f32 wire
  Atomics.store(headerView, 0, 1);

  const q = emptyQuantum();
  const writes = captureTailCommit(sab, 0, () => {
    proc.worklet.process(self, q.inputs, q.outputs, q.parameters);
  });

  // The tail is written by compare-exchange (monotone-max), never a plain store
  // that could rewind the main drop-oldest's advance.
  expect(writes).toEqual(["cas"]);
});

test("conformance: the worklet commits the MIDI in-ring tail via compare-exchange", async () => {
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
  const inOffset = offsets[inIndex]!;
  const inHeader = new Int32Array(sab, inOffset, 3);
  const dv = new DataView(sab);
  const wire = midiEventToWire({ type: "noteOn", channel: 0, note: 60, velocity: 100 });
  dv.setUint8(inOffset + 12, wire.status);
  dv.setUint8(inOffset + 13, wire.data1);
  dv.setUint8(inOffset + 14, wire.data2);
  dv.setUint32(inOffset + 16, 0, true);
  Atomics.store(inHeader, 0, 1);

  const q = emptyQuantum();
  const writes = captureTailCommit(sab, inOffset, () => {
    thru.worklet.process(self, q.inputs, q.outputs, q.parameters);
  });

  expect(writes).toEqual(["cas"]);
});
