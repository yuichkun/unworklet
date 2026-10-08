import * as core from "@unworklet/core";
import type { CompileInstance, MidiEvent, Node } from "@unworklet/core";
import { audioOutput, defineProcessor, event, f32, forSample, state } from "@unworklet/core";
import { expect, test, vi } from "vite-plus/test";

import { renderOffline } from "./index.ts";

type FixedEvent = Exclude<MidiEvent, { type: "sysex" }>;
type Vector = { payload: FixedEvent; wire: number[]; fields: number[] };
// Literal semantic/wire pairs keep reciprocal codec defects from becoming an oracle.
// Only meaningful bytes are specified; reserved bytes need not be initialized.
const vectors: Vector[] = [
  {
    payload: { type: "noteOff", channel: 0, note: 0, velocity: 127 },
    wire: [0x80, 0, 127],
    fields: [0, 0, 0, 127],
  },
  {
    payload: { type: "noteOff", channel: 15, note: 127, velocity: 0 },
    wire: [0x8f, 127, 0],
    fields: [0, 15, 127, 0],
  },
  {
    payload: { type: "noteOn", channel: 0, note: 127, velocity: 1 },
    wire: [0x90, 127, 1],
    fields: [1, 0, 127, 1],
  },
  {
    payload: { type: "noteOn", channel: 15, note: 0, velocity: 0 },
    wire: [0x9f, 0, 0],
    fields: [1, 15, 0, 0],
  },
  {
    payload: { type: "aftertouch", channel: 0, note: 0, pressure: 127 },
    wire: [0xa0, 0, 127],
    fields: [2, 0, 0, 127],
  },
  {
    payload: { type: "aftertouch", channel: 15, note: 127, pressure: 0 },
    wire: [0xaf, 127, 0],
    fields: [2, 15, 127, 0],
  },
  {
    payload: { type: "cc", channel: 0, controller: 0, value: 127 },
    wire: [0xb0, 0, 127],
    fields: [3, 0, 0, 127],
  },
  {
    payload: { type: "cc", channel: 15, controller: 127, value: 0 },
    wire: [0xbf, 127, 0],
    fields: [3, 15, 127, 0],
  },
  {
    payload: { type: "programChange", channel: 0, program: 0 },
    wire: [0xc0, 0],
    fields: [4, 0, 0, -1],
  },
  {
    payload: { type: "programChange", channel: 15, program: 127 },
    wire: [0xcf, 127],
    fields: [4, 15, 127, -1],
  },
  {
    payload: { type: "channelPressure", channel: 0, pressure: 127 },
    wire: [0xd0, 127],
    fields: [5, 0, 127, -1],
  },
  {
    payload: { type: "channelPressure", channel: 15, pressure: 0 },
    wire: [0xdf, 0],
    fields: [5, 15, 0, -1],
  },
  {
    payload: { type: "pitchBend", channel: 0, value: 0 },
    wire: [0xe0, 0, 0],
    fields: [6, 0, 0, -1],
  },
  {
    payload: { type: "pitchBend", channel: 15, value: 127 },
    wire: [0xef, 127, 0],
    fields: [6, 15, 127, -1],
  },
  {
    payload: { type: "pitchBend", channel: 0, value: 128 },
    wire: [0xe0, 0, 1],
    fields: [6, 0, 128, -1],
  },
  {
    payload: { type: "pitchBend", channel: 15, value: 8191 },
    wire: [0xef, 127, 63],
    fields: [6, 15, 8191, -1],
  },
  {
    payload: { type: "pitchBend", channel: 0, value: 8192 },
    wire: [0xe0, 0, 64],
    fields: [6, 0, 8192, -1],
  },
  {
    payload: { type: "pitchBend", channel: 15, value: 16383 },
    wire: [0xef, 127, 127],
    fields: [6, 15, 16383, -1],
  },
  { payload: { type: "systemRealtime", status: 0xf8 }, wire: [0xf8], fields: [7, -1, 0xf8, -1] },
  { payload: { type: "systemRealtime", status: 0xf9 }, wire: [0xf9], fields: [7, -1, 0xf9, -1] },
  { payload: { type: "systemRealtime", status: 0xfa }, wire: [0xfa], fields: [7, -1, 0xfa, -1] },
  { payload: { type: "systemRealtime", status: 0xfb }, wire: [0xfb], fields: [7, -1, 0xfb, -1] },
  { payload: { type: "systemRealtime", status: 0xfc }, wire: [0xfc], fields: [7, -1, 0xfc, -1] },
  { payload: { type: "systemRealtime", status: 0xfd }, wire: [0xfd], fields: [7, -1, 0xfd, -1] },
  { payload: { type: "systemRealtime", status: 0xfe }, wire: [0xfe], fields: [7, -1, 0xfe, -1] },
  { payload: { type: "systemRealtime", status: 0xff }, wire: [0xff], fields: [7, -1, 0xff, -1] },
];
type Entry = Vector & { offset: number };

