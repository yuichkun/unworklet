// @ts-nocheck — sugar is a TS error until lowered; the plugin lowers it at build.
//
// RC-20-style Digital (bit/sample-rate crusher) — Tier-B `.uwk.ts`. Sample-and-hold
// downsampler + u8 pattern ring. Uses operator + index sugar, bare-state reads,
// free-function math, and `.named()` auto-derive; `name:"main"` ports stay explicit
// (the port name differs from the binding) and the `i32(...)` store-cast is kept.
const DOWNSAMPLE = 8; // re-latch every 8 samples → 6 kHz effective rate @ 48k
const PATTERN_SIZE = 64;

const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });

const crushPattern = state.buffer.u8({ size: PATTERN_SIZE }).named();
const hold = state.f32(0).named();
const holdCounter = state.i32(0).named();
const writeIdx = state.i32(0).named();
// `crush` = the downsample factor as a knob param (default = the old fixed
// DOWNSAMPLE, so the offline render is unchanged; min 1 avoids a mod-by-zero). The
// UW-1 crush knob writes it live. auto-name derives "crush".
const crush = param.f32({ default: DOWNSAMPLE, min: 1, max: 32, automationRate: "a-rate" });

process(() => {
  forSample((i) => {
    const hc = holdCounter.read();
    // Re-latch the held sample when the downsample counter wraps.
    const held = hc % i32(crush[i]) == 0 ? input.ch(0)[i] : hold;
    out.ch(0)[i] = held;

    // Map held ∈ [-1, 1] to a 0–255 byte and store into the pattern ring.
    const wi = writeIdx.read();
    crushPattern[wi] = i32(min(max(held * 127.5 + 127.5, 0), 255));

    hold.write(held);
    holdCounter.write(hc + 1);
    writeIdx.write((wi + 1) % PATTERN_SIZE);
  });
});
