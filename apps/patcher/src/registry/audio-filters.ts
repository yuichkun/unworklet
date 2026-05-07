// Filter nodes — one-pole and biquad shapes built directly on unworklet
// state. Coefficients are computed every sample so cutoff/Q can be
// modulated at audio rate.

import { num, flushDenormals, type Node as UNode } from "@unworklet/core";
import { register } from "./store";

const TWO_PI = 2 * Math.PI;

// onepole~ — one-pole low-pass. y[n] = y[n-1] + k(x - y[n-1]).
register({
  type: "onepole~",
  category: "audio-filter",
  description: "One-pole low-pass. Inlets: in, cutoff (Hz).",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "cutoff" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [1000],
  build: (ctx, args) => {
    const z = ctx.state.f32(0, { name: `${ctx.id}_z` });
    const x = ctx.inAudio(0);
    const fc = ctx.inControl(1, args[0] ?? 1000);
    // k = 1 - exp(-2π fc / sr)
    const k = num(1).sub((fc as UNode<"f32">).mul(-TWO_PI / ctx.sampleRate).exp());
    const y = flushDenormals(z.load().add(k.mul(x.sub(z.load()))));
    z.store(y);
    return [y];
  },
});

// onepoleHP~ — one-pole high-pass. y = x - lp_y
register({
  type: "onepoleHP~",
  category: "audio-filter",
  description: "One-pole high-pass. Inlets: in, cutoff (Hz).",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "cutoff" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [1000],
  build: (ctx, args) => {
    const z = ctx.state.f32(0, { name: `${ctx.id}_z` });
    const x = ctx.inAudio(0);
    const fc = ctx.inControl(1, args[0] ?? 1000);
    const k = num(1).sub((fc as UNode<"f32">).mul(-TWO_PI / ctx.sampleRate).exp());
    const lp = flushDenormals(z.load().add(k.mul(x.sub(z.load()))));
    z.store(lp);
    return [x.sub(lp)];
  },
});

// lores~ — Max's resonant low-pass (cascaded one-poles + feedback).
// Inlets: in, cutoff (Hz), resonance (0..0.95).
register({
  type: "lores~",
  category: "audio-filter",
  description: "Resonant low-pass (cascaded one-poles + feedback).",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "cutoff" },
    { kind: "audio", label: "Q" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [1000, 0.5],
  build: (ctx, args) => {
    const lp1 = ctx.state.f32(0, { name: `${ctx.id}_lp1` });
    const lp2 = ctx.state.f32(0, { name: `${ctx.id}_lp2` });
    const x = ctx.inAudio(0);
    const fc = ctx.inControl(1, args[0] ?? 1000);
    const q = ctx.inControl(2, args[1] ?? 0.5);
    const k = num(1).sub((fc as UNode<"f32">).mul(-TWO_PI / ctx.sampleRate).exp());
    const fed = x.sub((q as UNode<"f32">).mul(lp2.load()));
    const lp1New = flushDenormals(lp1.load().add(k.mul(fed.sub(lp1.load()))));
    lp1.store(lp1New);
    const lp2New = flushDenormals(lp2.load().add(k.mul(lp1New.sub(lp2.load()))));
    lp2.store(lp2New);
    return [lp2New];
  },
});

// hires~ — high-pass cousin: input - lores output is a band-reject; for
// HP we run a HP-shape biquad. Simplest: x - lp(x).
register({
  type: "hires~",
  category: "audio-filter",
  description: "Resonant high-pass (cascaded HPF + feedback).",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "cutoff" },
    { kind: "audio", label: "Q" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [1000, 0.5],
  build: (ctx, args) => {
    const lp1 = ctx.state.f32(0, { name: `${ctx.id}_lp1` });
    const lp2 = ctx.state.f32(0, { name: `${ctx.id}_lp2` });
    const x = ctx.inAudio(0);
    const fc = ctx.inControl(1, args[0] ?? 1000);
    const q = ctx.inControl(2, args[1] ?? 0.5);
    const k = num(1).sub((fc as UNode<"f32">).mul(-TWO_PI / ctx.sampleRate).exp());
    const fed = x.sub((q as UNode<"f32">).mul(lp2.load()));
    const lp1New = flushDenormals(lp1.load().add(k.mul(fed.sub(lp1.load()))));
    lp1.store(lp1New);
    const lp2New = flushDenormals(lp2.load().add(k.mul(lp1New.sub(lp2.load()))));
    lp2.store(lp2New);
    return [x.sub(lp2New)];
  },
});

