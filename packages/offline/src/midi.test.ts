/**
 * MIDI inbound injection + outbound capture through `renderOffline`
 * (`11-midi.md`). Inbound events injected via `config.events` (name = port,
 * `atSample` = absolute sample) reach the worklet handler at the right block;
 * outbound `emitIf` events surface in `result.events` as `MidiEvent` payloads.
 */

import "@unworklet/core";
import type { MidiEvent } from "@unworklet/core";
import {
  audioOutput,
  defineProcessor,
  event,
  f32,
  forSample,
  i32,
  state,
  sub,
} from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { renderOffline } from "./index.ts";

test("inbound noteOn: handler stores the note, observable in output", async () => {
  const synth = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const midiIn = event.midi({ from: "main", name: "midiIn" });
    const note = state.i32(0);
    return {
      process: () => {
        midiIn.onEvent("noteOn", ({ note: n }) => {
          note.write(n);
        });
        forSample((i) => {
          out.ch(0).at(i).write(f32(note.read()));
        });
      },
    };
  });
  const result = await renderOffline(synth, {
    sampleRate: 48000,
    duration: 256 / 48000,
    events: [
      {
        name: "midiIn",
        payload: { type: "noteOn", channel: 0, note: 60, velocity: 100 },
        atSample: 0,
      },
      {
        name: "midiIn",
        payload: { type: "noteOn", channel: 0, note: 67, velocity: 100 },
        atSample: 128,
      },
    ],
  });
  // Block 0: note 60 stored at drain → output 60. Block 1: note 67.
  expect(result.outputs.main![0]![0]).toBe(60);
  expect(result.outputs.main![0]![128]).toBe(67);
});

test("inbound cc + pitchBend decode correctly in the handler", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 2, name: "main" });
    const midiIn = event.midi({ from: "main", name: "midiIn" });
    const ccVal = state.i32(0);
    const bend = state.i32(0);
    return {
      process: () => {
        midiIn.onEvent("cc", ({ value }) => {
          ccVal.write(value);
        });
        midiIn.onEvent("pitchBend", ({ value }) => {
          bend.write(value);
        });
        forSample((i) => {
          out.ch(0).at(i).write(f32(ccVal.read()));
          out.ch(1).at(i).write(f32(bend.read()));
        });
      },
    };
  });
  const result = await renderOffline(proc, {
    sampleRate: 48000,
    duration: 128 / 48000,
    events: [
      {
        name: "midiIn",
        payload: { type: "cc", channel: 0, controller: 74, value: 99 },
        atSample: 0,
      },
      { name: "midiIn", payload: { type: "pitchBend", channel: 0, value: 9000 }, atSample: 0 },
    ],
  });
  expect(result.outputs.main![0]![0]).toBe(99);
  expect(result.outputs.main![1]![0]).toBe(9000); // 14-bit value survives lsb/msb split
});

test("outbound noteOn: emitIf surfaces a MidiEvent in result.events", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const midiOut = event.midi({ to: "main", name: "midiOut" });
    const counter = state.i32(0);
    return {
      process: () => {
        forSample((i) => {
          out
            .ch(0)
            .at(i)
            .write(0 as never);
          const c = counter.read();
          midiOut.emitIf(c.eq(0), {
            type: "noteOn",
            channel: 2,
            note: 64,
            velocity: 80,
            atSample: i,
          });
          counter.write(c.add(1).mod(128));
        });
      },
    };
  });
  const result = await renderOffline(proc, { sampleRate: 48000, duration: 128 / 48000 });
  const midi = result.events.filter((e) => e.name === "midiOut");
  expect(midi).toHaveLength(1);
  expect(midi[0]!.payload).toEqual({ type: "noteOn", channel: 2, note: 64, velocity: 80 });
  expect(midi[0]!.atSample).toBe(0);
});

test("outbound emit is sample-accurate via atSample: i", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const midiOut = event.midi({ to: "main", name: "midiOut" });
    return {
      process: () => {
        forSample((i) => {
          out
            .ch(0)
            .at(i)
            .write(0 as never);
          // Emit exactly at sample-offset 40.
          midiOut.emitIf(i.eq(40), {
            type: "noteOff",
            channel: 0,
            note: 60,
            velocity: 0,
            atSample: i,
          });
        });
      },
    };
  });
  const result = await renderOffline(proc, { sampleRate: 48000, duration: 128 / 48000 });
  const midi = result.events.filter((e) => e.name === "midiOut");
  expect(midi).toHaveLength(1);
  expect(midi[0]!.atSample).toBe(40);
  expect(midi[0]!.payload).toEqual({ type: "noteOff", channel: 0, note: 60, velocity: 0 });
});

