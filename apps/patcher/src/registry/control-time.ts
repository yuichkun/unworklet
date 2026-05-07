// Time-related control nodes: metro, counter, line, bang/loadbang.

import { num, i32, select, type Node as UNode } from "@unworklet/core";
import { register } from "./store";

// metro — emits a 1 every Nth sample (where N = sr × 60 / bpm) and 0 elsewhere.
// Inlet 0: BPM. Inlet 1: enable.
register({
  type: "metro",
  category: "control",
  description: "Sample-rate metronome. Pulses high for ~32 samples each beat. Inlets: BPM, enable.",
  inlets: [
    { kind: "control", label: "BPM" },
    { kind: "control", label: "on" },
  ],
  outlets: [{ kind: "control", label: "tick" }],
  defaultArgs: [120, 1],
  build: (ctx, args) => {
    const acc = ctx.state.i32(0, { name: `${ctx.id}_acc` });
    // Pulse-width counter: when a tick fires, this counts down from PULSE.
    const pulse = ctx.state.i32(0, { name: `${ctx.id}_pulse` });
    const PULSE = 32; // samples — enough for downstream curve~ to track
    const bpm = ctx.inControl(0, args[0] ?? 120);
    const en = ctx.inControl(1, args[1] ?? 1);
    const period = num(60).mul(ctx.sampleRate).div(bpm as any).toI32();
    const next = acc.load().add(1);
    const tickFire = next.gte(period);
    acc.store(select(tickFire, i32(0), next));
    // On tickFire, reload pulse counter; otherwise decrement (clamped at 0).
    const pulseDec = pulse.load().sub(1);
    const pulseClamped = select(pulseDec.gte(0), pulseDec, i32(0));
    pulse.store(select(tickFire, i32(PULSE), pulseClamped));
    // Tick output = high during the pulse window (and enabled).
    const high = pulse.load().gt(0);
    const enabled = (en as UNode<"f32">).gte(0.5);
    return [select(enabled, select(high, num(1), num(0)), num(0)) as UNode<"f32">];
  },
});

// counter — increments on rising edge of inlet 0; wraps in [min, max).
register({
  type: "counter",
  category: "control",
  description: "Increments on rising-edge trigger. Wraps in [min, max).",
  inlets: [
    { kind: "control", label: "trig" },
    { kind: "control", label: "reset" },
  ],
  outlets: [{ kind: "control", label: "n" }],
  defaultArgs: [0, 16],
  build: (ctx, args) => {
    const n = ctx.state.i32(0, { name: `${ctx.id}_n` });
    const wasHigh = ctx.state.bool(false, { name: `${ctx.id}_high` });
    const trig = ctx.inControl(0, 0) as UNode<"f32">;
    const rstSig = ctx.inControl(1, 0) as UNode<"f32">;
    const lo = args[0] ?? 0;
    const hi = args[1] ?? 16;
    const isHigh = trig.gte(0.5);
    const fire = select(isHigh, wasHigh.load().eq(false), false);
    const reset = rstSig.gte(0.5);
    const stepped = n.load().add(1);
    // Use i32() for integer literals since these flow through state.i32 slots —
    // mixing num() (f32) into i32 select branches produces a WASM validation
    // error.
    const wrapped = select(stepped.gte(hi), i32(lo), stepped);
    const updated = select(fire, wrapped, n.load());
    n.store(select(reset, i32(lo), updated as UNode<"i32">));
    wasHigh.store(isHigh);
    return [n.load().toF32()];
  },
});

// line — linear ramp emitter (control-rate version of line~). Useful for
// slewing a UI value into a parameter.
register({
  type: "line",
  category: "control",
  description: "Linear ramp toward target. Inlets: target, slope (samples).",
  inlets: [
    { kind: "control", label: "target" },
    { kind: "control", label: "slope" },
  ],
  outlets: [{ kind: "control", label: "out" }],
  defaultArgs: [0, 480],
  build: (ctx, args) => {
    const cur = ctx.state.f32(0, { name: `${ctx.id}_cur` });
    const target = ctx.inControl(0, args[0] ?? 0);
    const slope = ctx.inControl(1, args[1] ?? 480);
    const t = target as UNode<"f32">;
    const s = slope as UNode<"f32">;
    const stepPer = t.sub(cur.load()).div(s.max(1));
    const next = cur.load().add(stepPer);
    const clamped = select(cur.load().lt(t), next.min(t), next.max(t)) as UNode<"f32">;
    cur.store(clamped);
    return [clamped];
  },
});

// bang — equivalent to the `button` UI but in code form.
register({
  type: "bang",
  category: "control",
  description: "Bang. Always 1 (use with metro to gate).",
  inlets: [],
  outlets: [{ kind: "control", label: "bang" }],
  build: () => [num(1) as UNode<"f32">],
});

// loadbang — fires once at startup. Same effect as bang in our model since
// we don't have a "patch loaded" event distinct from compile/run.
register({
  type: "loadbang",
  category: "control",
  description: "loadbang. Fires 1 at patch start (modeled as constant 1).",
  inlets: [],
  outlets: [{ kind: "control", label: "bang" }],
  build: () => [num(1) as UNode<"f32">],
});
