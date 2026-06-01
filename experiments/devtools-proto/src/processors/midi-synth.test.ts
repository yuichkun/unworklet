/**
 * End-user simulation (P6) — the RC-20 MIDI synth voice tested with
 * `@unworklet/test`. Web-MIDI `noteOn` opens the gate (audible sine), no event
 * leaves the gate closed (silence). Inbound MIDI is injected via
 * `renderOffline({ events })`. The byte-exact snapshot anchors the `.uwk.ts`
 * rewrite (P5).
 */
import { renderOffline } from "@unworklet/offline";
import { expectAudioMatchesSnapshot, expectSilence, expectStable, midi } from "@unworklet/test";
import { expect, test } from "vite-plus/test";

// `?worklet` consumes the `.uwk.ts` exactly as an app does — the augmented default
// IS the CompiledProcessor renderOffline reads.
import midiSynth from "./midi-synth.uwk.ts?worklet";

const SAMPLE_RATE = 48000;

test("midi-synth: noteOn が無ければ gate=false で無音", async () => {
  const result = await renderOffline(midiSynth, { sampleRate: SAMPLE_RATE, duration: 0.05 });
  expectSilence(result); // default gate=false → gain=0
});

test("midi-synth: noteOn でゲートが開きサイン波が鳴る", async () => {
  const result = await renderOffline(midiSynth, {
    sampleRate: SAMPLE_RATE,
    duration: 0.05,
    events: midi.sequence("notes", [{ at: 0, event: midi.noteOn({ note: 69, velocity: 100 }) }]),
  });
  expectStable(result);
  const ch = result.outputs["main"]![0]!;
  expect(ch.some((s) => Math.abs(s) > 0.05)).toBe(true); // gate open → 可聴なサイン
  await expectAudioMatchesSnapshot(result);
});
