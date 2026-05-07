import { num, i32, select, type Node as UNode } from "@unworklet/core";
import { register } from "./store";

// sah~ — sample-and-hold. Inlet 0: signal. Inlet 1: trigger (latches on rising edge).
register({
  type: "sah~",
  category: "audio-sampling",
  description: "Sample-and-hold. Latches inlet 0 on rising edge of inlet 1 (≥ thresh).",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "trig" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [0.5],
  build: (ctx, args) => {
    const held = ctx.state.f32(0, { name: `${ctx.id}_held` });
    const wasHigh = ctx.state.bool(false, { name: `${ctx.id}_high` });
    const x = ctx.inAudio(0);
    const trig = ctx.inAudio(1);
    const thr = args[0] ?? 0.5;
    const isHigh = trig.gte(thr);
    const fire = select(isHigh, wasHigh.load().eq(false), false);
    held.store(select(fire, x, held.load()));
    wasHigh.store(isHigh);
    return [held.load()];
  },
});

// count~ — sample counter. Outputs the running sample number; resets on
// rising edge of inlet 0 (trig).
register({
  type: "count~",
  category: "audio-sampling",
  description: "Sample counter. Resets on rising edge of inlet 0 (trig).",
  inlets: [{ kind: "audio", label: "trig" }],
  outlets: [{ kind: "audio", label: "n" }],
  build: (ctx) => {
    const n = ctx.state.i32(0, { name: `${ctx.id}_n` });
    const wasHigh = ctx.state.bool(false, { name: `${ctx.id}_high` });
    const trig = ctx.inAudio(0);
    const isHigh = trig.gte(0.5);
    const reset = select(isHigh, wasHigh.load().eq(false), false);
    n.store(select(reset, i32(0), n.load().add(1)));
    wasHigh.store(isHigh);
    return [n.load().toF32()];
  },
});

// rate~ — slow down a signal by an integer factor (sample-and-hold every Nth sample).
register({
  type: "rate~",
  category: "audio-sampling",
  description: "Sample rate scaler — holds input for N samples (S&H ratio).",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "ratio" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [4],
  build: (ctx, args) => {
    const held = ctx.state.f32(0, { name: `${ctx.id}_held` });
    const counter = ctx.state.i32(0, { name: `${ctx.id}_ctr` });
    const x = ctx.inAudio(0);
    const ratio = ctx.inControl(1, args[0] ?? 4);
    const c = counter.load().add(1);
    const tick = c.gte((ratio as UNode<"f32">).toI32());
    held.store(select(tick, x, held.load()));
    counter.store(select(tick, 0, c));
    return [held.load()];
  },
});
