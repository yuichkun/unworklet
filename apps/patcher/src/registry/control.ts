// Control-rate nodes — operate on a-rate signals at audio rate but treat
// values as scalars / events rather than audio. In our patcher we model
// every cord as a-rate signal flow internally; "control nodes" are just
// nodes that do simple math/logic and operate on the same data path.

import { num, i32, select, type Node as UNode } from "@unworklet/core";
import { register } from "./store";

function makeBinary(
  type: string,
  category: "control" | "audio-math",
  op: (a: UNode<"f32">, b: UNode<"f32">) => UNode<"f32">,
  desc: string,
  defArg = 0,
) {
  register({
    type,
    category,
    description: desc,
    inlets: [
      { kind: "control", label: "L" },
      { kind: "control", label: "R" },
    ],
    outlets: [{ kind: "control", label: "out" }],
    defaultArgs: [defArg],
    build: (ctx, args) => {
      const a = ctx.inControl(0, 0);
      const b = ctx.inControl(1, args[0] ?? defArg);
      return [op(a as UNode<"f32">, b as UNode<"f32">)];
    },
  });
}

makeBinary("+", "control", (a, b) => a.add(b), "Add (control rate).", 0);
makeBinary("-", "control", (a, b) => a.sub(b), "Subtract (control rate).", 0);
makeBinary("*", "control", (a, b) => a.mul(b), "Multiply (control rate).", 1);
makeBinary("/", "control", (a, b) => a.div(b), "Divide (control rate).", 1);
makeBinary("==", "control", (a, b) => a.eq(b).toF32(), "Equal (1 if equal else 0).", 0);
makeBinary("!=", "control", (a, b) => a.ne(b).toF32(), "Not equal.", 0);
makeBinary("<", "control", (a, b) => a.lt(b).toF32(), "Less than.", 0);
makeBinary(">", "control", (a, b) => a.gt(b).toF32(), "Greater than.", 0);
makeBinary("<=", "control", (a, b) => a.lte(b).toF32(), "Less or equal.", 0);
makeBinary(">=", "control", (a, b) => a.gte(b).toF32(), "Greater or equal.", 0);
makeBinary("min", "control", (a, b) => a.min(b), "Min.", 0);
makeBinary("max", "control", (a, b) => a.max(b), "Max.", 0);

// abs — single inlet.
register({
  type: "abs",
  category: "control",
  description: "Absolute value (control).",
  inlets: [{ kind: "control", label: "in" }],
  outlets: [{ kind: "control", label: "out" }],
  build: (ctx) => [(ctx.inControl(0, 0) as UNode<"f32">).abs()],
});

// scale — linear remap. Args: inLo, inHi, outLo, outHi.
register({
  type: "scale",
  category: "control",
  description: "Linear remap. Args: inLo, inHi, outLo, outHi.",
  inlets: [{ kind: "control", label: "in" }],
  outlets: [{ kind: "control", label: "out" }],
  defaultArgs: [0, 1, 0, 1],
  build: (ctx, args) => {
    const x = ctx.inControl(0, 0) as UNode<"f32">;
    const inLo = args[0] ?? 0;
    const inHi = args[1] ?? 1;
    const outLo = args[2] ?? 0;
    const outHi = args[3] ?? 1;
    return [x.sub(inLo).div(inHi - inLo).mul(outHi - outLo).add(outLo)];
  },
});

// gate — pass through if cond ≥ 0.5, else 0.
register({
  type: "gate",
  category: "control",
  description: "Control gate. Inlet 0: cond. Inlet 1: in. Out: in if cond ≥ 0.5 else 0.",
  inlets: [
    { kind: "control", label: "cond" },
    { kind: "control", label: "in" },
  ],
  outlets: [{ kind: "control", label: "out" }],
  build: (ctx) => {
    const cond = ctx.inControl(0, 0) as UNode<"f32">;
    const x = ctx.inControl(1, 0) as UNode<"f32">;
    return [select(cond.gte(0.5), x, 0) as UNode<"f32">];
  },
});

// sel / select — fires bang on outlet i if input == arg[i]. We model it
// as N parallel comparisons since the patcher's value model is f32.
register({
  type: "sel",
  category: "control",
  description: "select N. Outlet[i] = (in == args[i]) ? 1 : 0. Outlet[N] = passthrough.",
  inlets: [{ kind: "control", label: "in" }],
  outlets: [
    { kind: "control", label: "0" },
    { kind: "control", label: "1" },
    { kind: "control", label: "2" },
    { kind: "control", label: "3" },
    { kind: "control", label: "rest" },
  ],
  defaultArgs: [0, 1, 2, 3],
  build: (ctx, args) => {
    const x = ctx.inControl(0, 0) as UNode<"f32">;
    const a = (args[0] ?? 0);
    const b = (args[1] ?? 1);
    const c = (args[2] ?? 2);
    const d = (args[3] ?? 3);
    return [
      x.eq(a).toF32(),
      x.eq(b).toF32(),
      x.eq(c).toF32(),
      x.eq(d).toF32(),
      x,
    ];
  },
});

