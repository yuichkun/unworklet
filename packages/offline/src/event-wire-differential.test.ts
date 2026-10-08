import * as core from "@unworklet/core";
import {
  bool,
  compile,
  decodeSnapshot,
  defineProcessor,
  event,
  extractWorkletMeta,
  f32,
  f64,
  forSample,
  state,
} from "@unworklet/core";
import { expect, test, vi } from "vite-plus/test";

import { renderOffline } from "./index.ts";

const CAPACITY = 16;
const COUNTS = [0, 16, 19, 2, 0, 17];
// The 19-packet burst follows 16 drained packets: de crosses head on its second
// eviction; ee crosses tail on its second eviction. fe crosses while filling.
const SEEDS = [0, 0x7ffffffe, 0xfffffffe, 0x7fffffde, 0xffffffde, 0x7fffffee, 0xffffffee];
type Kind = "f32" | "u8" | "f64";
type Packet = { id: number; flag: boolean; gain: number; samples: number[]; atSample: number };

// The corpus intentionally has one variable field. Inbound payload proxies support f32 only.
function packet(block: number, index: number, kind: Kind): Packet {
  const id = block * 32 + index;
  return {
    id,
    flag: id % 2 === 1,
    gain: id + 0.25,
    samples: Array.from({ length: id % 4 }, (_, k) =>
      kind === "u8" ? (id * 3 + k) % 256 : id * 3 + k + 0.5,
    ),
    atSample: index,
  };
}

function fifo(packets: Packet[]) {
  const retained: Packet[] = [];
  let dropped = 0;
  for (const value of packets) {
    if (retained.length === CAPACITY) {
      retained.shift();
      dropped++;
    }
    retained.push(value);
  }
  return { retained, dropped };
}

function corpus(block: number, kind: Kind) {
  return Array.from({ length: COUNTS[block]! }, (_, i) => packet(block, i, kind));
}

function payloadBytes(samples: number[], kind: Kind) {
  const bytes = new Uint8Array(samples.length * (kind === "f64" ? 8 : kind === "f32" ? 4 : 1));
  const view = new DataView(bytes.buffer);
  samples.forEach((value, i) => {
    if (kind === "f64") view.setFloat64(i * 8, value, true);
    else if (kind === "f32") view.setFloat32(i * 4, value, true);
    else view.setUint8(i, value);
  });
  return bytes;
}

// Literal field offsets are independent of production layout/codec helpers.
function wire(value: Packet, slot: number, outbound: boolean, chunk: number, kind: Kind) {
  const bytes = new Uint8Array(outbound ? 24 : 20);
  const view = new DataView(bytes.buffer);
  const start = outbound ? 4 : 0;
  if (outbound) view.setInt32(0, value.atSample, true);
  view.setFloat32(start, value.gain, true);
  view.setInt32(outbound ? 16 : 4, payloadBytes(value.samples, kind).length, true);
  view.setInt32(outbound ? 20 : 8, slot * chunk, true);
  if (outbound) view.setInt32(8, Number(value.flag), true);
  else view.setFloat32(start + 12, Number(value.flag), true);
  if (outbound) view.setInt32(12, value.id, true);
  else view.setFloat32(16, value.id, true);
  return bytes;
}

type Compiled = Awaited<ReturnType<typeof compile>>;
function locations(compiled: Compiled, outbound: boolean, kind: Kind) {
  const layout = extractWorkletMeta(compiled.graph as never).layout;
  const ring = (outbound ? layout.regions.eventRings : layout.regions.messageRings).slots.wire!;
  const content = (
    outbound ? layout.regions.payloadContent.eventSlots : layout.regions.payloadContent.messageSlots
  ).wire!;
  const start = outbound ? 4 : 0;
  expect(ring.capacity).toBe(16);
  expect(ring.slotSize).toBe(outbound ? 24 : 20);
  expect(
    ring.fields.map(({ name, offsetInSlot, byteSize, wireType, payloadElementType }) => [
      name,
      offsetInSlot,
      byteSize,
      wireType,
      payloadElementType,
    ]),
  ).toEqual([
    ...(outbound ? [["atSample", 0, 4, "i32", undefined]] : []),
    ["gain", start, 4, "f32", undefined],
    ...(outbound
      ? [
          ["flag", 8, 4, "bool", undefined],
          ["id", 12, 4, "i32", undefined],
          ["samples", 16, 8, "i32", kind],
        ]
      : [
          ["samples", 4, 8, "i32", kind],
          ["flag", 12, 4, "f32", undefined],
          ["id", 16, 4, "f32", undefined],
        ]),
  ]);
  const chunk = kind === "f64" ? 24 : kind === "f32" ? 12 : 4;
  expect(content.chunks).toBe(16);
  expect(content.capacity).toBe(chunk * 16);
  expect(content.base % (kind === "f64" ? 8 : 4)).toBe(0);
  return { ring, content, chunk, layout };
}

