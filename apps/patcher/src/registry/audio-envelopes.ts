// Envelope generators. Drive amp / filter / pitch by gating them.

import { num, select, flushDenormals, type Node as UNode } from "@unworklet/core";
import { register } from "./store";

// line~ — linear ramp from current value to target over N samples.
// Inlets: target, slope (samples). Once it reaches target, holds.
register({
  type: "line~",
  category: "audio-env",
  description: "Linear ramp toward target. Inlets: target, slope (samples).",
  inlets: [
    { kind: "audio", label: "target" },
    { kind: "audio", label: "slope" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [0, 480],
  build: (ctx, args) => {
    const cur = ctx.state.f32(0, { name: `${ctx.id}_cur` });
    const target = ctx.inControl(0, args[0] ?? 0);
    const slope = ctx.inControl(1, args[1] ?? 480);
    const t = target as UNode<"f32">;
    const s = slope as UNode<"f32">;
    const stepPerSample = t.sub(cur.load()).div(s.max(1));
    const next = cur.load().add(stepPerSample);
    // Clamp so we don't overshoot once stepPerSample×N has been added.
    const clamped = select(
      cur.load().lt(t),
      next.min(t),
      next.max(t),
    ) as UNode<"f32">;
    cur.store(flushDenormals(clamped));
    return [clamped];
  },
});

// curve~ — exponential approach via one-pole. Same as line~ but with a
// time-constant response (musical envelopes feel like this).
register({
  type: "curve~",
  category: "audio-env",
  description: "Exponential approach to target (one-pole). Inlets: target, time (ms).",
  inlets: [
    { kind: "audio", label: "target" },
    { kind: "audio", label: "tau-ms" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [0, 50],
  build: (ctx, args) => {
    const cur = ctx.state.f32(0, { name: `${ctx.id}_cur` });
    const target = ctx.inControl(0, args[0] ?? 0);
    const tauMs = ctx.inControl(1, args[1] ?? 50);
    // k = 1 - exp(-1 / (tauMs * sr / 1000))
    const k = num(1).sub(
      num(-1).div((tauMs as UNode<"f32">).mul(ctx.sampleRate / 1000)).exp(),
    );
    const t = target as UNode<"f32">;
    const next = flushDenormals(cur.load().add(k.mul(t.sub(cur.load()))));
    cur.store(next);
    return [next];
  },
});

// adsr~ — gated ADSR. Inlets: gate, A (ms), D (ms), S (level 0..1), R (ms).
register({
  type: "adsr~",
  category: "audio-env",
  description: "ADSR gated by inlet 0 (gate ≥ 0.5).",
  inlets: [
    { kind: "audio", label: "gate" },
    { kind: "audio", label: "A" },
    { kind: "audio", label: "D" },
    { kind: "audio", label: "S" },
    { kind: "audio", label: "R" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [10, 80, 0.7, 200],
  build: (ctx, args) => {
    const env = ctx.state.f32(0, { name: `${ctx.id}_env` });
    const stage = ctx.state.i32(0, { name: `${ctx.id}_stage` }); // 0=idle, 1=attack, 2=decay/sustain
    const wasArmed = ctx.state.bool(false, { name: `${ctx.id}_armed` });

    const gate = ctx.inAudio(0);
    const aMs = ctx.inControl(1, args[0] ?? 10);
    const dMs = ctx.inControl(2, args[1] ?? 80);
    const sLvl = ctx.inControl(3, args[2] ?? 0.7);
    const rMs = ctx.inControl(4, args[3] ?? 200);

    const aCoef = num(1).sub(num(-1).div((aMs as UNode<"f32">).mul(ctx.sampleRate / 1000)).exp());
    const dCoef = num(1).sub(num(-1).div((dMs as UNode<"f32">).mul(ctx.sampleRate / 1000)).exp());
    const rCoef = num(1).sub(num(-1).div((rMs as UNode<"f32">).mul(ctx.sampleRate / 1000)).exp());

    const armed = gate.gte(0.5);
    const trigger = select(armed, wasArmed.load().eq(false), false);
    const released = stage.load().eq(0);
    // Stage: trigger → 1; gate-off → 0; else hold
    const newStage = select(trigger, 1, select(armed, stage.load(), 0));
    stage.store(newStage);
    wasArmed.store(armed);

    const inAttack = newStage.eq(1);
    const isReleased = newStage.eq(0);
    const target = select(isReleased, 0, select(inAttack, 1, sLvl as any));
    const coef = select(isReleased, rCoef, select(inAttack, aCoef, dCoef));
    const newE = flushDenormals(env.load().add(coef.mul(target.sub(env.load()))));
    env.store(newE);
    // attack → decay/sustain when env reaches ~1
    const advance = select(inAttack, newE.gte(0.99), false);
    stage.store(select(advance, 2, stage.load()));
    return [newE];
  },
});
