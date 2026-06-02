/**
 * `decodeWav` behavior = WAV bytes → Float32Array channels + sampleRate
 * (thin wrapper around `wavefile` read). Paired with encodeWav for round-trip coverage.
 *
 * Raw carry path: wavefile `getSamples` output returned as-is.
 * 32f / 64f → normalized -1..1 values; 16/24/32-bit integer PCM → raw signed int
 * values carried into Float32Array. renderOffline output defaults to 32f,
 * so round-trips are bit-exact.
 */

import { expect, test } from "vite-plus/test";

import { decodeWav } from "./decodeWav.ts";
import { encodeWav } from "./encodeWav.ts";

const monoBlock = (value: number, length = 128): Float32Array => {
  const data = new Float32Array(length);
  data.fill(value);
  return data;
};

test("`decodeWav` round-trip (= 32f default) preserves mono Float32 samples bit-exact", () => {
  const input = new Float32Array(128);
  for (let i = 0; i < 128; i++) input[i] = i / 128;
  const wav = encodeWav([input], 48000);
  const decoded = decodeWav(wav);
  expect(decoded.sampleRate).toBe(48000);
  expect(decoded.channels.length).toBe(1);
  expect(decoded.channels[0]).toEqual(input);
});

test("`decodeWav` round-trip preserves stereo channel separation (= L != R)", () => {
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  for (let i = 0; i < 128; i++) {
    left[i] = i / 128;
    right[i] = 1 - i / 128;
  }
  const wav = encodeWav([left, right], 48000);
  const decoded = decodeWav(wav);
  expect(decoded.channels.length).toBe(2);
  expect(decoded.channels[0]).toEqual(left);
  expect(decoded.channels[1]).toEqual(right);
});

test("`decodeWav` carries the requested sampleRate (= 44100 vs 48000 vs 96000)", () => {
  for (const sampleRate of [44100, 48000, 96000]) {
    const wav = encodeWav([monoBlock(0.5)], sampleRate);
    expect(decodeWav(wav).sampleRate).toBe(sampleRate);
  }
});

test("`decodeWav` round-trip 64f (= IEEE Double) preserves Float samples bit-exact", () => {
  const input = new Float32Array(128);
  for (let i = 0; i < 128; i++) input[i] = i / 128;
  const wav = encodeWav([input], 48000, { bitDepth: "64" });
  const decoded = decodeWav(wav);
  expect(decoded.channels[0]).toEqual(input);
});

test("`decodeWav` decodes 5.1 multi-channel (= EXTENSIBLE) into 6 channels", () => {
  const channels: Float32Array[] = [];
  for (let c = 0; c < 6; c++) {
    const ch = new Float32Array(128);
    ch.fill(c * 0.1);
    channels.push(ch);
  }
  const wav = encodeWav(channels, 48000);
  const decoded = decodeWav(wav);
  expect(decoded.channels.length).toBe(6);
  for (let c = 0; c < 6; c++) {
    expect(decoded.channels[c]).toEqual(channels[c]);
  }
});

test("`decodeWav` throws on invalid input (= non-WAV bytes)", () => {
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(() => decodeWav(garbage)).toThrow();
});
