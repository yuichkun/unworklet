import { num, type Node as UNode } from "@unworklet/core";
import { register } from "./store";

// Two-arg signal math: signal-rate left in inlet 0, right in inlet 1
// (or arg fallback).
function makeBinary(type: string, op: (a: UNode<"f32">, b: UNode<"f32">) => UNode<"f32">, defArg = 1) {
  register({
    type,
    category: "audio-math",
    description: `${type} — signal-rate operator.`,
    inlets: [
      { kind: "audio", label: "L" },
      { kind: "audio", label: "R" },
    ],
    outlets: [{ kind: "audio", label: "out" }],
    defaultArgs: [defArg],
    build: (ctx, args) => {
      const a = ctx.inAudio(0);
      const b = ctx.inControl(1, args[0] ?? defArg);
      return [op(a, b as UNode<"f32">)];
    },
  });
}

makeBinary("+~", (a, b) => a.add(b), 0);
makeBinary("-~", (a, b) => a.sub(b), 0);
makeBinary("*~", (a, b) => a.mul(b), 1);
makeBinary("/~", (a, b) => a.div(b), 1);
makeBinary("%~", (a, b) => a.mod(b), 1);
makeBinary("pow~", (a, b) => a.log().mul(b).exp(), 2);
makeBinary("min~", (a, b) => a.min(b), 0);
makeBinary("max~", (a, b) => a.max(b), 0);

// Unary (single audio inlet).
function makeUnary(type: string, op: (a: UNode<"f32">) => UNode<"f32">, desc: string) {
  register({
    type,
    category: "audio-math",
    description: desc,
    inlets: [{ kind: "audio", label: "in" }],
    outlets: [{ kind: "audio", label: "out" }],
    build: (ctx) => [op(ctx.inAudio(0))],
  });
}

makeUnary("abs~", (a) => a.abs(), "abs~ — |x| signal-rate.");
makeUnary("neg~", (a) => a.neg(), "neg~ — -x signal-rate.");

// clip~ — clamp to (lo, hi) range.
register({
  type: "clip~",
  category: "audio-math",
  description: "clip~ — clamp(x, lo, hi). Inlets: in, lo, hi.",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "lo" },
    { kind: "audio", label: "hi" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [-1, 1],
  build: (ctx, args) => {
    const x = ctx.inAudio(0);
    const lo = ctx.inControl(1, args[0] ?? -1);
    const hi = ctx.inControl(2, args[1] ?? 1);
    return [x.clamp(lo as any, hi as any)];
  },
});

// scale~ — linear interpolation: out = a + (b - a) * (x - inLo) / (inHi - inLo)
register({
  type: "scale~",
  category: "audio-math",
  description: "scale~ — linear remap. Inlets: in. Args: inLo, inHi, outLo, outHi.",
  inlets: [{ kind: "audio", label: "in" }],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [0, 1, 0, 1],
  build: (ctx, args) => {
    const x = ctx.inAudio(0);
    const inLo = args[0] ?? 0;
    const inHi = args[1] ?? 1;
    const outLo = args[2] ?? 0;
    const outHi = args[3] ?? 1;
    const norm = x.sub(inLo).div(inHi - inLo);
    return [norm.mul(outHi - outLo).add(outLo)];
  },
});