function assertWire(
  memory: ArrayBufferLike,
  position: ReturnType<typeof locations>,
  packets: Packet[],
  head: number,
  outbound: boolean,
  kind: Kind,
) {
  const { ring, content, chunk } = position;
  const retained = fifo(packets).retained;
  for (let i = 0; i < retained.length; i++) {
    const slot = ((head - retained.length + i) >>> 0) % 16;
    expect(
      Array.from(
        new Uint8Array(memory, ring.base + 12 + slot * (outbound ? 24 : 20), outbound ? 24 : 20),
      ),
    ).toEqual(Array.from(wire(retained[i]!, slot, outbound, chunk, kind)));
    const expected = payloadBytes(retained[i]!.samples, kind);
    expect(
      Array.from(new Uint8Array(memory, content.base + slot * chunk, expected.length)),
    ).toEqual(Array.from(expected));
  }
}

function ingressProcessor() {
  return defineProcessor(() => {
    const input = event<{ gain: number; samples: Float32Array; flag: boolean; id: number }>({
      from: "main",
      name: "wire",
      capacity: 16,
      payloadCapacity: 11,
    });
    const received = state.buffer
      .f32({ size: 512 })
      .expose({ name: "received", snapshot: "persistent" });
    const count = state.i32(0).expose({ name: "count", snapshot: "persistent" });
    return {
      process() {
        input.onReceive(({ gain, samples, flag, id }) => {
          const offset = count.read().mul(7);
          received.write(offset, id);
          received.write(offset.add(1), f32(flag));
          received.write(offset.add(2), gain);
          received.write(offset.add(3), f32(samples.length));
          for (let k = 0; k < 3; k++) received.write(offset.add(k + 4), samples.at(k));
          count.write(count.read().add(1));
        });
      },
    };
  });
}

function observedRows(packets: Packet[]) {
  return packets.flatMap((p) => [
    p.id,
    Number(p.flag),
    p.gain,
    p.samples.length,
    ...Array.from({ length: 3 }, (_, k) => p.samples[Math.min(k, p.samples.length - 1)] ?? 0),
  ]);
}

for (const seed of SEEDS) {
  test(`literal inbound wire, WASM dispatch and offline injection agree at counter ${seed}`, async () => {
    const processor = ingressProcessor();
    const compiled = await compile(processor);
    const position = locations(compiled, false, "f32");
    const direct = await compiled.driver.instantiate();
    const header = new Int32Array(direct.memory.buffer, position.ring.base, 3);
    header.set([seed, seed, 0]);
    let head = seed;
    let dropped = 0;
    const expected: Packet[] = [];
    for (let block = 0; block < COUNTS.length; block++) {
      const packets = corpus(block, "f32");
      const model = fifo(packets);
      dropped += model.dropped;
      for (const p of packets) {
        const slot = (head >>> 0) % 16;
        new Uint8Array(direct.memory.buffer, position.ring.base + 12 + slot * 20, 20).set(
          wire(p, slot, false, 12, "f32"),
        );
        new Uint8Array(
          direct.memory.buffer,
          position.content.base + slot * 12,
          p.samples.length * 4,
        ).set(payloadBytes(p.samples, "f32"));
        head = (head + 1) >>> 0;
      }
      header.set([head, (head - model.retained.length) >>> 0, dropped]);
      direct.process();
      expected.push(...model.retained);
      expect(Array.from(header)).toEqual([head | 0, head | 0, dropped]);
      expect(
        new DataView(direct.memory.buffer).getInt32(
          position.layout.regions.states.slots.count!,
          true,
        ),
      ).toBe(expected.length);
      expect(
        Array.from(
          new Float32Array(
            direct.memory.buffer,
            position.layout.regions.buffers.slots.received!,
            expected.length * 7,
          ),
        ),
      ).toEqual(observedRows(expected));
    }
    const originalCompile = core.compile;
    let quantum = 0;
    let offlineHead = seed;
    let offlineDropped = 0;
    const spy = vi.spyOn(core, "compile").mockImplementation(async (value, options) => {
      const built = await originalCompile(value, options);
      const p = locations(built, false, "f32");
      const instantiate = built.driver.instantiate.bind(built.driver);
      built.driver.instantiate = async () => {
        const instance = await instantiate();
        const h = new Int32Array(instance.memory.buffer, p.ring.base, 3);
        h.set([seed, seed, 0]);
        const process = instance.process.bind(instance);
        instance.process = () => {
          expect(quantum).toBeLessThan(COUNTS.length);
          const packets = corpus(quantum++, "f32");
          const model = fifo(packets);
          offlineHead = (offlineHead + packets.length) >>> 0;
          offlineDropped += model.dropped;
          expect(Array.from(h)).toEqual([
            offlineHead | 0,
            (offlineHead - model.retained.length) | 0,
            offlineDropped,
          ]);
          assertWire(instance.memory.buffer, p, packets, offlineHead, false, "f32");
          process();
          expect(Array.from(h)).toEqual([offlineHead | 0, offlineHead | 0, offlineDropped]);
        };
        return instance;
      };
      return built;
    });
    try {
      const rendered = await renderOffline(processor, {
        sampleRate: 48000,
        duration: (COUNTS.length * 128) / 48000,
        messages: COUNTS.flatMap((_, block) =>
          corpus(block, "f32").map((p) => ({
            name: "wire",
            atQuantum: block,
            payload: { gain: p.gain, samples: new Float32Array(p.samples), flag: p.flag, id: p.id },
          })),
        ),
      });
      expect(quantum).toBe(COUNTS.length);
      const slots = decodeSnapshot(rendered.state).slots;
      const received = slots.find((s) => s.name === "received")!.data;
      expect(
        Array.from(new Float32Array(received.buffer, received.byteOffset, expected.length * 7)),
      ).toEqual(observedRows(expected));
      const count = slots.find((s) => s.name === "count")!.data;
      expect(new DataView(count.buffer, count.byteOffset, count.byteLength).getInt32(0, true)).toBe(
        expected.length,
      );
    } finally {
      spy.mockRestore();
    }
  });
}

