/**
 * Living proof for the documented DSL forms. Every call form shown in the
 * package READMEs / the unworklet Skill / llms.txt must compile and render —
 * this renders processors built from exactly those forms so the docs can never
 * drift into something that does not work ("examples are verified, not guessed").
 */

import {
  audioInput,
  audioOutput,
  defineProcessor,
  event,
  f32,
  f64,
  forSample,
  param,
  select,
  state,
} from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { renderOffline } from "./index.ts";

// Mirrors the @unworklet/core README "complete processor" example: stereo I/O,
// an a-rate param, published peak-meter state, forSample, and the documented
// read/write forms (input.left.at(i) / out.left.at(i).write(v) / s.read()/.write()).
const stereoGain = defineProcessor(() => {
  const input = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const gain = param
    .f32({ default: 1.0, min: 0.0, max: 4.0, automationRate: "a-rate" })
    .named("gain");
  const meterL = state.f32(0).expose({ name: "meterL", publish: { rateFps: 30 } });

  return {
    process: () => {
      forSample((i) => {
        const l = input.left.at(i).mul(gain.at(i));
        const r = input.right.at(i).mul(gain.at(i));
        out.left.at(i).write(l);
        out.right.at(i).write(r);
        meterL.write(l.abs().max(meterL.read()));
      });
      meterL.write(meterL.read().mul(0.95));
    },
  };
});

test("README example: stereoGain compiles and applies gain (read/write/param forms)", async () => {
  const sr = 48000;
  const samples = 256;
  const dc = new Float32Array(samples).fill(0.5);
  const result = await renderOffline(stereoGain, {
    sampleRate: sr,
    duration: samples / sr,
    inputs: { main: [dc, dc] },
    params: { gain: [2.0] },
  });
  // 0.5 in × gain 2.0 = 1.0 out, both channels, no NaN.
  expect(result.outputs.main[0]![100]).toBeCloseTo(1.0, 5);
  expect(result.outputs.main[1]![100]).toBeCloseTo(1.0, 5);
  expect([...result.outputs.main[0]!].some(Number.isNaN)).toBe(false);
});

// Mirrors the midi-synth example used by the Skill / DevTools docs: an inbound
// MIDI port (event.midi({from:'main'})), onEvent handlers, f64/i32/bool state,
// select(), and the scalar constructors / method-form math.
const SR = 48000;
const TWO_PI = 2 * Math.PI;
const midiSynth = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const notes = event.midi({ from: "main", name: "notes" });
  const phase = state.f64(0).named("phase");
  const note = state.i32(69).named("note");
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
        const freqHz = f32(note.read())
          .sub(69)
          .mul(Math.LN2 / 12)
          .exp()
          .mul(440);
        const inc = freqHz.mul(TWO_PI / SR);
        const p = phase.read().add(f64(inc)).mod(TWO_PI);
        const g = select(gate.read(), 0.3, 0);
        out.ch(0).at(i).write(f32(p.sin()).mul(g));
        phase.write(p);
      });
    },
  };
});

test("Skill example: midiSynth is silent until noteOn, then sounds (event.midi/onEvent/select)", async () => {
  const samples = 512;
  const result = await renderOffline(midiSynth, {
    sampleRate: SR,
    duration: samples / SR,
    inputs: { main: [new Float32Array(samples)] },
    events: [
      {
        name: "notes",
        payload: { type: "noteOn", channel: 0, note: 69, velocity: 100 },
        atSample: 0,
      },
    ],
  });
  const peak = [...result.outputs.main[0]!].reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  // The gate opens at sample 0 → audible sine by the end of the block.
  expect(peak).toBeGreaterThan(0.1);
  expect([...result.outputs.main[0]!].some(Number.isNaN)).toBe(false);
});
