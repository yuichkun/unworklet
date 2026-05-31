/**
 * RC-20-style supply module — Digital (bit/sample-rate crusher).
 *
 * Sample-and-hold downsampler: the input is re-latched every `DOWNSAMPLE`
 * samples, giving the stair-step "digital" character. Each held value is also
 * mapped to a 0–255 byte and written into a small `u8` ring so the main thread
 * can render it as a pattern strip.
 *
 * Covers `u8` buffer (named), `f32` (held sample), and two `i32` slots (hold
 * counter, write index). Offline-deterministic given a fixed input.
 */

import {
  audioInput,
  audioOutput,
  defineProcessor,
  forSample,
  i32,
  select,
  state,
} from "@unworklet/core";

const DOWNSAMPLE = 8; // re-latch every 8 samples → 6 kHz effective rate @ 48k
const PATTERN_SIZE = 64;

export const crusher = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });

  const crushPattern = state.buffer.u8({ size: PATTERN_SIZE }).named("crushPattern");
  const hold = state.f32(0).named("hold");
  const holdCounter = state.i32(0).named("holdCounter");
  const writeIdx = state.i32(0).named("writeIdx");

  return {
    process: () => {
      forSample((i) => {
        const hc = holdCounter.read();
        const x = input.ch(0).at(i);
        // Re-latch the held sample when the downsample counter wraps.
        const held = select(hc.mod(i32(DOWNSAMPLE)).eq(i32(0)), x, hold.read());
        out.ch(0).at(i).write(held);

        // Map held ∈ [-1, 1] to a 0–255 byte and store into the pattern ring.
        const wi = writeIdx.read();
        const byte = held.mul(127.5).add(127.5).max(0).min(255);
        crushPattern.write(wi, i32(byte));

        hold.write(held);
        holdCounter.write(hc.add(i32(1)));
        writeIdx.write(wi.add(i32(1)).mod(i32(PATTERN_SIZE)));
      });
    },
  };
});
