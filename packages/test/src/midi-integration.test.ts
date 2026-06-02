/**
 * End-to-end: the MIDI matchers (`expectMidiOut` / `expectMidiBalance`) read the
 * `result.events` that `renderOffline` now produces for `midiOutput` ports. This
 * confirms the matcher ↔ renderer wire-up the spec describes (`06-testing.md`
 * §2.4) works against real rendered output, not just hand-built fixtures.
 */

import "@unworklet/core";
import { defineProcessor, event, state } from "@unworklet/core";
import { renderOffline } from "@unworklet/offline";
import { expect, test } from "vite-plus/test";

import { expectMidiBalance, expectMidiOut, midi } from "./index.ts";

// A minimal note thru: each inbound noteOn / noteOff is re-emitted on the out
// port (transposed up an octave), so the rendered result carries real MIDI.
// Pure-MIDI processor — no audio I/O.
const noteThru = defineProcessor(() => {
  const inPort = event.midi({ from: "main", name: "in" });
  const outPort = event.midi({ to: "main", name: "out" });
  const note = state.i32(0);
  const vel = state.i32(0);
  const gateOn = state.bool(false);
  const gateOff = state.bool(false);
  const onAt = state.i32(-1);
  const offAt = state.i32(-1);
  return {
    process: () => {
      inPort.onEvent("noteOn", ({ note: n, velocity, atSample }) => {
        note.write(n);
        vel.write(velocity);
        gateOn.write(true);
        onAt.write(atSample);
      });
      inPort.onEvent("noteOff", ({ note: n, atSample }) => {
        note.write(n);
        gateOff.write(true);
        offAt.write(atSample);
      });
      outPort.emitIf(gateOn.read(), {
        type: "noteOn",
        channel: 0,
        note: note.read().add(12),
        velocity: vel.read(),
        atSample: onAt.read(),
      });
      outPort.emitIf(gateOff.read(), {
        type: "noteOff",
        channel: 0,
        note: note.read().add(12),
        velocity: 0,
        atSample: offAt.read(),
      });
      // Reset the one-shot gates so each inbound event re-emits exactly once.
      gateOn.write(false);
      gateOff.write(false);
    },
  };
});

test("expectMidiOut matches the re-emitted notes from a real render", async () => {
  const result = await renderOffline(noteThru, {
    sampleRate: 48000,
    duration: 256 / 48000,
    events: [
      ...midi.sequence("in", [
        { at: 0, event: midi.noteOn({ note: 60, velocity: 100 }) },
        { at: 128, event: midi.noteOff({ note: 60 }) },
      ]),
    ],
  });
  // atSample is block-local (B7): the noteOff fires in block 1 at block-local
  // sample 0, not absolute 128 — matching the online worklet→main value.
  expectMidiOut(result, "out", [
    { type: "noteOn", channel: 0, note: 72, velocity: 100, atSample: 0 },
    { type: "noteOff", channel: 0, note: 72, velocity: 0, atSample: 0 },
  ]);
});

test("expectMidiBalance accepts a balanced noteOn/noteOff pair", async () => {
  const result = await renderOffline(noteThru, {
    sampleRate: 48000,
    duration: 256 / 48000,
    events: [
      ...midi.sequence("in", [
        { at: 0, event: midi.noteOn({ note: 64, velocity: 80 }) },
        { at: 128, event: midi.noteOff({ note: 64 }) },
      ]),
    ],
  });
  expectMidiBalance(result, "out");
});

test("expectMidiBalance flags a hanging note (noteOn with no noteOff)", async () => {
  const result = await renderOffline(noteThru, {
    sampleRate: 48000,
    duration: 128 / 48000,
    events: [...midi.sequence("in", [{ at: 0, event: midi.noteOn({ note: 64, velocity: 80 }) }])],
  });
  expect(() => expectMidiBalance(result, "out")).toThrow();
});
