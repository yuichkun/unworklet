/**
 * RC-20-style supply module — MIDI synth voice.
 *
 * A monophonic sine voice driven by Web MIDI: `noteOn` latches the note and
 * opens the gate, `noteOff` closes it. The oscillator phase is accumulated at
 * `f64` precision so long-held notes do not drift. Covers `f64` (phase), `i32`
 * (note), `bool` (gate), and the `event.midi({ from: 'main' })` inbound port —
 * feeding both the audio graph and the dev-dump.
 */

import {
  audioOutput,
  defineProcessor,
  event,
  f32,
  f64,
  forSample,
  select,
  state,
} from "@unworklet/core";

const SAMPLE_RATE = 48000;
const TWO_PI = 2 * Math.PI;
const PHASE_INC_PER_HZ = TWO_PI / SAMPLE_RATE;
const LN2_OVER_12 = Math.LN2 / 12;

export const midiSynth = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const notes = event.midi({ from: "main", name: "notes" });

  const phase = state.f64(0).named("phase");
  const note = state.i32(69).named("note"); // default A4
  const gate = state.bool(false).named("gate");

  return {
    process: () => {
      notes.onEvent("noteOn", ({ note: n }) => {
        note.write(n);
        gate.write(true);
      });
      notes.onEvent("noteOff", () => {
        gate.write(false);
      });

      forSample((i) => {
        // note → Hz via equal temperament: 440 * 2^((note-69)/12).
        const freqHz = f32(note.read()).sub(69).mul(LN2_OVER_12).exp().mul(440);
        const inc = freqHz.mul(PHASE_INC_PER_HZ);
        const p = phase.read().add(f64(inc)).mod(TWO_PI);
        const gain = select(gate.read(), 0.3, 0);
        out.ch(0).at(i).write(f32(p.sin()).mul(gain));
        phase.write(p);
      });
    },
  };
});
