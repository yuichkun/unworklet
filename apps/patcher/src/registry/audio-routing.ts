import { num, select, type Node as UNode } from "@unworklet/core";
import { register } from "./store";

// selector~ — 8 audio inlets + 1 selector inlet. Outputs the N-th input
// (1..8; 0 / out-of-range emits silence). Implemented as a chain of
// `select` calls; the chain is unrolled at compile time.
register({
  type: "selector~",
  category: "audio-routing",
  description: "N-of-1 audio multiplexer (1..8). Inlet 0: selector. Inlets 1..8: candidates.",
  inlets: [
    { kind: "audio", label: "sel" },
    { kind: "audio", label: "1" },
    { kind: "audio", label: "2" },
    { kind: "audio", label: "3" },
    { kind: "audio", label: "4" },
    { kind: "audio", label: "5" },
    { kind: "audio", label: "6" },
    { kind: "audio", label: "7" },
    { kind: "audio", label: "8" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  build: (ctx) => {
    const sel = ctx.inAudio(0);
    const cands = [1, 2, 3, 4, 5, 6, 7, 8].map((idx) => ctx.inAudio(idx));
    const i = sel.toI32();
    let acc: UNode<"f32"> = num(0) as UNode<"f32">;
    for (let k = 8; k >= 1; k--) {
      acc = select(i.eq(k), cands[k - 1]!, acc) as UNode<"f32">;
    }
    return [acc];
  },
});

// gate~ — lets audio through when control >= 0.5, else silence.
register({
  type: "gate~",
  category: "audio-routing",
  description: "Audio gate. Inlets: in, gate (open if ≥ 0.5).",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "gate" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [1],
  build: (ctx, args) => {
    const x = ctx.inAudio(0);
    const g = ctx.inControl(1, args[0] ?? 1);
    return [select((g as UNode<"f32">).gte(0.5), x, 0) as UNode<"f32">];
  },
});

// pong~ — equal-power pan. Inlets: in, pan (-1..+1). Outlets: L, R.
register({
  type: "pong~",
  category: "audio-routing",
  description: "Equal-power pan. Inlets: in, pan (-1..+1). Outlets: L, R.",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "pan" },
  ],
  outlets: [
    { kind: "audio", label: "L" },
    { kind: "audio", label: "R" },
  ],
  defaultArgs: [0],
  build: (ctx, args) => {
    const x = ctx.inAudio(0);
    const p = ctx.inControl(1, args[0] ?? 0);
    // pan in [-1, 1] → angle in [0, π/2]
    // L = cos(angle), R = sin(angle); angle = (p + 1) * π/4
    const angle = (p as UNode<"f32">).add(1).mul(Math.PI / 4);
    return [x.mul(angle.cos()), x.mul(angle.sin())];
  },
});

// mute~ — like gate~ but with attribute toggle (no audio inlet).
register({
  type: "mute~",
  category: "audio-routing",
  description: "Mute (passthrough or silence based on attribute).",
  inlets: [{ kind: "audio", label: "in" }],
  outlets: [{ kind: "audio", label: "out" }],
  attrs: [{ name: "muted", kind: "boolean", default: false }],
  build: (ctx, _args, attrs) => {
    const x = ctx.inAudio(0);
    return [attrs.muted ? (x.mul(0) as UNode<"f32">) : x];
  },
});

// matrix~ — 2x2 audio matrix. Useful for L/R routing experiments. Inlets:
// L, R. Outlets: L', R'. Args: [LL, LR, RL, RR] gain matrix.
register({
  type: "matrix~",
  category: "audio-routing",
  description: "2×2 audio matrix. Args: [aLL, aLR, aRL, aRR].",
  inlets: [
    { kind: "audio", label: "L" },
    { kind: "audio", label: "R" },
  ],
  outlets: [
    { kind: "audio", label: "L'" },
    { kind: "audio", label: "R'" },
  ],
  defaultArgs: [1, 0, 0, 1],
  build: (ctx, args) => {
    const l = ctx.inAudio(0);
    const r = ctx.inAudio(1);
    const aLL = args[0] ?? 1;
    const aLR = args[1] ?? 0;
    const aRL = args[2] ?? 0;
    const aRR = args[3] ?? 1;
    return [l.mul(aLL).add(r.mul(aLR)), l.mul(aRL).add(r.mul(aRR))];
  },
});