function batches(capacity: number): Entry[][] {
  const batch = (count: number, start: number) =>
    Array.from({ length: count }, (_, i) => ({
      ...vectors[(start + i) % vectors.length]!,
      offset: [0, 1, 63, 126, 127][i % 5]!,
    }));
  // Every literal survives in the first two blocks, including capacity 16.
  return [
    batch(13, 0),
    batch(13, 13),
    [],
    batch(capacity, 3),
    batch(capacity + 5, 11),
    batch(3, 23),
    [],
  ];
}

class Fifo {
  queue: Entry[] = [];
  writes = 0;
  discarded = 0;
  constructor(
    readonly capacity: number,
    readonly seed: number,
  ) {}
  push(entries: Entry[]) {
    for (const entry of entries) {
      this.queue.push(entry);
      this.writes++;
      if (this.queue.length > this.capacity) {
        this.queue.shift();
        this.discarded++;
      }
    }
  }
  header() {
    return [
      (this.seed + this.writes) | 0,
      (this.seed + this.writes - this.queue.length) | 0,
      this.discarded,
    ];
  }
  drain() {
    return this.queue.splice(0);
  }
}

function inputProbe(capacity: 16 | 32) {
  return defineProcessor(() => {
    const input = event.midi({ from: "main", name: "port", capacity });
    const output = audioOutput({ channels: 6, name: "observed" });
    const count = state.i32(0);
    const columns = Array.from({ length: 5 }, () => state.buffer.i32({ size: 128 }));
    const record = (...fields: (Node<"i32"> | number)[]) => {
      fields.forEach((field, column) => columns[column]!.write(count.read(), field));
      count.write(count.read().add(1));
    };
    return {
      process() {
        input.onEvent("noteOff", (e) => record(0, e.channel, e.note, e.velocity, e.atSample));
        input.onEvent("noteOn", (e) => record(1, e.channel, e.note, e.velocity, e.atSample));
        input.onEvent("aftertouch", (e) => record(2, e.channel, e.note, e.pressure, e.atSample));
        input.onEvent("cc", (e) => record(3, e.channel, e.controller, e.value, e.atSample));
        input.onEvent("programChange", (e) => record(4, e.channel, e.program, -1, e.atSample));
        input.onEvent("channelPressure", (e) => record(5, e.channel, e.pressure, -1, e.atSample));
        input.onEvent("pitchBend", (e) => record(6, e.channel, e.value, -1, e.atSample));
        input.onEvent("systemRealtime", (e) => record(7, -1, e.status, -1, e.atSample));
        forSample((i) => {
          columns.forEach((column, c) =>
            output
              .ch(c)
              .at(i)
              .write(f32(column.read(i))),
          );
          output.ch(5).at(i).write(f32(count.read()));
        });
        count.write(0);
      },
    };
  });
}

