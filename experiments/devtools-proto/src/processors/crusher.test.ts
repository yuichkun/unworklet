/**
 * End-user simulation (P6) — the RC-20 bit/sample-rate crusher tested with
 * `@unworklet/test`. The defining behavior is sample-and-hold: the output is
 * re-latched every `DOWNSAMPLE` samples and held constant in between. The
 * byte-exact snapshot anchors the `.uwk.ts` rewrite (P5).
 */
import { renderOffline } from "@unworklet/offline";
import { expectAudioMatchesSnapshot, expectStable, sine } from "@unworklet/test";
import { expect, test } from "vite-plus/test";

import { crusher } from "./crusher.processor.ts";

const SAMPLE_RATE = 48000;
const DOWNSAMPLE = 8; // processor と同じ re-latch 間隔

test("crusher: sample-and-hold で DOWNSAMPLE サンプルごとに段差が出る", async () => {
  const total = 1024;
  const result = await renderOffline(crusher, {
    sampleRate: SAMPLE_RATE,
    duration: total / SAMPLE_RATE,
    inputs: {
      main: [sine({ freqHz: 1000, durationSamples: total, sampleRate: SAMPLE_RATE })],
    },
  });
  expectStable(result);
  const ch = result.outputs["main"]![0]!;
  // 1 つ目の hold window: [0, DOWNSAMPLE) は latch された 1 値で一定。
  for (let i = 1; i < DOWNSAMPLE; i++) expect(ch[i]).toBe(ch[0]);
  // DOWNSAMPLE 番目で再 latch されて値が変わり、次の window もまた一定。
  expect(ch[DOWNSAMPLE]).not.toBe(ch[0]);
  for (let i = DOWNSAMPLE + 1; i < 2 * DOWNSAMPLE; i++) expect(ch[i]).toBe(ch[DOWNSAMPLE]);
  await expectAudioMatchesSnapshot(result);
});
