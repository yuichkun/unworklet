import type { Node as UNode } from "@unworklet/core";
import { register } from "./store";

// One-input audio-rate math functions. All map directly to chain methods.
function makeUnary(type: string, op: (a: UNode<"f32">) => UNode<"f32">, desc: string) {
  register({
    type,
    category: "audio-trig",
    description: desc,
    inlets: [{ kind: "audio", label: "in" }],
    outlets: [{ kind: "audio", label: "out" }],
    build: (ctx) => [op(ctx.inAudio(0))],
  });
}

makeUnary("sin~", (a) => a.sin(), "sin~ — sin(x) signal-rate.");
makeUnary("cos~", (a) => a.cos(), "cos~ — cos(x) signal-rate.");
makeUnary("tan~", (a) => a.tan(), "tan~ — tan(x) signal-rate.");
makeUnary("tanh~", (a) => a.tanh(), "tanh~ — tanh(x) signal-rate (cheap soft-clipper).");
makeUnary("exp~", (a) => a.exp(), "exp~ — e^x signal-rate.");
makeUnary("log~", (a) => a.log(), "log~ — ln(x) signal-rate.");
makeUnary("sqrt~", (a) => a.sqrt(), "sqrt~ — √x signal-rate.");
makeUnary("floor~", (a) => a.floor(), "floor~ — floor(x).");
makeUnary("ceil~", (a) => a.ceil(), "ceil~ — ceil(x).");
makeUnary("round~", (a) => a.add(0.5).floor(), "round~ — round(x).");