function egressProcessor(kind: Kind) {
  return defineProcessor(() => {
    const samples = state.buffer[kind]({ size: 3 });
    const block = state.i32(0);
    const output = event<{
      gain: number;
      samples: typeof samples;
      flag: boolean;
      id: number;
      length: number;
    }>({
      to: "main",
      name: "wire",
      capacity: 16,
      payloadCapacity: kind === "f64" ? 17 : kind === "f32" ? 11 : 3,
    });
    return {
      process() {
        forSample((i) => {
          const id = block.read().mul(32).add(i);
          for (let k = 0; k < 3; k++) {
            const value = id.mul(3).add(k);
            if (kind === "f64")
              (samples as ReturnType<typeof state.buffer.f64>).write(k, f64(value).add(0.5));
            else if (kind === "f32")
              (samples as ReturnType<typeof state.buffer.f32>).write(k, f32(value).add(0.5));
            else (samples as ReturnType<typeof state.buffer.u8>).write(k, value);
          }
          for (let q = 0; q < COUNTS.length; q++) {
            const payload = {
              gain: f32(id).add(0.25),
              samples,
              flag: bool(id.mod(2)),
              id,
              length: id.mod(4),
              atSample: i,
            };
            output.emitIf(
              block.read().eq(q).and(i.lt(COUNTS[q]!)),
              q % 2 === 0
                ? payload
                : {
                    id: payload.id,
                    flag: payload.flag,
                    samples: payload.samples,
                    gain: payload.gain,
                    length: payload.length,
                    atSample: payload.atSample,
                  },
            );
          }
        });
        block.write(block.read().add(1));
      },
    };
  });
}

for (const kind of ["f32", "u8", "f64"] as const)
  for (const seed of SEEDS) {
    test(`literal ${kind} emission bytes and independent FIFO match offline events at counter ${seed}`, async () => {
      const processor = egressProcessor(kind);
      const compiled = await compile(processor);
      const position = locations(compiled, true, kind);
      const instance = await compiled.driver.instantiate();
      const header = new Int32Array(instance.memory.buffer, position.ring.base, 3);
      header.set([seed, seed, 0]);
      let head = seed;
      let dropped = 0;
      const expected: Packet[] = [];
      for (let block = 0; block < COUNTS.length; block++) {
        const packets = corpus(block, kind);
        const model = fifo(packets);
        instance.process();
        head = (head + packets.length) >>> 0;
        dropped += model.dropped;
        expect(Array.from(header)).toEqual([head | 0, (head - model.retained.length) | 0, dropped]);
        assertWire(instance.memory.buffer, position, packets, head, true, kind);
        expected.push(...model.retained);
        header[1] = header[0]!;
      }
      const originalCompile = core.compile;
      let offlineHeader: Int32Array | undefined;
      const spy = vi.spyOn(core, "compile").mockImplementation(async (value, options) => {
        const built = await originalCompile(value, options);
        const p = locations(built, true, kind);
        const instantiate = built.driver.instantiate.bind(built.driver);
        built.driver.instantiate = async () => {
          const result = await instantiate();
          offlineHeader = new Int32Array(result.memory.buffer, p.ring.base, 3);
          offlineHeader.set([seed, seed, 0]);
          return result;
        };
        return built;
      });
      try {
        const result = await renderOffline(processor, {
          sampleRate: 48000,
          duration: (COUNTS.length * 128) / 48000,
        });
        expect(result.events).toEqual(
          expected.map((p) => ({
            name: "wire",
            atSample: p.atSample,
            payload: {
              gain: p.gain,
              samples:
                kind === "f64"
                  ? new Float64Array(p.samples)
                  : kind === "f32"
                    ? new Float32Array(p.samples)
                    : new Uint8Array(p.samples),
              flag: p.flag,
              id: p.id,
            },
          })),
        );
        expect(Array.from(offlineHeader!)).toEqual([head | 0, head | 0, dropped]);
      } finally {
        spy.mockRestore();
      }
    });
  }
