/**
 * MIDI inbound injection + outbound capture through `renderOffline`
 * (`11-midi.md`). Inbound events injected via `config.events` (name = port,
 * `atSample` = absolute sample) reach the worklet handler at the right block;
 * outbound `emitIf` events surface in `result.events` as `MidiEvent` payloads.
 */

import "@unworklet/core";
import {
  audioOutput,
  defineProcessor,
  f32,
  forSample,
  midiInput,
  midiOutput,
  state,
} from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { renderOffline } from "./index.ts";

test("inbound noteOn: handler stores the note, observable in output", async () => {
  const synth = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const midiIn = midiInput({ name: "midiIn" });
    const note = state.i32(0);
    return {
      process: () => {
        midiIn.onEvent("noteOn", ({ note: n }) => {
          note.store(n);
        });
        forSample((i) => {
          out.ch(0).at(i).write(f32(note.load()));
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
    const midiIn = midiInput({ name: "midiIn" });
    const ccVal = state.i32(0);
    const bend = state.i32(0);
    return {
      process: () => {
        midiIn.onEvent("cc", ({ value }) => {
          ccVal.store(value);
        });
        midiIn.onEvent("pitchBend", ({ value }) => {
          bend.store(value);
        });
        forSample((i) => {
          out.ch(0).at(i).write(f32(ccVal.load()));
          out.ch(1).at(i).write(f32(bend.load()));
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
    const midiOut = midiOutput({ name: "midiOut" });
    const counter = state.i32(0);
    return {
      process: () => {
        forSample((i) => {
          out
            .ch(0)
            .at(i)
            .write(0 as never);
          const c = counter.load();
          midiOut.emitIf(c.eq(0), {
            type: "noteOn",
            channel: 2,
            note: 64,
            velocity: 80,
            atSample: i,
          });
          counter.store(c.add(1).mod(128));
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
    const midiOut = midiOutput({ name: "midiOut" });
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
