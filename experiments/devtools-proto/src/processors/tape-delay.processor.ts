/**
 * RC-20-style supply module — Space / Magnetic (tape echo).
 *
 * A feedback ring-delay: each sample reads the delayed tap, writes input plus a
 * feedback portion back into the line, and mixes a wet tap into the output. A
 * decaying peak meter is `publish`ed so it shows up on the main thread as an
 * "app-visible" badge (the one slot the page reads via the normal publish path,
 * distinct from the dev-dump X-ray).
 *
 * Covers `f32` buffer (named, snapshot-persistent), `i32` (head), `f32`
 * (feedback), `i64` (running sample counter — never overflows on long streams),
 * and a published `f32` (meter). Offline-deterministic given a fixed input.
 */

import {
  audioInput,
  audioOutput,
  defineProcessor,
  forSample,
  i32,
  i64,
  state,
} from "@unworklet/core";

const SAMPLE_RATE = 48000;
const DELAY = Math.round(SAMPLE_RATE * 0.3); // 300 ms tape head spacing
const SIZE = 32768; // ring length, > DELAY
const FEEDBACK = 0.45;
const WET = 0.5;
const METER_DECAY = 0.999;

export const tapeDelay = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });

  const delayLine = state.buffer.f32({ size: SIZE }).named("delayLine").expose({
    snapshot: "persistent",
  });
  const head = state.i32(0).named("head");
  const feedback = state.f32(FEEDBACK).named("feedback");
  const sampleCount = state.i64(0n).named("sampleCount");
  const meter = state
    .f32(0)
    .named("meter")
    .expose({ publish: { rateFps: 30 } });

  return {
    process: () => {
      forSample((i) => {
        const h = head.read();
        const delayed = delayLine.read(h.add(i32(SIZE - DELAY)).mod(i32(SIZE)));
        const x = input.ch(0).at(i);
        const wet = x.add(delayed.mul(WET));
        out.ch(0).at(i).write(wet);

        // Feed input + feedback back into the line at the write head.
        delayLine.write(h, x.add(delayed.mul(feedback.read())));

        // Decaying peak meter (published to main).
        meter.write(meter.read().mul(METER_DECAY).max(wet.abs()));

        head.write(h.add(i32(1)).mod(i32(SIZE)));
        sampleCount.write(sampleCount.read().add(i64(1n)));
      });
    },
  };
});
