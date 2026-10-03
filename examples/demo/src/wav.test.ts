import { encodeWav } from "@unworklet/offline";
import { expect, test } from "vite-plus/test";
import { compareWav, readWav, type Wav } from "./wav.ts";
const wav = (value = 0): Wav => ({ sampleRate: 48000, channels: [new Float32Array([value])] });
const bytes = (channels: Float32Array[]) =>
  Uint8Array.from(new Uint8Array(encodeWav(channels, 48000))).buffer;
for (const count of [1, 2]) {
  test(`reads ${count} float32 channels without resampling`, () => {
    const channels = Array.from({ length: count }, (_, c) =>
      Float32Array.from({ length: 128 }, (_, i) => (i + c) / 256),
    );
    expect(readWav(bytes(channels))).toEqual({ sampleRate: 48000, channels });
  });
}
test("rejects malformed headers, truncated chunks and unsupported PCM", () => {
  for (const offset of [0, 8, 20, 34]) {
    const data = bytes(wav().channels);
    new DataView(data).setUint16(offset, 0, true);
    expect(() => readWav(data)).toThrow("unreadable WAV");
  }
  const data = bytes(wav().channels);
  for (const length of [0, 11, 25, data.byteLength - 1])
    expect(() => readWav(data.slice(0, length))).toThrow("unreadable WAV");
});
test("walks unknown chunks with odd-length padding", () => {
  const original = new Uint8Array(bytes(wav(0.5).channels));
  const data = new Uint8Array(original.length + 10);
  data.set(original.subarray(0, 12));
  data.set([74, 85, 78, 75, 1, 0, 0, 0, 42, 0], 12);
  data.set(original.subarray(12), 22);
  new DataView(data.buffer).setUint32(4, data.length - 8, true);
  expect(readWav(data.buffer)).toEqual(wav(0.5));
});
test("compares PCM with an inclusive tolerance boundary", () => {
  expect(compareWav(wav(), wav(5e-6), 1e-5)).toBe(true);
  expect(compareWav(wav(), wav(2e-5), 1e-5)).toBe(false);
  expect(compareWav(wav(), wav(0.125), 0.125)).toBe(true);
  expect(compareWav(wav(), wav(0.125), 0.124)).toBe(false);
});
test("rejects sample rate, channel and length differences", () => {
  for (const other of [
    { ...wav(), sampleRate: 44100 },
    { ...wav(), channels: [] },
    { ...wav(), channels: [new Float32Array(2)] },
  ])
    expect(compareWav(wav(), other, 1e-5)).toBe(false);
});
for (const value of [NaN, Infinity, -Infinity]) {
  test(`rejects ${value} on either side and in parsed files`, () => {
    expect(compareWav(wav(value), wav(), 1e-5)).toBe(false);
    expect(compareWav(wav(), wav(value), 1e-5)).toBe(false);
    expect(() => readWav(bytes(wav(value).channels))).toThrow("unreadable WAV");
  });
}

test("rejects missing chunks, invalid frame layout and inconsistent format metadata", () => {
  const mutate = (change: (view: DataView) => void) => {
    const data = bytes(wav().channels);
    change(new DataView(data));
    expect(() => readWav(data)).toThrow("unreadable WAV");
  };
  mutate((v) => v.setUint32(12, 0));
  mutate((v) => v.setUint32(36, 0));
  mutate((v) => v.setUint16(22, 0, true));
  mutate((v) => v.setUint32(24, 0, true));
  mutate((v) => v.setUint32(28, 1, true));
  mutate((v) => v.setUint16(32, 8, true));
  mutate((v) => v.setUint32(40, 3, true));
  mutate((v) => v.setUint32(16, 0xffffffff, true));
});
