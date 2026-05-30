/**
 * MIDI wire codec (`11-midi.md` §4.1) — the single source of truth for the
 * 8-byte fixed slot `[status, data1, data2, _pad, atSample:u32]` ↔ the typed
 * `MidiEvent` shape. Shared by the main client (`.send` / `.onEvent`), the
 * worklet runtime template, and the offline renderer so the wire format never
 * drifts between producers and consumers.
 *
 * Sysex (`0xF0`) is variable length and travels through a separate content
 * region (`11-midi.md` §4.3); it is not encoded by this fixed-slot codec.
 */

import type { MidiEvent } from "./types.ts";

/** The three MIDI status/data bytes of a fixed-size (non-sysex) event. */
export type MidiWireBytes = { status: number; data1: number; data2: number };

const STATUS_NIBBLE: Record<string, number> = {
  noteOff: 0x80,
  noteOn: 0x90,
  aftertouch: 0xa0,
  cc: 0xb0,
  programChange: 0xc0,
  channelPressure: 0xd0,
  pitchBend: 0xe0,
};

/** Serialize a (non-sysex) `MidiEvent` to its raw status/data bytes. */
export function midiEventToWire(event: MidiEvent): MidiWireBytes {
  switch (event.type) {
    case "noteOn":
    case "noteOff":
      return {
        status: STATUS_NIBBLE[event.type]! | (event.channel & 0x0f),
        data1: event.note & 0x7f,
        data2: event.velocity & 0x7f,
      };
    case "cc":
      return {
        status: 0xb0 | (event.channel & 0x0f),
        data1: event.controller & 0x7f,
        data2: event.value & 0x7f,
      };
    case "pitchBend":
      return {
        status: 0xe0 | (event.channel & 0x0f),
        data1: event.value & 0x7f,
        data2: (event.value >> 7) & 0x7f,
      };
    case "programChange":
      return { status: 0xc0 | (event.channel & 0x0f), data1: event.program & 0x7f, data2: 0 };
    case "channelPressure":
      return { status: 0xd0 | (event.channel & 0x0f), data1: event.pressure & 0x7f, data2: 0 };
    case "aftertouch":
      return {
        status: 0xa0 | (event.channel & 0x0f),
        data1: event.note & 0x7f,
        data2: event.pressure & 0x7f,
      };
    case "systemRealtime":
      return { status: event.status & 0xff, data1: 0, data2: 0 };
    case "sysex":
      throw new Error("unworklet: sysex events do not use the fixed-slot MIDI wire codec");
  }
}

/** Deserialize raw status/data bytes into a (non-sysex) `MidiEvent`. */
export function wireToMidiEvent(status: number, data1: number, data2: number): MidiEvent {
  const channel = status & 0x0f;
  const hi = status & 0xf0;
  switch (hi) {
    case 0x80:
      return { type: "noteOff", channel, note: data1, velocity: data2 };
    case 0x90:
      return { type: "noteOn", channel, note: data1, velocity: data2 };
    case 0xa0:
      return { type: "aftertouch", channel, note: data1, pressure: data2 };
    case 0xb0:
      return { type: "cc", channel, controller: data1, value: data2 };
    case 0xc0:
      return { type: "programChange", channel, program: data1 };
    case 0xd0:
      return { type: "channelPressure", channel, pressure: data1 };
    case 0xe0:
      return { type: "pitchBend", channel, value: data1 | (data2 << 7) };
    default:
      // 0xF8..0xFF system real-time (the producer masks `& 0xF8 == 0xF8`).
      return { type: "systemRealtime", status };
  }
}
