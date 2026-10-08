import * as core from "@unworklet/core";
import type { CompileInstance } from "@unworklet/core";
import { defineProcessor, event, forSample, state } from "@unworklet/core";
import { expect, test, vi } from "vite-plus/test";

import { renderOffline } from "./index.ts";

type Entry = { bytes: number[]; length: number; offset: number };
type Region = { base: number; chunks: number; perChunk: number };
const sizes = [0, 1, 3, 127, 128, 255, 256, 1019, 1020];
const alphabet = [0xf0, 0, 0x7f, 0x80, 0xff, 0x12, 0xf7];

function batch(count: number, start: number): Entry[] {
  return Array.from({ length: count }, (_, i) => {
    const length = sizes[(start + i) % sizes.length]!;
    return {
      bytes: Array.from({ length }, (_, j) => alphabet[(start + i + j) % alphabet.length]!),
      length,
      offset: [0, 1, 63, 127][i % 4]!,
    };
  });
}

class Fifo {
  queue: Entry[] = [];
  writes = 0;
  evicted = 0;
  rejected = 0;
  constructor(
    readonly capacity: number,
    readonly seed: number,
  ) {}
  push(entries: Entry[]) {
    for (const entry of entries) {
      if (entry.length < 0 || entry.length > 1020) {
        this.rejected++;
        continue;
      }
      this.queue.push({ ...entry, bytes: [...entry.bytes] });
      this.writes++;
      if (this.queue.length > this.capacity) {
        this.queue.shift();
        this.evicted++;
      }
    }
  }
  header() {
    return [
      (this.seed + this.writes) | 0,
      (this.seed + this.writes - this.queue.length) | 0,
      this.evicted,
    ];
  }
  drain() {
    return this.queue.splice(0);
  }
}

function inputProbe(capacity: 16 | 32 | 512) {
  return defineProcessor(() => {
    const input = event.midi({ from: "main", name: "inbound", capacity });
    const scratch = state.buffer.u8({ size: 1024 });
    const observed = state.buffer.u8({ size: capacity * 1024 }).named("observed");
    const lengths = state.buffer.i32({ size: capacity }).named("lengths");
    const offsets = state.buffer.i32({ size: capacity }).named("offsets");
    const count = state.i32(0).named("count");
    return {
      process() {
        input.onEvent("sysex", ({ data, length, atSample }) => {
          scratch.copyFrom(data);
          lengths.write(count.read(), length);
          offsets.write(count.read(), atSample);
          forSample((i) => {
            for (let page = 0; page < 8; page++) {
              const index = i.add(page * 128);
              observed.write(count.read().mul(1024).add(index), scratch.read(index));
            }
          });
          count.write(count.read().add(1));
        });
      },
    };
  });
}

function outputProbe(capacity: 16 | 32 | 512, maxEntries: number) {
  return defineProcessor(() => {
    const output = event.midi({ to: "main", name: "outbound", capacity });
    const lengths = state.buffer.i32({ size: maxEntries }).named("lengths");
    const offsets = state.buffer.i32({ size: maxEntries }).named("offsets");
    const count = state.i32(0).named("count");
    const sources = Array.from({ length: maxEntries }, (_, i) =>
      state.buffer.u8({ size: 1024 }).named(`source${i}`),
    );
    return {
      process() {
        sources.forEach((data, i) =>
          output.emitIf(count.read().gt(i), {
            type: "sysex",
            data,
            length: lengths.read(i),
            atSample: offsets.read(i),
          }),
        );
      },
    };
  });
}

type Layout = ReturnType<typeof core.extractWorkletMeta>["layout"];
function header(instance: CompileInstance, base: number, seed: number) {
  const result = new Int32Array(instance.memory.buffer, base, 3);
  result.set([seed, seed, 0]);
  return result;
}

function assertWire(memory: ArrayBufferLike, base: number, region: Region, fifo: Fifo) {
  const h = new Int32Array(memory, base, 3);
  expect(Array.from(h)).toEqual(fifo.header());
  expect(region.chunks).toBe(fifo.capacity);
  expect(region.perChunk).toBe(1024);
  const view = new DataView(memory);
  fifo.queue.forEach((entry, i) => {
    const index = ((h[1]! >>> 0) + i) % fifo.capacity;
    const slot = base + 12 + index * 8;
    expect(view.getUint8(slot)).toBe(0xf0);
    expect(view.getUint16(slot + 1, true)).toBe(index);
    expect(view.getUint32(slot + 4, true)).toBe(entry.offset);
    const chunk = region.base + index * 1024;
    expect(view.getUint32(chunk, true)).toBe(entry.length);
    expect(Array.from(new Uint8Array(memory, chunk + 4, entry.length))).toEqual(entry.bytes);
  });
}

