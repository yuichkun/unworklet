import { audioOutput, defineProcessor, forSample, state, inspectSnapshot } from "@unworklet/core";
import { expect, test } from "vite-plus/test";
import { renderOffline } from "./index.ts";

for (const [sampleRate, samples, expected] of [
  [48000, 896, 896],
  [44100, 1664, 1664],
  [48000, 897, 1024],
  [48000, 896.000001, 1024],
  [48000, 0, 0],
] as const) {
  test(`renders ${samples} requested samples at ${sampleRate} Hz in ${expected} samples`, async () => {
    const processor = defineProcessor(() => {
      const out = audioOutput({ name: "main", channels: 1 });
      const count = state.named("count").i32(0);
      return {
        process: () => {
          count.write(count.read().add(1));
          forSample((i) => out.ch(0).at(i).write(0.5));
        },
      };
    });
    const result = await renderOffline(processor, { sampleRate, duration: samples / sampleRate });
    expect(result.outputs.main![0]).toHaveLength(expected);
    expect(inspectSnapshot(result.state).slots.count).toEqual({
      kind: "state",
      type: "i32",
      value: expected / 128,
    });
  });
}

const adjacentDuration = (value: number, direction: -1 | 1): number => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + BigInt(direction));
  return view.getFloat64(0);
};

for (const [sampleRate, samples] of [
  [48000, 128],
  [48000, 896],
  [44100, 1664],
  [96000, 128],
  [48000, 2944],
  [44100, 2176],
] as const) {
  for (const direction of [-1, 0, 1] as const) {
    test(`duration ${direction} ULP from ${samples}/${sampleRate} preserves quantum ceiling`, async () => {
      const boundary = samples / sampleRate;
      const duration = direction === 0 ? boundary : adjacentDuration(boundary, direction);
      const expected = direction === 1 ? samples + 128 : samples;
      const processor = defineProcessor(() => {
        const out = audioOutput({ name: "main", channels: 1 });
        const count = state.named("count").i32(0);
        return {
          process: () => {
            count.write(count.read().add(1));
            forSample((i) => out.ch(0).at(i).write(0.5));
          },
        };
      });
      const result = await renderOffline(processor, { sampleRate, duration });
      expect(result.outputs.main![0]).toHaveLength(expected);
      expect(inspectSnapshot(result.state).slots.count).toEqual({
        kind: "state",
        type: "i32",
        value: expected / 128,
      });
    });
  }
}
