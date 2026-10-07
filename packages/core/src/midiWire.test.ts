import assert from "node:assert/strict";

import { expect, test } from "vite-plus/test";

import { midiEventToWire, wireToMidiEvent } from "./midiWire.ts";
import type { MidiEvent } from "./types.ts";

const channels = Array.from({ length: 16 }, (_, channel) => channel);
const boundaries = [0, 1, 126, 127];

test.each(channels)("pitchBend: all 16384 values preserve exact bytes on channel %i", (channel) => {
  for (let value = 0; value < 16384; value++) {
    const event: MidiEvent = { type: "pitchBend", channel, value };
    const expected = { status: 0xe0 + channel, data1: value % 128, data2: Math.floor(value / 128) };
    assert.deepEqual(midiEventToWire(event), expected);
    assert.deepEqual(wireToMidiEvent(expected.status, expected.data1, expected.data2), event);
  }
});

test.each(channels)(
  "channel messages: 7-bit boundaries preserve exact bytes on channel %i",
  (channel) => {
    for (const first of boundaries) {
      const singleByteEvents: Array<[MidiEvent, number]> = [
        [{ type: "programChange", channel, program: first }, 0xc0],
        [{ type: "channelPressure", channel, pressure: first }, 0xd0],
      ];
      for (const [event, status] of singleByteEvents) {
        const expected = { status: status + channel, data1: first, data2: 0 };
        assert.deepEqual(midiEventToWire(event), expected);
        assert.deepEqual(wireToMidiEvent(expected.status, expected.data1, expected.data2), event);
      }
      for (const second of boundaries) {
        const twoByteEvents: Array<[MidiEvent, number]> = [
          [{ type: "noteOff", channel, note: first, velocity: second }, 0x80],
          [{ type: "noteOn", channel, note: first, velocity: second }, 0x90],
          [{ type: "aftertouch", channel, note: first, pressure: second }, 0xa0],
          [{ type: "cc", channel, controller: first, value: second }, 0xb0],
        ];
        for (const [event, status] of twoByteEvents) {
          const expected = { status: status + channel, data1: first, data2: second };
          assert.deepEqual(midiEventToWire(event), expected);
          assert.deepEqual(wireToMidiEvent(expected.status, expected.data1, expected.data2), event);
        }
      }
    }
  },
);

test.each([0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff])(
  "systemRealtime: status %i preserves exact bytes with zero data",
  (status) => {
    const event: MidiEvent = { type: "systemRealtime", status };
    expect(midiEventToWire(event)).toEqual({ status, data1: 0, data2: 0 });
    expect(wireToMidiEvent(status, 0, 0)).toEqual(event);
  },
);
