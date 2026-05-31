/**
 * RC-20-style supply module — Noise / Distort source.
 *
 * A self-running noise generator: an LCG steps an `i32` seed each sample, the
 * raw value is normalized to [-1, 1), shaped by a `tanh` drive, then leaked
 * through a one-pole DC blocker. Covers `i32` (seed), `f32` (drive), `bool`
 * (active), and an ANONYMOUS `f32` slot (the DC-blocker memory, no `.named()`
 * → worklet-private `__state_N`) — the dev-dump must surface anonymous slots.
 *
 * Offline-deterministic: no params, no audio input, fixed constants — so
 * `renderOffline` reproduces the exact sample stream and slot values the
 * dev-dump is checked against.
 */

import { audioOutput, defineProcessor, f32, forSample, i32, select, state } from "@unworklet/core";

// LCG (Numerical Recipes constants). i32 multiply/add wrap at 32 bits — exactly
// the modulo-2^32 recurrence an LCG needs.
const LCG_MUL = 1664525;
const LCG_ADD = 1013904223;
const I32_SCALE = 1 / 2147483648; // 2^-31 → seed ∈ [-2^31, 2^31) maps to [-1, 1)
const DRIVE = 3.5;
const DC_POLE = 0.995; // one-pole DC-blocker leak coefficient

export const noiseDrive = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const seed = state.i32(22695477).named("seed");
  const drive = state.f32(DRIVE).named("drive");
  const active = state.bool(true).named("active");
  // Anonymous: DC-blocker previous-sample memory. Worklet-private, dev-dump only.
  const dcPrev = state.f32(0);

  return {
    process: () => {
      forSample((i) => {
        const next = seed.read().mul(i32(LCG_MUL)).add(i32(LCG_ADD));
        const raw = f32(next).mul(I32_SCALE);
        const shaped = raw.mul(drive.read()).tanh();
        // Leaky differentiator (cheap DC blocker): y = x - pole * prev.
        const blocked = shaped.sub(dcPrev.read().mul(DC_POLE));
        // `active` mutes the output to silence when false.
        out
          .ch(0)
          .at(i)
          .write(select(active.read(), blocked, f32(0)));

        // Stores last (load-before-store discipline; no CSE).
        seed.write(next);
        dcPrev.write(shaped);
      });
    },
  };
});
