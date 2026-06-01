/**
 * P5 behavioral anchor — each Tier-B `.uwk.ts` sugar processor must render the
 * SAME audio (sample-for-sample) as its hand-written `.processor.ts` golden. The
 * `.uwk.ts` is lowered by the vite-plugin transform this node test runs through.
 *
 * Behavioral (not byte-identical-WASM) equivalence is the right bar: the full
 * sugar surface (auto-name via `.named()` / `.expose`, bare-state reads,
 * num-removal) may produce a slightly different graph that emits identical audio.
 * That is exactly what the byte-exact snapshots and the browser e2e require.
 *
 * The `.processor.ts` files are kept solely as these golden oracles.
 */
import { renderOffline } from "@unworklet/offline";
import type { RenderOfflineConfig, RenderOfflineResult } from "@unworklet/offline";
import { sine } from "@unworklet/test";
import { expect, test } from "vite-plus/test";

import { crusher as crusherTs } from "./crusher.processor.ts";
import crusherUwk from "./crusher.uwk.ts?worklet";
import { midiSynth as midiTs } from "./midi-synth.processor.ts";
import midiUwk from "./midi-synth.uwk.ts?worklet";
import { noiseDrive as noiseTs } from "./noise-drive.processor.ts";
import noiseUwk from "./noise-drive.uwk.ts?worklet";
import { tapeDelay as tapeTs } from "./tape-delay.processor.ts";
import tapeUwk from "./tape-delay.uwk.ts?worklet";

const SR = 48000;
const N = 256;

function expectSameAudio(a: RenderOfflineResult, b: RenderOfflineResult): void {
  const ca = a.outputs.main![0]!;
  const cb = b.outputs.main![0]!;
  expect(ca.length).toBe(cb.length);
  for (let i = 0; i < ca.length; i++) {
    expect(Object.is(ca[i], cb[i])).toBe(true); // bit-exact sample
  }
}

const withInput: RenderOfflineConfig = {
  sampleRate: SR,
  duration: N / SR,
  inputs: { main: [sine({ freqHz: 1000, durationSamples: N, sampleRate: SR })] },
};
const noInput: RenderOfflineConfig = { sampleRate: SR, duration: N / SR };

const cases = [
  ["crusher", crusherUwk, crusherTs, withInput],
  ["noise-drive", noiseUwk, noiseTs, noInput],
  ["tape-delay", tapeUwk, tapeTs, withInput],
  ["midi-synth", midiUwk, midiTs, noInput],
] as const;

for (const [name, uwk, hand, cfg] of cases) {
  test(`${name}.uwk.ts renders identical audio to ${name}.processor.ts`, async () => {
    const [a, b] = await Promise.all([renderOffline(uwk, cfg), renderOffline(hand, cfg)]);
    expectSameAudio(a, b);
  });
}

// The UW-1 effect knobs work only if the new params actually reach the DSP. Drive
// crusher's `crush` (downsample factor) to two values and assert the audio differs.
test("a knob param drives the audio (crusher `crush` changes the downsampling)", async () => {
  const input = sine({ freqHz: 1000, durationSamples: N, sampleRate: SR });
  const at = (crush: number): RenderOfflineConfig => ({
    sampleRate: SR,
    duration: N / SR,
    inputs: { main: [input] },
    params: { crush: [crush] },
  });
  const [light, heavy] = await Promise.all([
    renderOffline(crusherUwk, at(2)),
    renderOffline(crusherUwk, at(24)),
  ]);
  const a = light.outputs.main![0]!;
  const b = heavy.outputs.main![0]!;
  expect(a.some((s, i) => s !== b[i])).toBe(true);
});
