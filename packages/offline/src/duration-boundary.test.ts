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
