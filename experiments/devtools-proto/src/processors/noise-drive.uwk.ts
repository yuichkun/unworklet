// @ts-nocheck — sugar is a TS error until lowered; the plugin lowers it at build.
//
// RC-20-style Noise / Distort source — Tier-B `.uwk.ts`. LCG → normalize → tanh
// drive → one-pole DC blocker. The LCG `seed * LCG_MUL + LCG_ADD` relies on i32
// multiply/add wrapping at 32 bits (the modulo-2^32 recurrence), which the operator
// sugar preserves since `seed` is an i32 state. `dcPrev` stays anonymous (no
// `.named()`) so the dev-dump surfaces a worklet-private `__state_N`.
const LCG_MUL = 1664525;
const LCG_ADD = 1013904223;
const I32_SCALE = 1 / 2147483648; // 2^-31 → seed ∈ [-2^31, 2^31) maps to [-1, 1)
const DRIVE = 3.5;
const DC_POLE = 0.995; // one-pole DC-blocker leak coefficient

const out = audioOutput({ channels: 1, name: "main" });
const seed = state.i32(22695477).named();
const drive = state.f32(DRIVE).named();
const active = state.bool(true).named();
// Anonymous: DC-blocker previous-sample memory. Worklet-private, dev-dump only.
const dcPrev = state.f32(0);

process(() => {
  forSample((i) => {
    const next = seed * LCG_MUL + LCG_ADD;
    const raw = f32(next) * I32_SCALE;
    const shaped = tanh(raw * drive);
    // Leaky differentiator (cheap DC blocker): y = x - pole * prev.
    const blocked = shaped - dcPrev * DC_POLE;
    // `active` mutes the output to silence when false.
    out.ch(0)[i] = active ? blocked : 0;

    // Stores last (load-before-store discipline; no CSE).
    seed.write(next);
    dcPrev.write(shaped);
  });
});