function assertObserved(instance: CompileInstance, layout: Layout, entries: Entry[]) {
  const memory = instance.memory.buffer;
  const slots = layout.regions.buffers.slots;
  expect(new Int32Array(memory, layout.regions.states.slots.count!, 1)[0]).toBe(entries.length);
  entries.forEach((entry, i) => {
    expect(new Int32Array(memory, slots.lengths! + i * 4, 1)[0]).toBe(entry.length);
    expect(new Int32Array(memory, slots.offsets! + i * 4, 1)[0]).toBe(entry.offset);
    expect(Array.from(new Uint8Array(memory, slots.observed! + i * 1024, entry.length))).toEqual(
      entry.bytes,
    );
  });
}

function stageOutput(instance: CompileInstance, layout: Layout, entries: Entry[]) {
  const memory = instance.memory.buffer;
  const slots = layout.regions.buffers.slots;
  new Int32Array(memory, layout.regions.states.slots.count!, 1)[0] = entries.length;
  entries.forEach((entry, i) => {
    new Int32Array(memory, slots.lengths! + i * 4, 1)[0] = entry.length;
    new Int32Array(memory, slots.offsets! + i * 4, 1)[0] = entry.offset;
    new Uint8Array(memory, slots[`source${i}`]!, 1024).fill(0x55);
    new Uint8Array(memory, slots[`source${i}`]!, entry.bytes.length).set(entry.bytes);
  });
}

