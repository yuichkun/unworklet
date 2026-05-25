/**
 * `encodeWav` behavior = Float32Array[] channels → WAV bytes (= `wavefile`
 * wrap)。 round-trip test で WAV spec compliance を 担 保 (= encodeWav →
 * wavefile read で sample bit-exact 戻 る + RIFF header 確 認)。
 *
 * `wavefile` = WAV spec compliance 1 位 (= 24-bit / multi-ch 自 動
 * `WAVE_FORMAT_EXTENSIBLE` 切 替 + dwChannelMask + ADPCM/Alaw/Mulaw 全 対 応)。
 */

import { expect, test } from "vite-plus/test";
import { WaveFile } from "wavefile";

import { encodeWav } from "./encodeWav.ts";

const decodeWavToChannels = (
  bytes: Uint8Array,
): { channels: Float32Array[]; sampleRate: number; bitDepth: string } => {
  const wf = new WaveFile();
  wf.fromBuffer(bytes);
  const samples = wf.getSamples(false, Float32Array) as unknown as Float32Array | Float32Array[];
  const channels = Array.isArray(samples) ? samples : [samples];
  const fmt = wf.fmt as { sampleRate: number };
  return {
    channels: channels.map((c) => new Float32Array(c)),
    sampleRate: fmt.sampleRate,
    bitDepth: wf.bitDepth,
  };
};

const monoBlock = (value: number, length = 128): Float32Array => {
  const data = new Float32Array(length);
  data.fill(value);
  return data;
};

test("`encodeWav` returns a Uint8Array carrying a valid RIFF / WAVE header", () => {
  const wav = encodeWav([monoBlock(0.5)], 48000);
  expect(wav).toBeInstanceOf(Uint8Array);
  expect(String.fromCharCode(wav[0]!, wav[1]!, wav[2]!, wav[3]!)).toBe("RIFF");
  expect(String.fromCharCode(wav[8]!, wav[9]!, wav[10]!, wav[11]!)).toBe("WAVE");
});

test("`encodeWav` default bitDepth = '32f' (= IEEE Float)", () => {
  const wav = encodeWav([monoBlock(0.5)], 48000);
  const decoded = decodeWavToChannels(wav);
  expect(decoded.bitDepth).toBe("32f");
});

test("`encodeWav` round-trip preserves mono Float32 samples bit-exact (= 32f default)", () => {
  const input = new Float32Array(128);
  for (let i = 0; i < 128; i++) input[i] = i / 128;
  const wav = encodeWav([input], 48000);
  const decoded = decodeWavToChannels(wav);
  expect(decoded.sampleRate).toBe(48000);
  expect(decoded.channels.length).toBe(1);
  expect(decoded.channels[0]).toEqual(input);
});

test("`encodeWav` round-trip preserves stereo channel separation (= interleaved write + de-interleave read)", () => {
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  for (let i = 0; i < 128; i++) {
    left[i] = i / 128;
    right[i] = 1 - i / 128;
  }
  const wav = encodeWav([left, right], 48000);
  const decoded = decodeWavToChannels(wav);
  expect(decoded.channels.length).toBe(2);
  expect(decoded.channels[0]).toEqual(left);
  expect(decoded.channels[1]).toEqual(right);
});

test("`encodeWav` carries the requested sampleRate (= 44100 vs 48000 vs 96000)", () => {
  for (const sampleRate of [44100, 48000, 96000]) {
    const wav = encodeWav([monoBlock(0.5)], sampleRate);
    expect(decodeWavToChannels(wav).sampleRate).toBe(sampleRate);
  }
});

test("`encodeWav` with bitDepth '16' produces 16-bit PCM (= header)", () => {
  const wav = encodeWav([monoBlock(0.5)], 48000, { bitDepth: "16" });
  expect(decodeWavToChannels(wav).bitDepth).toBe("16");
});

test("`encodeWav` with bitDepth '24' produces 24-bit PCM", () => {
  const wav = encodeWav([monoBlock(0.5)], 48000, { bitDepth: "24" });
  expect(decodeWavToChannels(wav).bitDepth).toBe("24");
});

test("`encodeWav` with bitDepth '64' produces 64-bit Float (= IEEE Double)", () => {
  const input = new Float32Array(128);
  for (let i = 0; i < 128; i++) input[i] = i / 128;
  const wav = encodeWav([input], 48000, { bitDepth: "64" });
  const decoded = decodeWavToChannels(wav);
  expect(decoded.bitDepth).toBe("64");
  expect(decoded.channels[0]).toEqual(input);
});

test("`encodeWav` supports multi-channel (= 5.1 = 6 ch) via WAVE_FORMAT_EXTENSIBLE auto-switch", () => {
  const channels: Float32Array[] = [];
  for (let c = 0; c < 6; c++) {
    const ch = new Float32Array(128);
    ch.fill(c * 0.1);
    channels.push(ch);
  }
  const wav = encodeWav(channels, 48000);
  const decoded = decodeWavToChannels(wav);
  expect(decoded.channels.length).toBe(6);
  for (let c = 0; c < 6; c++) {
    expect(decoded.channels[c]).toEqual(channels[c]);
  }
});
