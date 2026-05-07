// Oscillator nodes. Each maintains a phase state slot and advances it per
// sample. Frequency comes from the audio inlet (a-rate, modulatable).
//
// All oscillators output ±1 at full amplitude. Multiply downstream to scale.

import { num, select, type Node as UNode } from "@unworklet/core";
import { register } from "./store";

const TWO_PI = 2 * Math.PI;

/** cycle~ — sine oscillator. Inlet 0: frequency Hz. */
register({
  type: "cycle~",
  category: "audio-osc",
  description: "Sine oscillator. Inlet: freq (Hz).",
  inlets: [{ kind: "audio", label: "freq" }],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [440],
  build: (ctx, args) => {
    const phase = ctx.state.f32(0, { name: `${ctx.id}_phase` });
    const fHz = ctx.inControl(0, args[0] ?? 440);
    const inc = (fHz as UNode<"f32">).mul(TWO_PI / ctx.sampleRate);
    const next = phase.load().add(inc).mod(TWO_PI);
    phase.store(next);
    return [next.sin()];
  },
});

/** phasor~ — sawtooth in [0, 1). Inlet 0: freq Hz. */
register({
  type: "phasor~",
  category: "audio-osc",
  description: "Phasor (sawtooth in [0, 1)). Inlet: freq (Hz).",
  inlets: [{ kind: "audio", label: "freq" }],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [220],
  build: (ctx, args) => {
    const phase = ctx.state.f32(0, { name: `${ctx.id}_phase` });
    const fHz = ctx.inControl(0, args[0] ?? 220);
    const inc = (fHz as UNode<"f32">).div(ctx.sampleRate);
    const next = phase.load().add(inc).mod(1);
    phase.store(next);
    return [next];
  },
});

/** saw~ — bipolar sawtooth in [-1, 1). */
register({
  type: "saw~",
  category: "audio-osc",
  description: "Bipolar sawtooth (-1..+1). Inlet: freq (Hz).",
  inlets: [{ kind: "audio", label: "freq" }],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [110],
  build: (ctx, args) => {
    const phase = ctx.state.f32(0, { name: `${ctx.id}_phase` });
    const fHz = ctx.inControl(0, args[0] ?? 110);
    const inc = (fHz as UNode<"f32">).div(ctx.sampleRate);
    const next = phase.load().add(inc).mod(1);
    phase.store(next);
    return [next.mul(2).sub(1)];
  },
});

/** tri~ — triangle wave in [-1, 1]. */
register({
  type: "tri~",
  category: "audio-osc",
  description: "Triangle wave (-1..+1). Inlet: freq (Hz).",
  inlets: [{ kind: "audio", label: "freq" }],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [220],
  build: (ctx, args) => {
    const phase = ctx.state.f32(0, { name: `${ctx.id}_phase` });
    const fHz = ctx.inControl(0, args[0] ?? 220);
    const inc = (fHz as UNode<"f32">).div(ctx.sampleRate);
    const next = phase.load().add(inc).mod(1);
    phase.store(next);
    // tri = 2 * |2 * (phase - 0.5)| - 1  →  ramp up + ramp down
    const t = next.sub(0.5).mul(2).abs().mul(2).sub(1);
    return [t];
  },
});

/** rect~ — square wave (50% duty). */
register({
  type: "rect~",
  category: "audio-osc",
  description: "Square wave (-1 / +1). Inlet: freq (Hz).",
  inlets: [{ kind: "audio", label: "freq" }],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [220],
  build: (ctx, args) => {
    const phase = ctx.state.f32(0, { name: `${ctx.id}_phase` });
    const fHz = ctx.inControl(0, args[0] ?? 220);
    const inc = (fHz as UNode<"f32">).div(ctx.sampleRate);
    const next = phase.load().add(inc).mod(1);
    phase.store(next);
    return [select(next.lt(0.5), -1, 1) as UNode<"f32">];
  },
});

/** pulse~ — pulse wave with PWM. Inlet 0: freq Hz, inlet 1: duty (0..1). */
register({
  type: "pulse~",
  category: "audio-osc",
  description: "Pulse wave with PWM. Inlets: freq, duty (0..1).",
  inlets: [
    { kind: "audio", label: "freq" },
    { kind: "audio", label: "duty" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [220, 0.5],
  build: (ctx, args) => {
    const phase = ctx.state.f32(0, { name: `${ctx.id}_phase` });
    const fHz = ctx.inControl(0, args[0] ?? 220);
    const duty = ctx.inControl(1, args[1] ?? 0.5);
    const inc = (fHz as UNode<"f32">).div(ctx.sampleRate);
    const next = phase.load().add(inc).mod(1);
    phase.store(next);
    return [select(next.lt(duty), 1, -1) as UNode<"f32">];
  },
});

/** noise~ — white noise via Lehmer LCG, output in [-1, 1). */
register({
  type: "noise~",
  category: "audio-osc",
  description: "White noise (deterministic LCG, in [-1, 1)).",
  inlets: [],
  outlets: [{ kind: "audio", label: "out" }],
  build: (ctx) => {
    const seed = ctx.state.i32(0xCAFE_F00D | 0, { name: `${ctx.id}_seed` });
    const r = seed.load().mul(1103515245).add(12345);
    seed.store(r);
    return [r.toF32().mul(1 / 2147483648)];
  },
});

/** pinknoise~ — Voss-McCartney 5-octave pink approximation. */
register({
  type: "pinknoise~",
  category: "audio-osc",
  description: "Pink noise (5-octave Voss approximation).",
  inlets: [],
  outlets: [{ kind: "audio", label: "out" }],
  build: (ctx) => {
    // Five LCGs at decreasing update rates approximate pink. We use a counter
    // and select() to update each row at 2^k samples instead of every sample.
    const counter = ctx.state.i32(0, { name: `${ctx.id}_ctr` });
    const r0 = ctx.state.f32(0, { name: `${ctx.id}_r0` });
    const r1 = ctx.state.f32(0, { name: `${ctx.id}_r1` });
    const r2 = ctx.state.f32(0, { name: `${ctx.id}_r2` });
    const r3 = ctx.state.f32(0, { name: `${ctx.id}_r3` });
    const r4 = ctx.state.f32(0, { name: `${ctx.id}_r4` });

    // Per-sample white noise.
    const seed = ctx.state.i32(0xC0FFEE_AB | 0, { name: `${ctx.id}_seed` });
    const w = seed.load().mul(1103515245).add(12345);
    seed.store(w);
    const sample = w.toF32().mul(1 / 2147483648);

    const c = counter.load().add(1);
    counter.store(c);
    // Update each row when the corresponding bit toggles in c.
    r0.store(select(c.mod(1).eq(0), sample, r0.load()));
    r1.store(select(c.mod(2).eq(0), sample, r1.load()));
    r2.store(select(c.mod(4).eq(0), sample, r2.load()));
    r3.store(select(c.mod(8).eq(0), sample, r3.load()));
    r4.store(select(c.mod(16).eq(0), sample, r4.load()));
    const sum = r0.load().add(r1.load()).add(r2.load()).add(r3.load()).add(r4.load());
    return [sum.mul(0.2)];
  },
});