test("event<T> emit inside a MIDI handler does not corrupt the drain (Ex8-style)", async () => {
  // A noteOn handler emits a generic event<T> AND the drain keeps walking — the
  // emit reuses the drain's head/slot locals, so the loop must re-read head.
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const keys = event.midi({ from: "main", name: "keys" });
    const notePlayed = event<{ note: number }>({ to: "main", name: "notePlayed" });
    const last = state.i32(0);
    return {
      process: () => {
        keys.onEvent("noteOn", ({ note, atSample }) => {
          last.write(note);
          notePlayed.emitIf(true, { atSample, note });
        });
        forSample((i) => {
          out.ch(0).at(i).write(f32(last.read()));
        });
      },
    };
  });
  // Two noteOn in one block → both handlers must run (drain not broken by emit).
  const result = await renderOffline(proc, {
    sampleRate: 48000,
    duration: 128 / 48000,
    events: [
      { name: "keys", payload: { type: "noteOn", channel: 0, note: 60, velocity: 1 }, atSample: 0 },
      {
        name: "keys",
        payload: { type: "noteOn", channel: 0, note: 64, velocity: 1 },
        atSample: 10,
      },
    ],
  });
  const played = result.events.filter((e) => e.name === "notePlayed");
  expect(played).toHaveLength(2);
  expect(played.map((e) => (e.payload as { note: number }).note)).toEqual([60, 64]);
  expect(result.outputs.main![0]![0]).toBe(64); // last note wins
});

test("sysex bridge: ingest, rewrite device-id byte, re-emit (Ex9-style)", async () => {
  const MAX_SYSEX_LEN = 64;
  const bridge = defineProcessor(() => {
    const sysexIn = event.midi({ from: "main", name: "sysexIn" });
    const sysexOut = event.midi({ to: "main", name: "sysexOut" });
    const buf = state.buffer.u8({ size: MAX_SYSEX_LEN });
    const targetId = state.i32(0x42);
    return {
      process: () => {
        sysexIn.onEvent("sysex", ({ data, length, atSample }) => {
          buf.copyFrom(data);
          buf.write(i32(1), targetId.read()); // rewrite byte 1 = device ID
          sysexOut.emitIf(true, { type: "sysex", data: buf, length, atSample });
        });
      },
    };
  });
  const inputSysex = new Uint8Array([0xf0, 0x10, 0x01, 0x02, 0x03, 0xf7]);
  const result = await renderOffline(bridge, {
    sampleRate: 48000,
    duration: 128 / 48000,
    events: [{ name: "sysexIn", payload: { type: "sysex", data: inputSysex }, atSample: 0 }],
  });
  const out = result.events.filter((e) => e.name === "sysexOut");
  expect(out).toHaveLength(1);
  const ev = out[0]!.payload as Extract<MidiEvent, { type: "sysex" }>;
  expect(ev.type).toBe("sysex");
  // byte 1 rewritten to 0x42, length preserved, rest unchanged.
  expect(Array.from(ev.data)).toEqual([0xf0, 0x42, 0x01, 0x02, 0x03, 0xf7]);
});

test("offline drops a sysex event sent to a port with no sysex region (no crash)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const midiIn = event.midi({ from: "main", name: "midiIn" }); // note-only, no sysex handler
    const note = state.i32(0);
    return {
      process: () => {
        midiIn.onEvent("noteOn", ({ note: n }) => {
          note.write(n);
        });
        forSample((i) => {
          out.ch(0).at(i).write(f32(note.read()));
        });
      },
    };
  });
  // Inject a sysex into the note-only port — it has no sysex content region. The
  // event must be dropped, not crash on a `port.sysex!` deref.
  const r = await renderOffline(proc, {
    sampleRate: 48000,
    duration: 128 / 48000,
    events: [
      {
        name: "midiIn",
        payload: { type: "sysex", data: new Uint8Array([0xf0, 0x7e, 0xf7]) },
        atSample: 0,
      },
    ],
  });
  expect(r.outputs.main![0]![0]).toBe(0); // no note delivered, default state
});

test("sysex emit with a runtime-negative length clamps to 0 instead of trapping (memory.copy safety)", async () => {
  // A user-computed `length` that goes negative used to flow through a signed
  // min into `memory.copy`, where it reads as a ~4 GiB unsigned size — an OOB
  // trap that latches permanent silence. The clamp floors it at 0: the event
  // still fires, carrying an empty payload.
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const sysexIn = event.midi({ from: "main", name: "sysexIn" });
    const sysexOut = event.midi({ to: "main", name: "sysexOut" });
    const buf = state.buffer.u8({ size: 16 });
    return {
      process: () => {
        sysexIn.onEvent("sysex", ({ data, length, atSample }) => {
          buf.copyFrom(data);
          // length - 1000: negative for any real-world sysex in this test.
          sysexOut.emitIf(true, { type: "sysex", data: buf, length: sub(length, 1000), atSample });
        });
        forSample((i) => {
          out.ch(0).at(i).write(0);
        });
      },
    };
  });
  const result = await renderOffline(proc, {
    sampleRate: 48000,
    duration: 128 / 48000,
    events: [
      {
        name: "sysexIn",
        payload: { type: "sysex", data: new Uint8Array([0xf0, 0x10, 0xf7]) },
        atSample: 0,
      },
    ],
  });
  const outEvents = result.events.filter((e) => e.name === "sysexOut");
  expect(outEvents).toHaveLength(1);
  const ev = outEvents[0]!.payload as Extract<MidiEvent, { type: "sysex" }>;
  expect(ev.type).toBe("sysex");
  expect(ev.data.length).toBe(0);
});
