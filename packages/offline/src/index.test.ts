/**
 * `renderOffline` behavior (= `13-offline-render.md` §2)。 Step 3.6 で
 * fill。
 *
 * driver-friendly handle (= `result.driver.instantiate()` 越 し) で memory
 * I/O を 駆 動、 render quantum 単 位 で input / param marshal + process()
 * + output read を 反 復。 duration × sampleRate は SAMPLES_PER_BLOCK で
 * 切 り 上 げ (= `13-offline-render.md` §2.1)。
 */

import "@unworklet/core"; // side-effect load for `.mul` method registration via primitives.ts
import { defineProcessor, SAMPLES_PER_BLOCK } from "@unworklet/core";
import { audioInput, audioOutput, forSample, param } from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { renderOffline } from "./index.ts";

const stereoGain = defineProcessor(() => {
  const input = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const gain = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" }).named("gain");
  return {
    process: () => {
      forSample((i) => {
        out.left.at(i).write(input.left.at(i).mul(gain.at(i)));
        out.right.at(i).write(input.right.at(i).mul(gain.at(i)));
      });
    },
  };
});

const oneBlockInput = (value: number): Float32Array => {
  const data = new Float32Array(SAMPLES_PER_BLOCK);
  data.fill(value);
  return data;
};

test("`renderOffline` returns the result shape (= outputs / events / state)", async () => {
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    inputs: { main: [oneBlockInput(1), oneBlockInput(0.25)] },
    params: { gain: [0.5] },
  });
  expect(result).toEqual({
    outputs: { main: [oneBlockInput(0.5), oneBlockInput(0.125)] },
    events: [],
    state: new Uint8Array(0),
  });
});

test("`renderOffline` reproduces input × gain on each sample (= 1 block)", async () => {
  const inputCh0 = new Float32Array(SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) inputCh0[i] = i / SAMPLES_PER_BLOCK;
  const inputCh1 = oneBlockInput(0);
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    inputs: { main: [inputCh0, inputCh1] },
    params: { gain: [2] }, // k-rate broadcast
  });
  const expectedCh0 = new Float32Array(SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) expectedCh0[i] = (i / SAMPLES_PER_BLOCK) * 2;
  expect(result).toEqual({
    outputs: { main: [expectedCh0, oneBlockInput(0)] },
    events: [],
    state: new Uint8Array(0),
  });
});

test("`renderOffline` runs multiple blocks (= duration = 2 × SAMPLES_PER_BLOCK / sampleRate)", async () => {
  const totalSamples = SAMPLES_PER_BLOCK * 2;
  const inputCh = new Float32Array(totalSamples);
  inputCh.fill(1);
  const expectedCh = new Float32Array(totalSamples);
  expectedCh.fill(0.5);
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: totalSamples / 48000,
    inputs: { main: [inputCh, inputCh] },
    params: { gain: [0.5] },
  });
  expect(result).toEqual({
    outputs: { main: [expectedCh, expectedCh] },
    events: [],
    state: new Uint8Array(0),
  });
});

test("`renderOffline` rounds up duration × sampleRate to the next SAMPLES_PER_BLOCK boundary", async () => {
  // 48 sample 分 要 求 (= 0.001 sec @ 48kHz) = 1 block (= 128 sample) に 切 り 上 げ
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: 48 / 48000,
    inputs: { main: [oneBlockInput(1), oneBlockInput(1)] },
    params: { gain: [0.5] },
  });
  expect(result.outputs["main"]![0]!.length).toBe(SAMPLES_PER_BLOCK);
  expect(result.outputs["main"]![1]!.length).toBe(SAMPLES_PER_BLOCK);
});

test("`renderOffline` uses param default when `params[name]` is omitted (= length 0 normalize)", async () => {
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    inputs: { main: [oneBlockInput(1), oneBlockInput(1)] },
  });
  // gain default = 1 = passthrough
  expect(result.outputs).toEqual({
    main: [oneBlockInput(1), oneBlockInput(1)],
  });
});

test("`renderOffline` fills zero when `inputs[name]` is omitted", async () => {
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    params: { gain: [1] },
  });
  expect(result.outputs).toEqual({
    main: [oneBlockInput(0), oneBlockInput(0)],
  });
});

test("`renderOffline` zero-pads input channel when input array is shorter than the render", async () => {
  // 64 sample 分 だ け input 渡 す + duration = 128 sample = 後 半 64 sample
  // は 0 fill = output 後 半 64 sample も 0 で 出 る。
  const shortInput = new Float32Array(64);
  shortInput.fill(1);
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    inputs: { main: [shortInput, shortInput] },
    params: { gain: [0.5] },
  });
  const expectedCh = new Float32Array(SAMPLES_PER_BLOCK);
  for (let i = 0; i < 64; i++) expectedCh[i] = 0.5;
  // 64 以 降 = 0 (= input zero pad × gain = 0)
  expect(result.outputs).toEqual({ main: [expectedCh, expectedCh] });
});

test("`renderOffline` holds the last param sample when param array is shorter than the render", async () => {
  // gain = [0.25, 0.75] の 2 sample = 1 < length < SAMPLES_PER_BLOCK
  // = sample 0 → 0.25、 sample 1 → 0.75、 sample 2..127 → 0.75 (= last hold)。
  const inputCh = oneBlockInput(1);
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    inputs: { main: [inputCh, inputCh] },
    params: { gain: [0.25, 0.75] },
  });
  const expectedCh = new Float32Array(SAMPLES_PER_BLOCK);
  expectedCh[0] = 0.25;
  for (let i = 1; i < SAMPLES_PER_BLOCK; i++) expectedCh[i] = 0.75;
  expect(result.outputs).toEqual({ main: [expectedCh, expectedCh] });
});

test("`renderOffline` per-sample param array (= length 128 a-rate) is applied per-sample", async () => {
  const inputCh = oneBlockInput(1);
  const gainData = new Float32Array(SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) gainData[i] = i / SAMPLES_PER_BLOCK;
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    inputs: { main: [inputCh, inputCh] },
    params: { gain: Array.from(gainData) },
  });
  const expectedCh = new Float32Array(SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) expectedCh[i] = gainData[i]!;
  expect(result.outputs).toEqual({ main: [expectedCh, expectedCh] });
});
