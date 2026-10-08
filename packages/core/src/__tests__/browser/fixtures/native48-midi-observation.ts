import { expect } from "vite-plus/test";
import type { MidiEvent } from "../../../types.ts";

export const inputs: MidiEvent[] = [
  { type: "noteOn", channel: 2, note: 60, velocity: 64 },
  { type: "cc", channel: 5, controller: 74, value: 32 },
  { type: "noteOff", channel: 2, note: 60, velocity: 7 },
  { type: "noteOn", channel: 9, note: 67, velocity: 96 },
];
export const offsets = [17, 64, 127, 1];
export const replies: MidiEvent[] = [
  { type: "noteOn", channel: 2, note: 72, velocity: 64 },
  { type: "cc", channel: 5, controller: 74, value: 33 },
  { type: "noteOff", channel: 2, note: 72, velocity: 7 },
  { type: "noteOn", channel: 9, note: 79, velocity: 96 },
];
export const pcmBits = (samples: Float32Array) =>
  Array.from(new Uint32Array(samples.slice().buffer));
export type MidiObservation = {
  pcm: number[];
  packets: { name: string; atSample: number; payload: unknown }[];
  snapshot: number[];
};

// Deliberately independent of production snapshot/MIDI codecs. Preserve every
// persistent byte, including the end of the 128-element last-block buffer.
export function snapshotSlots(raw: number[]) {
  const bytes = Uint8Array.from(raw);
  const view = new DataView(bytes.buffer);
  let cursor = 0;
  const word = () => {
    const value = view.getUint32(cursor, true);
    cursor += 4;
    return value;
  };
  const string = () => {
    const length = word();
    const value = new TextDecoder().decode(bytes.slice(cursor, cursor + length));
    cursor += length;
    return value;
  };
  expect(word()).toBe(0x55574b31);
  expect(word()).toBe(2);
  expect(string()).toMatch(/^[0-9a-f]+$/);
  expect(bytes[cursor++]).toBe(0);
  expect(string()).toBe("");
  expect(bytes[cursor++]).toBe(1);
  expect(string()).toBe("native48-midi");
  const count = word();
  const slots: Record<string, { kind: number; type: number; data: number[]; offset: number }> = {};
  for (let i = 0; i < count; i++) {
    const name = string();
    expect(slots[name]).toBeUndefined();
    const kind = bytes[cursor++]!;
    const type = bytes[cursor++]!;
    const length = word();
    slots[name] = {
      kind,
      type,
      data: Array.from(bytes.slice(cursor, cursor + length)),
      offset: cursor,
    };
    cursor += length;
  }
  expect(cursor).toBe(bytes.length);
  return slots;
}
const bytesOf = (values: number[], float = false) => {
  const buffer = new ArrayBuffer(values.length * 4);
  const view = new DataView(buffer);
  values.forEach((value, i) =>
    float ? view.setFloat32(i * 4, value, true) : view.setInt32(i * 4, value, true),
  );
  return Array.from(new Uint8Array(buffer));
};
export function assertMidiObservation(observed: MidiObservation) {
  expect(observed.pcm).toEqual(
    pcmBits(
      Float32Array.from(
        { length: 512 },
        (_, i) => [0.5, 0.25, 0, 0.75][Math.floor(i / 128)]! + (i % 128) / 1024,
      ),
    ),
  );
  expect(observed.packets).toEqual(
    replies.map((payload, i) => ({ name: "replies", atSample: offsets[i], payload })),
  );
  const slots = snapshotSlots(observed.snapshot);
  const expected = {
    count: { kind: 0, type: 2, data: bytesOf([4]) },
    blocks: { kind: 0, type: 2, data: bytesOf([4]) },
    level: { kind: 0, type: 0, data: bytesOf([0.75], true) },
    history: {
      kind: 2,
      type: 2,
      data: bytesOf([
        144, 2, 60, 64, 17, 176, 5, 74, 32, 64, 128, 2, 60, 7, 127, 144, 9, 67, 96, 1,
      ]),
    },
    last: {
      kind: 2,
      type: 0,
      data: bytesOf(
        Array.from({ length: 128 }, (_, i) => 0.75 + i / 1024),
        true,
      ),
    },
  };
  expect(
    Object.fromEntries(
      Object.entries(slots).map(([name, { kind, type, data }]) => [name, { kind, type, data }]),
    ),
  ).toEqual(expected);
}

export function decodeShortSlot(slot: Uint8Array) {
  const status = slot[0]!;
  const channel = status & 15;
  expect([0x80, 0x90, 0xb0]).toContain(status & 0xf0);
  expect(slot[3]).toBe(0);
  const payload: MidiEvent =
    (status & 0xf0) === 0xb0
      ? { type: "cc", channel, controller: slot[1]!, value: slot[2]! }
      : {
          type: (status & 0xf0) === 0x90 ? "noteOn" : "noteOff",
          channel,
          note: slot[1]!,
          velocity: slot[2]!,
        };
  return {
    name: "replies",
    atSample: new DataView(slot.buffer, slot.byteOffset, 8).getUint32(4, true),
    payload,
  };
}
