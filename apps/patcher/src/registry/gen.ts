// gen~ — inline-code subgraph. The user's code text in attrs.code is
// compiled at patch-compile-time using the eval-shim pattern from
// apps/playground/src/codeplayground/runtime.ts, wrapped in a
// `defineSubgraph(...)`, then called at the gen~ node's position in the
// outer patch.
//
// Conventions for the user's code (deliberately minimal):
//   - Every unworklet symbol is in scope (no imports needed).
//   - Inlets are positional args: in1, in2, in3, in4 (Node<f32>).
//   - The code must `return [out1, out2, ...]` — array of audio outputs.
//
// Example:
//   const phase = state.f32(0);
//   const inc = in1.div(48000);
//   const next = phase.load().add(inc).mod(1);
//   phase.store(next);
//   return [next.mul(2).sub(1)];

import * as core from "@unworklet/core";
import type { Node as UNode } from "@unworklet/core";
import { register } from "./store";

const DEFAULT_CODE = `// gen~: write a defineSubgraph body.
// Every unworklet symbol is in scope. \`in1\` is the first audio inlet.
// Return an array of audio outputs.
const phase = state.f32(0);
const inc = in1.div(48000);
const next = phase.load().add(inc).mod(1);
phase.store(next);
return [next.mul(2).sub(1)];
`;

register({
  type: "gen~",
  category: "structural",
  description:
    "Inline-code subgraph (Max gen~ equivalent). Edit code; compiles to defineSubgraph.",
  inlets: [
    { kind: "audio", label: "in1" },
    { kind: "audio", label: "in2" },
    { kind: "audio", label: "in3" },
    { kind: "audio", label: "in4" },
  ],
  outlets: [
    { kind: "audio", label: "out1" },
    { kind: "audio", label: "out2" },
    { kind: "audio", label: "out3" },
    { kind: "audio", label: "out4" },
  ],
  attrs: [
    { name: "code", kind: "code", default: DEFAULT_CODE },
    { name: "outletCount", kind: "number", default: 1, min: 1, max: 4 },
  ],
  defaultAttrs: { code: DEFAULT_CODE, outletCount: 1 },
  build: (ctx, _args, attrs) => {
    const code = (attrs.code as string) || DEFAULT_CODE;
    const outletCount = (attrs.outletCount as number) ?? 1;
    // Wrap the user code in a defineSubgraph so each gen~ instance has its
    // own state pool. Inside the subgraph body, in1..in4 are the args.
    const sub = core.defineSubgraph(
      (...inputs: UNode<"f32">[]) => {
        // Build a fresh runtime closure that injects every unworklet binding
        // plus in1..in4 named args.
        const fn = new Function(
          "core",
          "in1", "in2", "in3", "in4",
          // bindings
          "add", "sub", "mul", "div", "mod", "neg", "min", "max", "abs", "clamp",
          "eq", "ne", "lt", "gt", "lte", "gte",
          "sin", "cos", "tan", "tanh", "exp", "log", "sqrt", "floor", "ceil", "frac",
          "select", "f32", "f64", "i32", "i64", "num", "flushDenormals",
          "state", "buffer", "param",
          `"use strict"; return (function() { ${code} })();`,
        );
        const result = fn(
          core,
          inputs[0] ?? core.num(0),
          inputs[1] ?? core.num(0),
          inputs[2] ?? core.num(0),
          inputs[3] ?? core.num(0),
          core.add, core.sub, core.mul, core.div, core.mod, core.neg, core.min, core.max, core.abs, core.clamp,
          core.eq, core.ne, core.lt, core.gt, core.lte, core.gte,
          core.sin, core.cos, core.tan, core.tanh, core.exp, core.log, core.sqrt, core.floor, core.ceil, core.frac,
          core.select, core.f32, core.f64, core.i32, core.i64, core.num, core.flushDenormals,
          core.state, core.buffer, core.param,
        );
        if (!Array.isArray(result)) {
          throw new Error("gen~ user code must return an array of outputs.");
        }
        return result;
      },
    );

    const outs = sub(
      ctx.inAudio(0),
      ctx.inAudio(1),
      ctx.inAudio(2),
      ctx.inAudio(3),
    );
    // Return only outletCount outputs; pad with silence if user returned fewer.
    const result: UNode<"f32">[] = [];
    for (let i = 0; i < outletCount; i++) {
      result.push((outs[i] as UNode<"f32">) ?? (core.num(0) as UNode<"f32">));
    }
    return result;
  },
  component: "GenView",
});