for (const capacity of [16, 32, 512] as const) {
  // The overflow batch follows nine writes; cross each counter while dropping oldest.
  const seeds =
    capacity === 512
      ? [0]
      : [0, -10, -10 - capacity, (0x80000000 - 10) | 0, (0x80000000 - 10 - capacity) | 0];
  for (const seed of seeds) {
    test(
      `SysEx inbound bytes: literal wire / offline injection / FIFO (${capacity}, ${seed})`,
      { timeout: 30_000 },
      async () => {
        const schedule = [
          batch(9, 0),
          [],
          batch(capacity + 3, 2),
          batch(capacity, 4),
          batch(3, 0),
          [],
        ];
        const processor = inputProbe(capacity);
        const compiled = await core.compile(processor);
        const layout = core.extractWorkletMeta(compiled.graph as never).layout;
        const base = layout.regions.midiRings.slots.inbound!.base;
        const region = layout.regions.sysexContent.slots.inbound!;
        const direct = await compiled.driver.instantiate();
        const h = header(direct, base, seed);
        const fifo = new Fifo(capacity, seed);
        for (const entries of schedule) {
          fifo.push(entries);
          h.set(fifo.header());
          const view = new DataView(direct.memory.buffer);
          fifo.queue.forEach((entry, i) => {
            const index = ((h[1]! >>> 0) + i) % capacity;
            const slot = base + 12 + index * 8;
            view.setUint8(slot, 0xf0);
            view.setUint16(slot + 1, index, true);
            view.setUint32(slot + 4, entry.offset, true);
            const chunk = region.base + index * 1024;
            view.setUint32(chunk, entry.length, true);
            new Uint8Array(direct.memory.buffer, chunk + 4, entry.length).set(entry.bytes);
          });
          const expected = fifo.drain();
          new Int32Array(direct.memory.buffer, layout.regions.states.slots.count!, 1)[0] = 0;
          direct.process();
          assertObserved(direct, layout, expected);
          expect(Array.from(h)).toEqual(fifo.header());
        }
        const offlineFifo = new Fifo(capacity, seed);
        const instantiate = compiled.driver.instantiate.bind(compiled.driver);
        let block = 0;
        compiled.driver.instantiate = async () => {
          const instance = await instantiate();
          const offlineHeader = header(instance, base, seed);
          const process = instance.process.bind(instance);
          instance.process = () => {
            offlineFifo.push(schedule[block++]!);
            assertWire(instance.memory.buffer, base, region, offlineFifo);
            const expected = offlineFifo.drain();
            new Int32Array(instance.memory.buffer, layout.regions.states.slots.count!, 1)[0] = 0;
            process();
            assertObserved(instance, layout, expected);
            expect(Array.from(offlineHeader)).toEqual(offlineFifo.header());
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
                name: "inbound",
                atSample: b * 128 + e.offset,
                payload: { type: "sysex", data: new Uint8Array(e.bytes) },
              })),
            ),
          });
          expect(block).toBe(schedule.length);
          expect(result.events).toEqual([]);
          expect(result.diagnostics.droppedSysexMessages).toBe(0);
        } finally {
          spy.mockRestore();
        }
      },
    );

    test(
      `SysEx outbound bytes: WASM emission / offline copies / FIFO (${capacity}, ${seed})`,
      { timeout: 30_000 },
      async () => {
        const invalid = [-1, 1021].map((length) => ({ bytes: [], length, offset: 127 }));
        const schedule = [
          batch(9, 0),
          [],
          batch(capacity + 3, 3),
          [...batch(capacity, 1), ...invalid],
          batch(capacity, 5),
          batch(2, 0),
          [],
        ];
        const processor = outputProbe(capacity, capacity + 3);
        const compiled = await core.compile(processor);
        const layout = core.extractWorkletMeta(compiled.graph as never).layout;
        const base = layout.regions.midiRings.slots.outbound!.base;
        const region = layout.regions.sysexContent.slots.outbound!;
        const direct = await compiled.driver.instantiate();
        const h = header(direct, base, seed);
        const fifo = new Fifo(capacity, seed);
        const expectedEvents: {
          name: string;
          atSample: number;
          payload: { type: string; data: Uint8Array };
        }[] = [];
        for (const entries of schedule) {
          stageOutput(direct, layout, entries);
          fifo.push(entries);
          direct.process();
          assertWire(direct.memory.buffer, base, region, fifo);
          expect(direct.droppedSysexMessages()).toBe(fifo.rejected);
          expectedEvents.push(
            ...fifo.drain().map((e) => ({
              name: "outbound",
              atSample: e.offset,
              payload: { type: "sysex", data: new Uint8Array(e.bytes) },
            })),
          );
          h[1] = h[0]!;
        }
        const offlineFifo = new Fifo(capacity, seed);
        const instantiate = compiled.driver.instantiate.bind(compiled.driver);
        let block = 0;
        let instanceMemory: ArrayBufferLike | undefined;
        compiled.driver.instantiate = async () => {
          const instance = await instantiate();
          instanceMemory = instance.memory.buffer;
          const offlineHeader = header(instance, base, seed);
          const process = instance.process.bind(instance);
          instance.process = () => {
            expect(Array.from(offlineHeader)).toEqual(offlineFifo.header());
            const entries = schedule[block++]!;
            stageOutput(instance, layout, entries);
            offlineFifo.push(entries);
            process();
            assertWire(instance.memory.buffer, base, region, offlineFifo);
            offlineFifo.drain();
          };
          return instance;
        };
        const spy = vi.spyOn(core, "compile").mockResolvedValue(compiled);
        // Bound the public drain too, so broken counters fail rather than hang.
        // eslint-disable-next-line @typescript-eslint/unbound-method -- receiver is forwarded.
        const getUint8 = DataView.prototype.getUint8;
        let reads = 0;
        const readSpy = vi
          .spyOn(DataView.prototype, "getUint8")
          .mockImplementation(function (this: DataView, offset) {
            if (this.buffer === instanceMemory && ++reads > 32 * capacity + 1024)
              throw new Error("unbounded SysEx drain");
            return getUint8.call(this, offset);
          });
        try {
          const result = await renderOffline(processor, {
            sampleRate: 48000,
            duration: (schedule.length * 128) / 48000,
          });
          expect(block).toBe(schedule.length);
          expect(result.events).toEqual(expectedEvents);
          expect(result.diagnostics.droppedSysexMessages).toBe(2);
          // Retained results must own their bytes after all content chunks are reused.
          new Uint8Array(instanceMemory!, region.base, capacity * 1024).fill(0x66);
          expect(result.events).toEqual(expectedEvents);
          for (const e of result.events) {
            const payload = e.payload as { data: Uint8Array };
            expect(payload.data.buffer).not.toBe(instanceMemory);
          }
        } finally {
          readSpy.mockRestore();
          spy.mockRestore();
        }
      },
    );
  }
}
