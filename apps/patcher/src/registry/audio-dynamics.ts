import { num, flushDenormals, select, type Node as UNode } from "@unworklet/core";
import { register } from "./store";

// gain~ — a-rate volume control. Inlets: in, gain.
register({
  type: "gain~",
  category: "audio-dyn",
  description: "VCA. Inlets: in, gain (linear).",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "gain" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [1],
  build: (ctx, args) => {
    const x = ctx.inAudio(0);
    const g = ctx.inControl(1, args[0] ?? 1);
    return [x.mul(g as any)];
  },
});

// peakamp~ — peak follower. Outputs the peak |x| over the recent past with
// fast attack / slow release. Useful for sidechain ducking and meters.
register({
  type: "peakamp~",
  category: "audio-dyn",
  description: "Peak follower. Inlets: in, attack (ms), release (ms).",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "atk" },
    { kind: "audio", label: "rel" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [5, 100],
  build: (ctx, args) => {
    const env = ctx.state.f32(0, { name: `${ctx.id}_env` });
    const x = ctx.inAudio(0).abs();
    const aMs = ctx.inControl(1, args[0] ?? 5);
    const rMs = ctx.inControl(2, args[1] ?? 100);
    const aCoef = num(1).sub(num(-1).div((aMs as UNode<"f32">).mul(ctx.sampleRate / 1000)).exp());
    const rCoef = num(1).sub(num(-1).div((rMs as UNode<"f32">).mul(ctx.sampleRate / 1000)).exp());
    const e = env.load();
    const c = select(x.gt(e), aCoef, rCoef);
    const next = flushDenormals(e.add(c.mul(x.sub(e))));
    env.store(next);
    return [next];
  },
});

// compand~ — simple feed-forward compressor (no soft knee). Inlets: in,
// thresh (linear), ratio.
register({
  type: "compand~",
  category: "audio-dyn",
  description: "Feed-forward compressor. Inlets: in, threshold (lin), ratio.",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "thr" },
    { kind: "audio", label: "ratio" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [0.3, 4],
  build: (ctx, args) => {
    const env = ctx.state.f32(0, { name: `${ctx.id}_env` });
    const x = ctx.inAudio(0);
    const thr = ctx.inControl(1, args[0] ?? 0.3);
    const ratio = ctx.inControl(2, args[1] ?? 4);
    // 5 ms / 80 ms attack/release for the env follower.
    const aCoef = num(1).sub(num(-1).div(num(0.005).mul(ctx.sampleRate)).exp());
    const rCoef = num(1).sub(num(-1).div(num(0.08).mul(ctx.sampleRate)).exp());
    const det = x.abs();
    const c = select(det.gt(env.load()), aCoef, rCoef);
    const newE = flushDenormals(env.load().add(c.mul(det.sub(env.load()))));
    env.store(newE);
    // gain reduction: if env > thr, scale by (thr + (env-thr)/ratio) / env
    const over = newE.sub(thr as any);
    const gr = select(
      newE.gt(thr as any),
      (thr as UNode<"f32">).add(over.div(ratio as any)).div(newE.max(1e-9)),
      1,
    );
    return [x.mul(gr)];
  },
});

// limit~ — hard limiter via tanh saturator. Inlets: in, ceiling (linear).
register({
  type: "limit~",
  category: "audio-dyn",
  description: "tanh-based soft limiter. Inlets: in, ceiling.",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "ceil" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [0.95],
  build: (ctx, args) => {
    const x = ctx.inAudio(0);
    const c = ctx.inControl(1, args[0] ?? 0.95);
    return [x.div(c as any).tanh().mul(c as any)];
  },
});
