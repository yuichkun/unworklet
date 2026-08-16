/**
 * Wav-snapshot regression pin for `noiseSource(...)`. The primitive is a
 * declared xorshift32 PRNG (`.next()` per call advances the internal state),
 * fully deterministic across renders: same seed → same output byte-for-byte,
 * every time. That makes `toMatchAudioSnapshot` a bit-exact safety net that
 * catches any accidental drift in either the PRNG algorithm or the emit path.
 *
 * Two snapshots cover the two failure axes:
 *
 * - `noise-seed-42` — explicit seed 42, mono. A change breaks only if the hash
 *   / xorshift emit itself drifts.
 * - `noise-stereo-auto` — two `noiseSource()` declarations with auto seeds
 *   (`{ seed: 1 }`, `{ seed: 2 }`). A change breaks if either the hash drifts
 *   OR the declaration-order → auto-seed mapping changes.
 *
 * On first run the matcher writes the wav under `__snapshots__/`; on every
 * subsequent run it does a bit-exact compare. Deterministic → never flaky.
 * Delete the wav to intentionally re-baseline.
 *
 * Snapshot length is 1 second at 48 kHz (matches the existing dc.wav /
 * impulse.wav pattern) so the wav is playable — a human listener can confirm
 * the output is broadband white noise (not pitched / repeating).
 */

import "./extend.ts";

import { audioOutput, defineProcessor, forSample, mul, noiseSource } from "@unworklet/core";
import { renderOffline } from "@unworklet/offline";
import { expect, test } from "vite-plus/test";

const SR = 48000;
const SAMPLES = SR; // 1 second — listen-friendly
const AMP = 0.3; // safe listening amplitude

const noiseSeed42 = defineProcessor(() => {
  const n = noiseSource({ seed: 42 });
  const out = audioOutput({ channels: 1, name: "main" });
  return {
    process: () => {
      forSample((i) => {
        out.ch(0).at(i).write(mul(n.next(), AMP));
      });
    },
  };
});

const noiseStereoAuto = defineProcessor(() => {
  const nL = noiseSource(); // auto seed = 1
  const nR = noiseSource(); // auto seed = 2
  const out = audioOutput({ channels: 2, name: "main" });
  return {
    process: () => {
      forSample((i) => {
        out.left.at(i).write(mul(nL.next(), AMP));
        out.right.at(i).write(mul(nR.next(), AMP));
      });
    },
  };
});

test("noiseSource({ seed: 42 }) matches its wav snapshot (pins the xorshift32 emit)", async () => {
  const result = await renderOffline(noiseSeed42, {
    sampleRate: SR,
    duration: SAMPLES / SR,
  });
  await expect(result).toMatchAudioSnapshot({ snapshotName: "noise-seed-42" });
});

test("stereo auto-seed noiseSource() matches its wav snapshot (pins hash + auto-seed order)", async () => {
  const result = await renderOffline(noiseStereoAuto, {
    sampleRate: SR,
    duration: SAMPLES / SR,
  });
  await expect(result).toMatchAudioSnapshot({ snapshotName: "noise-stereo-auto" });
});