// random — output a random number in [0, args[0]).  Re-rolled on rising
// edge of inlet 0.
register({
  type: "random",
  category: "control",
  description: "Random integer in [0, n). Re-rolls on rising-edge trigger.",
  inlets: [{ kind: "control", label: "trig" }],
  outlets: [{ kind: "control", label: "out" }],
  defaultArgs: [128],
  build: (ctx, args) => {
    const seed = ctx.state.i32(0xBABE_FACE | 0, { name: `${ctx.id}_seed` });
    const held = ctx.state.f32(0, { name: `${ctx.id}_held` });
    const wasHigh = ctx.state.bool(false, { name: `${ctx.id}_high` });
    const trig = ctx.inControl(0, 0) as UNode<"f32">;
    const n = args[0] ?? 128;
    const r = seed.load().mul(1103515245).add(12345);
    seed.store(r);
    const fresh = r.toF32().mul(1 / 2147483648).abs().mul(n).floor();
    const isHigh = trig.gte(0.5);
    const fire = select(isHigh, wasHigh.load().eq(false), false);
    held.store(select(fire, fresh, held.load()));
    wasHigh.store(isHigh);
    return [held.load()];
  },
});

// expr — generic 2-input arithmetic; the expression is the args[0] string,
// stored as an attribute. We provide a few built-in expressions; for full
// flexibility users should reach for gen~.
register({
  type: "expr",
  category: "control",
  description: "Quick 2-input expression. Args: 'add' | 'sub' | 'mul' | 'div' | 'mod'.",
  inlets: [
    { kind: "control", label: "x" },
    { kind: "control", label: "y" },
  ],
  outlets: [{ kind: "control", label: "out" }],
  defaultArgs: ["add"],
  build: (ctx, args) => {
    const x = ctx.inControl(0, 0) as UNode<"f32">;
    const y = ctx.inControl(1, 0) as UNode<"f32">;
    switch ((args[0] ?? "add") as string) {
      case "sub": return [x.sub(y)];
      case "mul": return [x.mul(y)];
      case "div": return [x.div(y)];
      case "mod": return [x.mod(y)];
      default: return [x.add(y)];
    }
  },
});

// route — 1 inlet, N outlets. Inlet 0 selects which outlet to pass the
// upstream value through. Other outlets emit 0.
register({
  type: "route",
  category: "control",
  description: "Route inlet 0 (value) to outlet selected by inlet 1 (idx). Others emit 0.",
  inlets: [
    { kind: "control", label: "value" },
    { kind: "control", label: "idx" },
  ],
  outlets: [
    { kind: "control", label: "0" },
    { kind: "control", label: "1" },
    { kind: "control", label: "2" },
    { kind: "control", label: "3" },
  ],
  build: (ctx) => {
    const v = ctx.inControl(0, 0) as UNode<"f32">;
    const i = (ctx.inControl(1, 0) as UNode<"f32">).toI32();
    return [
      select(i.eq(0), v, 0) as UNode<"f32">,
      select(i.eq(1), v, 0) as UNode<"f32">,
      select(i.eq(2), v, 0) as UNode<"f32">,
      select(i.eq(3), v, 0) as UNode<"f32">,
    ];
  },
});

// t / trigger — fire all N outlets in order with the inlet value. We
// emit identical copies on each outlet (Max's actual t reorders bang
// firing; the audio-side equivalent is just a fan-out).
register({
  type: "t",
  category: "control",
  description: "Trigger fan-out. Inlet → all outlets.",
  inlets: [{ kind: "control", label: "in" }],
  outlets: [
    { kind: "control", label: "1" },
    { kind: "control", label: "2" },
    { kind: "control", label: "3" },
  ],
  build: (ctx) => {
    const x = ctx.inControl(0, 0) as UNode<"f32">;
    return [x, x, x];
  },
});

// pak — pack 2 numbers; outputs first via outlet 0, second via outlet 1.
// (Real Max pak emits a list message; we simplify to pass-through fan-out.)
register({
  type: "pak",
  category: "control",
  description: "Pack 2 numbers (pass-through to two outlets).",
  inlets: [
    { kind: "control", label: "a" },
    { kind: "control", label: "b" },
  ],
  outlets: [
    { kind: "control", label: "a" },
    { kind: "control", label: "b" },
  ],
  build: (ctx) => [
    ctx.inControl(0, 0) as UNode<"f32">,
    ctx.inControl(1, 0) as UNode<"f32">,
  ],
});

// unpack — symmetric to pak in our simplified model.
register({
  type: "unpack",
  category: "control",
  description: "Unpack 2 numbers (pass-through to two outlets).",
  inlets: [
    { kind: "control", label: "a" },
    { kind: "control", label: "b" },
  ],
  outlets: [
    { kind: "control", label: "a" },
    { kind: "control", label: "b" },
  ],
  build: (ctx) => [
    ctx.inControl(0, 0) as UNode<"f32">,
    ctx.inControl(1, 0) as UNode<"f32">,
  ],
});
