/**
 * Browser e2e (P1) — proves the BigInt-serialization fix on the real path the
 * user hits when pressing "start audio rack". `createNode(...)` loads each
 * processor's worklet via `audioWorklet.addModule(...)`, which runs
 * `emitWorkletTemplate`. tapeDelay carries an `i64` `sampleCount`, so before the
 * fix that step rejected with "Do not know how to serialize a BigInt", taking
 * the whole rack down. This builds the exact `main.ts` graph in a real headless
 * chromium and renders it.
 *
 * Runs via `vp test --config vite.browser.config.ts` (excluded from the default
 * node-side `vp test`).
 */
import crusher from "./crusher.uwk.ts?worklet";
import midiSynth from "./midi-synth.uwk.ts?worklet";
import noiseDrive from "./noise-drive.uwk.ts?worklet";
import tapeDelay from "./tape-delay.uwk.ts?worklet";
import { createNode } from "@unworklet/core";
import { expect, test } from "vite-plus/test";

const SAMPLE_RATE = 48_000;
const RENDER_FRAMES = 128 * 4; // 4 quanta — enough to prove process() runs

test("devtools-proto rack: 4 processor が全て browser で起動し render が回る (i64 含む、BigInt crash なし)", async () => {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: RENDER_FRAMES,
    sampleRate: SAMPLE_RATE,
  });

  // Each createNode → audioWorklet.addModule(...) → emitWorkletTemplate(...).
  // tapeDelay's i64 `sampleCount` is what crashed the metadata serialization.
  const noise = await createNode(ctx, noiseDrive);
  const delay = await createNode(ctx, tapeDelay);
  const crush = await createNode(ctx, crusher);
  const synth = await createNode(ctx, midiSynth);
  for (const n of [noise, delay, crush, synth]) {
    expect(n.outputs.main).toBeTruthy();
  }

  // Same chain as main.ts: noise → delay → crush → destination; synth in parallel.
  noise.outputs.main!.connect(delay.inputs.main!);
  delay.outputs.main!.connect(crush.inputs.main!);
  crush.outputs.main!.connect(ctx.destination);
  synth.outputs.main!.connect(ctx.destination);

  const rendered = await ctx.startRendering();
  // The worklets really ran on the audio thread and produced finite output.
  expect(rendered.getChannelData(0).every((s) => Number.isFinite(s))).toBe(true);

  for (const n of [noise, delay, crush, synth]) n.dispose();
});