// bandpass~ — series of LP and HP at the same cutoff is too narrow; instead
// we run an LP at cutoff*1.4 and HP at cutoff/1.4 — crude but useful.
register({
  type: "bandpass~",
  category: "audio-filter",
  description: "Bandpass via LP+HP cascade.",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "cf" },
    { kind: "audio", label: "Q" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [1000, 1.4],
  build: (ctx, args) => {
    const lpZ = ctx.state.f32(0, { name: `${ctx.id}_lpZ` });
    const hpZ = ctx.state.f32(0, { name: `${ctx.id}_hpZ` });
    const x = ctx.inAudio(0);
    const cf = ctx.inControl(1, args[0] ?? 1000);
    const q = ctx.inControl(2, args[1] ?? 1.4);
    const lpFc = (cf as UNode<"f32">).mul(q as any);
    const hpFc = (cf as UNode<"f32">).div(q as any);
    const kLp = num(1).sub(lpFc.mul(-TWO_PI / ctx.sampleRate).exp());
    const kHp = num(1).sub(hpFc.mul(-TWO_PI / ctx.sampleRate).exp());
    const lp = flushDenormals(lpZ.load().add(kLp.mul(x.sub(lpZ.load()))));
    lpZ.store(lp);
    const hp1 = flushDenormals(hpZ.load().add(kHp.mul(lp.sub(hpZ.load()))));
    hpZ.store(hp1);
    return [lp.sub(hp1)];
  },
});

// biquad~ — direct-form II transposed. Inlets: in, b0, b1, b2, a1, a2.
register({
  type: "biquad~",
  category: "audio-filter",
  description: "Biquad (DF-II-T). Inlets: in, b0, b1, b2, a1, a2.",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "b0" },
    { kind: "audio", label: "b1" },
    { kind: "audio", label: "b2" },
    { kind: "audio", label: "a1" },
    { kind: "audio", label: "a2" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [1, 0, 0, 0, 0],
  build: (ctx, args) => {
    const z1 = ctx.state.f32(0, { name: `${ctx.id}_z1` });
    const z2 = ctx.state.f32(0, { name: `${ctx.id}_z2` });
    const x = ctx.inAudio(0);
    const b0 = ctx.inControl(1, args[0] ?? 1);
    const b1 = ctx.inControl(2, args[1] ?? 0);
    const b2 = ctx.inControl(3, args[2] ?? 0);
    const a1 = ctx.inControl(4, args[3] ?? 0);
    const a2 = ctx.inControl(5, args[4] ?? 0);
    const y = (b0 as UNode<"f32">).mul(x).add(z1.load());
    const z1n = (b1 as UNode<"f32">).mul(x).add(z2.load()).sub((a1 as UNode<"f32">).mul(y));
    const z2n = (b2 as UNode<"f32">).mul(x).sub((a2 as UNode<"f32">).mul(y));
    z1.store(flushDenormals(z1n));
    z2.store(flushDenormals(z2n));
    return [y];
  },
});

// comb~ — feedforward comb filter (simple). Inlets: in, delaySamples (1..N), feedback.
register({
  type: "comb~",
  category: "audio-filter",
  description: "Comb filter: y = x + fb × delay(y, N).",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "delay" },
    { kind: "audio", label: "fb" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [200, 0.5],
  build: (ctx, args) => {
    const COMB_LEN = 8192; // ≈ 170 ms @ 48k
    const buf = ctx.buffer.f32({ size: COMB_LEN, name: `${ctx.id}_buf` });
    const head = ctx.state.i32(0, { name: `${ctx.id}_head` });
    const x = ctx.inAudio(0);
    const dSamp = ctx.inControl(1, args[0] ?? 200);
    const fb = ctx.inControl(2, args[1] ?? 0.5);
    const h = head.load();
    const wIdx = h.mod(COMB_LEN);
    const rIdx = h.sub((dSamp as UNode<"f32">).toI32()).add(COMB_LEN).mod(COMB_LEN);
    const tap = buf.read(rIdx);
    const y = x.add((fb as UNode<"f32">).mul(tap));
    buf.write(wIdx, y);
    head.store(h.add(1));
    return [flushDenormals(y)];
  },
});

// allpass~ — Schroeder allpass: y = -fb*x + delay(x + fb*y, N)
register({
  type: "allpass~",
  category: "audio-filter",
  description: "Schroeder allpass. Inlets: in, delay (samples), fb.",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "delay" },
    { kind: "audio", label: "fb" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [200, 0.5],
  build: (ctx, args) => {
    const AP_LEN = 8192;
    const buf = ctx.buffer.f32({ size: AP_LEN, name: `${ctx.id}_buf` });
    const head = ctx.state.i32(0, { name: `${ctx.id}_head` });
    const x = ctx.inAudio(0);
    const dSamp = ctx.inControl(1, args[0] ?? 200);
    const fb = ctx.inControl(2, args[1] ?? 0.5);
    const h = head.load();
    const wIdx = h.mod(AP_LEN);
    const rIdx = h.sub((dSamp as UNode<"f32">).toI32()).add(AP_LEN).mod(AP_LEN);
    const delayed = buf.read(rIdx);
    const y = delayed.sub((fb as UNode<"f32">).mul(x));
    buf.write(wIdx, x.add((fb as UNode<"f32">).mul(y)));
    head.store(h.add(1));
    return [flushDenormals(y)];
  },
});
