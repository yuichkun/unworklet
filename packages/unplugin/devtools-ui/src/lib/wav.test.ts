import { afterEach, expect, test, vi } from "vite-plus/test";

import { encodeWav, timestampLabel } from "./wav";

afterEach(() => vi.useRealTimers());

test("WAV rejects absent channels and mismatched channel lengths", () => {
  expect(() => encodeWav([], 48000)).toThrow("at least one channel required");
  expect(() => encodeWav([new Float32Array(2), new Float32Array(1)], 48000)).toThrow(
    "channel length mismatch",
  );
});

test("WAV encodes RIFF PCM headers and clamped, interleaved signed stereo samples", () => {
  const bytes = encodeWav(
    [new Float32Array([-2, -0.5, 0, 0.5, 2]), new Float32Array([1, 0.25, 0, -0.25, -1])],
    48000,
  );
  const view = new DataView(bytes.buffer);
  const label = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  expect(bytes).toHaveLength(64);
  expect(label(0, 4)).toBe("RIFF");
  expect(view.getUint32(4, true)).toBe(56);
  expect(label(8, 4)).toBe("WAVE");
  expect(label(12, 4)).toBe("fmt ");
  expect(view.getUint32(16, true)).toBe(16);
  expect(view.getUint16(20, true)).toBe(1);
  expect(view.getUint16(22, true)).toBe(2);
  expect(view.getUint32(24, true)).toBe(48000);
  expect(view.getUint32(28, true)).toBe(192000);
  expect(view.getUint16(32, true)).toBe(4);
  expect(view.getUint16(34, true)).toBe(16);
  expect(label(36, 4)).toBe("data");
  expect(view.getUint32(40, true)).toBe(20);
  expect(Array.from({ length: 10 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([
    -32768, 32767, -16384, 8192, 0, 0, 16384, -8192, 32767, -32768,
  ]);
});

test("an empty mono capture is a valid header-only WAV", () => {
  const bytes = encodeWav([new Float32Array()], 44100);
  const view = new DataView(bytes.buffer);
  expect(bytes).toHaveLength(44);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(44100);
  expect(view.getUint32(28, true)).toBe(88200);
  expect(view.getUint32(40, true)).toBe(0);
});

test("capture filenames use local calendar time with zero-padded, path-safe fields", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5));
  expect(timestampLabel()).toBe("2026-01-02T03-04-05");
  vi.setSystemTime(new Date(2026, 10, 23, 14, 55, 59));
  expect(timestampLabel()).toBe("2026-11-23T14-55-59");
});
