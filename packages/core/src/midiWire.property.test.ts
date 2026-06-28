/**
 * Layer C — property/fuzz over the MIDI wire codec.
 *
 * The fixed-slot MIDI codec (`midiEventToWire` / `wireToMidiEvent`) is on the
 * hot path of every MIDI in/out ring. Two properties, checked over thousands of
 * randomized inputs (fast-check shrinks any failure to a minimal case), pin its
 * correctness far past the handful of hand-picked examples a unit test covers:
 *
 *   1. round-trip identity — every valid (in-range) non-sysex event survives
 *      encode → decode unchanged;
 *   2. wire validity — every encode emits a status byte with its high bit set
 *      and two 7-bit data bytes (a well-formed MIDI message).
 */

import fc from "fast-check";
import { expect, test } from "vite-plus/test";

import { midiEventToWire, wireToMidiEvent } from "./midiWire.ts";
import type { MidiEvent } from "./types.ts";

const channel = fc.integer({ min: 0, max: 15 });
const u7 = fc.integer({ min: 0, max: 127 });
const u14 = fc.integer({ min: 0, max: 16383 });

// Non-sysex events with every field in the range the codec preserves losslessly.
const midiEventArb = fc.oneof(
  fc.record({ type: fc.constant("noteOn" as const), channel, note: u7, velocity: u7 }),
  fc.record({ type: fc.constant("noteOff" as const), channel, note: u7, velocity: u7 }),
  fc.record({ type: fc.constant("cc" as const), channel, controller: u7, value: u7 }),
  fc.record({ type: fc.constant("pitchBend" as const), channel, value: u14 }),
  fc.record({ type: fc.constant("programChange" as const), channel, program: u7 }),
  fc.record({ type: fc.constant("channelPressure" as const), channel, pressure: u7 }),
  fc.record({ type: fc.constant("aftertouch" as const), channel, note: u7, pressure: u7 }),
  fc.record({
    type: fc.constant("systemRealtime" as const),
    status: fc.integer({ min: 0xf8, max: 0xff }),
  }),
) as fc.Arbitrary<MidiEvent>;

test("midi wire codec round-trips every valid non-sysex event", () => {
  fc.assert(
    fc.property(midiEventArb, (event) => {
      const wire = midiEventToWire(event);
      expect(wireToMidiEvent(wire.status, wire.data1, wire.data2)).toEqual(event);
    }),
  );
});

test("midi wire codec always emits a valid status + two 7-bit data bytes", () => {
  fc.assert(
    fc.property(midiEventArb, (event) => {
      const { status, data1, data2 } = midiEventToWire(event);
      expect(status & 0x80).toBe(0x80); // a status byte, high bit set
      expect(status).toBeLessThanOrEqual(0xff);
      expect(data1).toBeGreaterThanOrEqual(0);
      expect(data1).toBeLessThanOrEqual(0x7f);
      expect(data2).toBeGreaterThanOrEqual(0);
      expect(data2).toBeLessThanOrEqual(0x7f);
    }),
  );
});