function outputProbe(capacity: 16 | 32, schedule: Entry[][]) {
  return defineProcessor(() => {
    const output = event.midi({ to: "main", name: "port", capacity });
    const block = state.i32(0);
    return {
      process() {
        schedule.forEach((entries, b) =>
          entries.forEach((entry) => {
            output.emitIf(block.read().eq(b), { ...entry.payload, atSample: entry.offset });
          }),
        );
        block.write(block.read().add(1));
      },
    };
  });
}

function assertRows(channels: Float32Array[], start: number, entries: Entry[]) {
  expect(Array.from(channels[5]!.slice(start, start + 128))).toEqual(
    Array(128).fill(entries.length),
  );
  const rows = entries.map((_, i) => channels.slice(0, 5).map((c) => c[start + i]));
  expect(rows).toEqual(entries.map((e) => [...e.fields, e.offset]));
}

function assertWire(memory: ArrayBufferLike, base: number, capacity: number, expected: Entry[]) {
  const header = new Int32Array(memory, base, 3);
  expect((header[0]! - header[1]!) >>> 0).toBe(expected.length);
  const view = new DataView(memory);
  // Never use an unbounded counter-to-head loop, even when a header is broken.
  for (let i = 0; i < expected.length; i++) {
    const entry = expected[i]!;
    const slot = base + 12 + (((header[1]! >>> 0) + i) % capacity) * 8;
    expect(entry.wire.map((_, j) => view.getUint8(slot + j))).toEqual(entry.wire);
    expect(view.getUint32(slot + 4, true)).toBe(entry.offset);
  }
}

function seedRing(instance: CompileInstance, base: number, seed: number) {
  const header = new Int32Array(instance.memory.buffer, base, 3);
  header.set([seed, seed, 0]);
  return header;
}

