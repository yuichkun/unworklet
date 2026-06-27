/**
 * Regression: renderOffline must address WASM linear memory with the layout the
 * WASM was actually emitted from (the host-rate re-capture inside `compile`), not
 * the eager `processor.graph` captured at the default 48000 rate.
 *
 * A buffer whose `size` depends on `ctx.sampleRate` (the standard delay-line idiom
 * `Math.round(ctx.sampleRate * seconds)`) makes the two layouts diverge in the
 * buffers region, which shifts the base of every region packed after it — the MIDI
 * / event / message rings. At a non-48000 rate the eager-layout offset then points
 * at the wrong place, so an injected MIDI event is written where the WASM never
 * reads it: silently lost (and corrupting the delay buffer).
 */

import { audioOutput, defineProcessor, event, f32, forSample, state } from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { renderOffline } from "./index.ts";

test("renderOffline at 44100 delivers MIDI-in when a buffer size depends on ctx.sampleRate", async () => {
  const synth = defineProcessor((ctx) => {
    const out = audioOutput({ channels: 1, name: "main" });
    // 100ms delay line sized from the host rate → 44100 and 48000 layouts diverge.
    const delay = state.buffer.f32({ size: Math.round(ctx.sampleRate * 0.1) }).named("delay");
    const keys = event.midi({ from: "main", name: "keys" });
    const note = state.i32(0);
    return {
      process: () => {
        keys.onEvent("noteOn", ({ note: n }) => {
          note.write(n);
        });
        forSample((i) => {
          // `delay.read(0)` (== 0, uninitialised) keeps the buffer in the layout.
          out
            .ch(0)
            .at(i)
            .write(f32(note.read()).add(delay.read(0)));
        });
      },
    };
  });
  const result = await renderOffline(synth, {
    sampleRate: 44100,
    duration: 256 / 44100,
    events: [
      {
        name: "keys",
        payload: { type: "noteOn", channel: 0, note: 60, velocity: 100 },
        atSample: 0,
      },
    ],
  });
  // The noteOn drains at the top of block 0, so the note is observable from sample 0.
  expect(result.outputs.main![0]![0]).toBe(60);
});
