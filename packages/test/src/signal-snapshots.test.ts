/**
 * Captures WAV snapshots of each signal generator in `@unworklet/test`
 * (sine / silence / impulse / sineSweep / whiteNoise / dc / ramp) for
 * DSP behaviour verification by ear and waveform viewer (`docs/06-testing.md` §3).
 *
 * Complementary to the numeric assertion tests in `index.test.ts`:
 * - Those tests mechanically check individual sample values via `[...buf]` etc. (unit).
 * - This file writes 1 s @ 48 kHz WAV files to `__snapshots__/` and commits them;
 *   a human judges DSP behaviour by ear or waveform viewer.
 *   Any implementation change that alters a WAV causes a bit-exact comparison failure,
 *   routing the change back for human re-evaluation.
 *
 * Note: sine / sineSweep / whiteNoise have amplitude 1 (peak 0 dBFS) — adjust
 * playback volume before listening. silence / dc / ramp are near-silent by ear;
 * verify their shape in a waveform viewer.
 *
 * Each test specifies `opts.snapshotName` explicitly to keep file names clean.
 * The test title is a free-form description of what the test guarantees;
 * snapshotName is the short identifier used as the output filename.
 */

import { test } from "vite-plus/test";

import {
  dc,
  expectAudioMatchesSnapshot,
  impulse,
  ramp,
  silence,
  sine,
  sineSweep,
  whiteNoise,
} from "./index.ts";

const sampleRate = 48000;
const durationSamples = sampleRate; // 1 sec

test("sine generator output (= A4 pure tone / 1s)", async () => {
  await expectAudioMatchesSnapshot(sine({ freqHz: 440, durationSamples, sampleRate }), {
    snapshotName: "sine",
  });
});

test("silence generator output (= all zeros / 1s)", async () => {
  await expectAudioMatchesSnapshot(silence(durationSamples), { snapshotName: "silence" });
});

test("impulse generator output (= atSample 0 / 1s)", async () => {
  await expectAudioMatchesSnapshot(impulse(durationSamples), { snapshotName: "impulse" });
});

test("sineSweep generator output (= 20 Hz → 20 kHz log / 1s)", async () => {
  await expectAudioMatchesSnapshot(
    sineSweep({ startHz: 20, endHz: 20000, durationSamples, sampleRate }),
    { snapshotName: "sineSweep" },
  );
});

test("whiteNoise generator output (= seed-based deterministic / seed 1 / 1s)", async () => {
  await expectAudioMatchesSnapshot(whiteNoise({ durationSamples, seed: 1 }), {
    snapshotName: "whiteNoise",
  });
});

test("dc generator output (= value 1.0 / 1s)", async () => {
  await expectAudioMatchesSnapshot(dc(durationSamples, 1.0), { snapshotName: "dc" });
});

test("ramp generator output (= 0 → 1 linear / 1s)", async () => {
  await expectAudioMatchesSnapshot(ramp({ durationSamples, from: 0, to: 1 }), {
    snapshotName: "ramp",
  });
});
