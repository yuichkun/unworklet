// function — breakpoint curve editor. Stores an array of [x, y] breakpoints
// in attrs.points (x in 0..1, y in attrs.minY..attrs.maxY). At audio-rate
// the build samples the curve at the current phasor position (inlet 0)
// using piecewise-linear interpolation between breakpoints.
//
// The Vue component lets the user drag breakpoints around the canvas to
// shape the curve in real time; the patch hot-swaps when points change.

import { num, select, type Node as UNode } from "@unworklet/core";
import { register } from "./store";

const MAX_POINTS = 16;

register({
  type: "function",
  category: "ui",
  description: "Breakpoint curve editor. Sample with a 0..1 phasor on inlet 0.",
  inlets: [{ kind: "audio", label: "x (0..1)" }],
  outlets: [{ kind: "audio", label: "y" }],
  attrs: [
    { name: "minY", kind: "number", default: 0 },
    { name: "maxY", kind: "number", default: 1 },
    {
      name: "points",
      kind: "string",
      default: "[[0,0],[0.25,1],[0.5,0.3],[0.75,0.5],[1,0]]",
    },
  ],
  defaultAttrs: {
    minY: 0,
    maxY: 1,
    points: "[[0,0],[0.25,1],[0.5,0.3],[0.75,0.5],[1,0]]",
  },
  build: (ctx, _args, attrs) => {
    let pts: Array<[number, number]>;
    try {
      pts = JSON.parse(String(attrs.points ?? "[]"));
    } catch {
      pts = [[0, 0], [1, 0]];
    }
    if (pts.length < 2) pts = [[0, 0], [1, 1]];
    pts.sort((a, b) => a[0] - b[0]);
    if (pts.length > MAX_POINTS) pts = pts.slice(0, MAX_POINTS);

    const x = ctx.inAudio(0).clamp(0, 1);
    // Piecewise-linear: each segment contributes y linearly interpolated
    // from y0 to y1 based on (x - x0) / (x1 - x0), gated by 0/1 indicators
    // for "x is in this segment". The result sums all segment contributions.
    // Unrolled at compile time.
    let y: UNode<"f32"> = num(0) as UNode<"f32">;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i]!;
      const [x1, y1] = pts[i + 1]!;
      const span = Math.max(1e-9, x1 - x0);
      const t = x.sub(x0).div(span).clamp(0, 1);
      const segVal = num(y0).add(t.mul(y1 - y0));
      // x is "in" this segment if x0 <= x < x1 (or for the last segment,
      // x0 <= x <= 1). Use ≥ x0 AND < x1 as a 0/1 indicator.
      const isLast = i === pts.length - 2;
      const inLo = x.gte(x0);
      const inHi = isLast ? x.lte(x1) : x.lt(x1);
      const inSeg = select(inLo, select(inHi, num(1), num(0)), num(0)) as UNode<"f32">;
      y = y.add((segVal as UNode<"f32">).mul(inSeg)) as UNode<"f32">;
    }
    return [y];
  },
  component: "FunctionView",
});
