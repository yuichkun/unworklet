/**
 * Phase 3 acceptance smoke = canonical Ex 1 minus meter (= stereo gain) が
 * `renderOffline` で end-to-end で 動 く + input × gain が output に bit-exact
 * で 反 映 さ れ る こ と を 担 保 (= `13-offline-render.md` §3 deterministic
 * 保 証、 tolerance 0)。 plan Step 3.7 完 了 条 件。
 */

import { SAMPLES_PER_BLOCK } from "@unworklet/core";
import { renderOffline } from "@unworklet/offline";
import { expectAudioMatchesSnapshot, sine } from "@unworklet/test";
import { expect, test } from "vite-plus/test";

import { stereoGain } from "./processor.ts";

test("stereo gain renders input × gain bit-exact (= k-rate gain broadcast)", async () => {
  const inputCh0 = new Float32Array(SAMPLES_PER_BLOCK);
  const inputCh1 = new Float32Array(SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    inputCh0[i] = i / SAMPLES_PER_BLOCK;
    inputCh1[i] = 1 - i / SAMPLES_PER_BLOCK;
  }
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    inputs: { main: [inputCh0, inputCh1] },
    params: { gain: [0.5] },
  });
  const expectedCh0 = new Float32Array(SAMPLES_PER_BLOCK);
  const expectedCh1 = new Float32Array(SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expectedCh0[i] = (i / SAMPLES_PER_BLOCK) * 0.5;
    expectedCh1[i] = (1 - i / SAMPLES_PER_BLOCK) * 0.5;
  }
  expect(result.outputs).toEqual({ main: [expectedCh0, expectedCh1] });
});

test("stereo gain renders input × gain per-sample (= a-rate gain ramp)", async () => {
  const totalSamples = SAMPLES_PER_BLOCK * 2;
  const inputCh = new Float32Array(totalSamples);
  inputCh.fill(1);
  const gainRamp = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    gainRamp[i] = i / totalSamples;
  }
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: totalSamples / 48000,
    inputs: { main: [inputCh, inputCh] },
    params: { gain: Array.from(gainRamp) },
  });
  expect(result.outputs).toEqual({ main: [gainRamp, gainRamp] });
});

test("stereo gain default = 1 = passthrough (= params 省 略 時)", async () => {
  const inputCh0 = new Float32Array(SAMPLES_PER_BLOCK);
  const inputCh1 = new Float32Array(SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    inputCh0[i] = i * 0.001;
    inputCh1[i] = i * 0.002;
  }
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    inputs: { main: [inputCh0, inputCh1] },
  });
  expect(result.outputs).toEqual({ main: [inputCh0, inputCh1] });
});

test("canonical Ex 1 full: meterL / meterR publish slot が WorkletNamespace に reflect", () => {
  // canonical Ex 1 full (= meter L/R expose) で WorkletNamespace.publishSlots に
  // meterL / meterR が rateFps 30 で 列 挙、 main 側 で `node.state.meterL.subscribe`
  // が 経 路 化 さ れ る path を 担 保。
  expect(stereoGain.worklet.publishSlots).toEqual([
    expect.objectContaining({ name: "meterL", type: "f32" }),
    expect.objectContaining({ name: "meterR", type: "f32" }),
  ]);
});

test("canonical Ex 1 full: meter publish ON で も output は bit-exact passthrough × gain", async () => {
  // meter 計 算 (= per-sample state.store + per-block decay) は WASM 内 state slot
  // 内 部 path = output 演 算 に 影 響 ナ シ。 既 「stereo gain renders input × gain
  // bit-exact」 と zip path = canonical Ex 1 full で も regression な し。
  const inputCh = new Float32Array(SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) inputCh[i] = i * 0.001;
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    inputs: { main: [inputCh, inputCh] },
    params: { gain: [0.5] },
  });
  const expected = new Float32Array(SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) expected[i] = i * 0.0005;
  expect(result.outputs).toEqual({ main: [expected, expected] });
});

test("Ex 1 minus meter snapshot", async () => {
  // 1 sec @ 48k stereo = 耳 確 認 可 能 な 長 さ。 L = 440 Hz (A4) / R = 880
  // Hz (A5、 1 octave 上) sine = stereo L/R 違 い も 耳 check 可、 gain 0.5
  // で attenuation 効 い て い る か 耳 check。 結 果 wav を `__snapshots__/`
  // に auto-write + commit、 以 降 bit-exact 比 較 (= renderOffline
  // deterministic 保 証 = `13-offline-render.md` §3)。
  const sampleRate = 48000;
  const durationSamples = sampleRate; // 1 sec
  const result = await renderOffline(stereoGain, {
    sampleRate,
    duration: durationSamples / sampleRate,
    inputs: {
      main: [
        sine({ freqHz: 440, durationSamples, sampleRate }),
        sine({ freqHz: 880, durationSamples, sampleRate }),
      ],
    },
    params: { gain: [0.5] },
  });
  await expectAudioMatchesSnapshot(result, { snapshotName: "ex1 stereo gain" });
});