for (const capacity of [16, 32] as const) {
  // The final seeds straddle each counter boundary while the ring is full.
  for (const seed of [0, 0x7ffffff8, -8, (0x7ffffff8 - 26 - capacity) | 0, -8 - 26 - capacity]) {
    test(`MIDI input: literal wire / offline injection / FIFO (${capacity}, ${seed})`, async () => {
      const schedule = batches(capacity);
      const processor = inputProbe(capacity);
      const compiled = await core.compile(processor);
      const meta = core.extractWorkletMeta(compiled.graph as never);
      const base = meta.layout.regions.midiRings.slots.port!.base;
      const direct = await compiled.driver.instantiate();
      const header = seedRing(direct, base, seed);
      const oracle = new Fifo(capacity, seed);
      const retained: Entry[][] = [];
      for (const entries of schedule) {
        oracle.push(entries);
        const view = new DataView(direct.memory.buffer);
        // Materialize the independent FIFO, rather than using production ring helpers.
        const expectedHeader = oracle.header();
        oracle.queue.forEach((entry, i) => {
          const slot = base + 12 + (((expectedHeader[1]! >>> 0) + i) % capacity) * 8;
          new Uint8Array(direct.memory.buffer, slot, 4).fill(0x55);
          entry.wire.forEach((byte, j) => view.setUint8(slot + j, byte));
          view.setUint32(slot + 4, entry.offset, true);
        });
        header.set(expectedHeader);
        const expected = oracle.drain();
        retained.push(expected);
        direct.process();
        const channels = Array.from({ length: 6 }, (_, c) => {
          const values = new Float32Array(128);
          direct.readOutput("observed", c, values);
          return values;
        });
        assertRows(channels, 0, expected);
        expect(Array.from(header)).toEqual(oracle.header());
      }
      const offlineOracle = new Fifo(capacity, seed);
      const instantiate = compiled.driver.instantiate.bind(compiled.driver);
      let offlineHeader: Int32Array | undefined;
      let block = 0;
      compiled.driver.instantiate = async () => {
        const instance = await instantiate();
        offlineHeader = seedRing(instance, base, seed);
        const process = instance.process.bind(instance);
        instance.process = () => {
          offlineOracle.push(schedule[block++]!);
          expect(Array.from(offlineHeader!)).toEqual(offlineOracle.header());
          assertWire(instance.memory.buffer, base, capacity, offlineOracle.queue);
          process();
          offlineOracle.drain();
          expect(Array.from(offlineHeader!)).toEqual(offlineOracle.header());
        };
        return instance;
      };
      const spy = vi.spyOn(core, "compile").mockResolvedValue(compiled);
      try {
        const result = await renderOffline(processor, {
          sampleRate: 48000,
          duration: (schedule.length * 128) / 48000,
          events: schedule.flatMap((entries, b) =>
            entries.map((e) => ({
              name: "port",
              payload: e.payload,
              atSample: b * 128 + e.offset,
            })),
          ),
        });
        retained.forEach((entries, b) => assertRows(result.outputs.observed!, b * 128, entries));
        expect(block).toBe(schedule.length);
        expect(Array.from(offlineHeader!)).toEqual(oracle.header());
        expect(result.events).toEqual([]);
        expect(result.diagnostics.scrubbedSamples).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });

    test(`MIDI output: literal semantics / WASM wire / offline drain / FIFO (${capacity}, ${seed})`, async () => {
      const schedule = batches(capacity);
      const processor = outputProbe(capacity, schedule);
      const compiled = await core.compile(processor);
      const base = core.extractWorkletMeta(compiled.graph as never).layout.regions.midiRings.slots
        .port!.base;
      const direct = await compiled.driver.instantiate();
      const header = seedRing(direct, base, seed);
      const oracle = new Fifo(capacity, seed);
      const retained: Entry[] = [];
      for (const entries of schedule) {
        oracle.push(entries);
        direct.process();
        expect(Array.from(header)).toEqual(oracle.header());
        assertWire(direct.memory.buffer, base, capacity, oracle.queue);
        retained.push(...oracle.drain());
        header[1] = header[0]!;
        expect(Array.from(header)).toEqual(oracle.header());
      }
      const offlineOracle = new Fifo(capacity, seed);
      const instantiate = compiled.driver.instantiate.bind(compiled.driver);
      let offlineHeader: Int32Array | undefined;
      let memory: ArrayBufferLike | undefined;
      let block = 0;
      compiled.driver.instantiate = async () => {
        const instance = await instantiate();
        memory = instance.memory.buffer;
        offlineHeader = seedRing(instance, base, seed);
        const process = instance.process.bind(instance);
        instance.process = () => {
          expect(Array.from(offlineHeader!)).toEqual(offlineOracle.header());
          offlineOracle.push(schedule[block++]!);
          process();
          expect(Array.from(offlineHeader!)).toEqual(offlineOracle.header());
          assertWire(instance.memory.buffer, base, capacity, offlineOracle.queue);
          offlineOracle.drain();
        };
        return instance;
      };
      const spy = vi.spyOn(core, "compile").mockResolvedValue(compiled);
      // Bound the public JS drain as well as this suite's own loops.
      let reads = 0;
      // eslint-disable-next-line @typescript-eslint/unbound-method -- receiver is forwarded.
      const getUint8 = DataView.prototype.getUint8;
      const readSpy = vi
        .spyOn(DataView.prototype, "getUint8")
        .mockImplementation(function (this: DataView, offset) {
          if (this.buffer === memory && ++reads > 4096) throw new Error("unbounded MIDI drain");
          return getUint8.call(this, offset);
        });
      try {
        const result = await renderOffline(processor, {
          sampleRate: 48000,
          duration: (schedule.length * 128) / 48000,
        });
        expect(result.events).toEqual(
          retained.map((e) => ({ name: "port", payload: e.payload, atSample: e.offset })),
        );
        expect(block).toBe(schedule.length);
        expect(Array.from(offlineHeader!)).toEqual(oracle.header());
      } finally {
        readSpy.mockRestore();
        spy.mockRestore();
      }
    });
  }
}
