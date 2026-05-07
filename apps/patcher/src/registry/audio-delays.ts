// Delay-line nodes. tapin~/tapout~ pair lets you write feedback patches
// without hitting topo-sort cycles — tapin~ is the write head, tapout~
// is a read head; the cord between them is implicitly delayed.

import { num, flushDenormals, type Node as UNode } from "@unworklet/core";
import { register } from "./store";

const MAX_DELAY = 96000; // 2 seconds at 48k

// delay~ — fixed delay (no feedback). Inlets: in, delaySamples.
register({
  type: "delay~",
  category: "audio-delay",
  description: "Fixed-delay line (no feedback). Inlets: in, delay (samples).",
  inlets: [
    { kind: "audio", label: "in" },
    { kind: "audio", label: "delay" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [1000],
  build: (ctx, args) => {
    const buf = ctx.buffer.f32({ size: MAX_DELAY, name: `${ctx.id}_buf` });
    const head = ctx.state.i32(0, { name: `${ctx.id}_head` });
    const x = ctx.inAudio(0);
    const dSamp = ctx.inControl(1, args[0] ?? 1000);
    const h = head.load();
    const wIdx = h.mod(MAX_DELAY);
    const rIdx = h.sub((dSamp as UNode<"f32">).toI32()).add(MAX_DELAY).mod(MAX_DELAY);
    buf.write(wIdx, x);
    head.store(h.add(1));
    return [buf.read(rIdx)];
  },
});

// tapin~ — feedback-friendly write head. The delay buffer is shared with
// tapout~ siblings via attrs.busName. Standard Max idiom: connect a
// `tapin~` to one or more `tapout~` reads of various lengths.
//
// Implementation: tapin~ owns the buffer; tapout~ references it via the
// patch-level `busName` attr. We model this as a single-instance pair
// for now (one tapin → one tapout) — for more complex routing, the user
// would use multiple gen~/buffer~ nodes. The cord from tapin → tapout
// is treated as a feedback break.
register({
  type: "tapin~",
  category: "audio-delay",
  description: "Delay write head. Pair with tapout~ for feedback delays.",
  inlets: [{ kind: "audio", label: "in" }],
  outlets: [{ kind: "audio", label: "out" }], // tapin re-emits its buffer-bus reference
  attrs: [{ name: "busName", kind: "string", default: "delaybus" }],
  defaultArgs: [],
  build: (ctx) => {
    const buf = ctx.buffer.f32({ size: MAX_DELAY, name: `${ctx.id}_buf` });
    const head = ctx.state.i32(0, { name: `${ctx.id}_head` });
    const x = ctx.inAudio(0);
    const h = head.load();
    const wIdx = h.mod(MAX_DELAY);
    buf.write(wIdx, x);
    head.store(h.add(1));
    // Outlet 0 is a "reference" — downstream nodes grab the head + buffer
    // through the connection. To make this composable, we use a sentinel
    // value (the current write index) and let tapout~ subtract its delay.
    // For simplicity in this demo we pass the input through unchanged so
    // the cord-feedback case works — actual feedback comes via tapout~
    // wiring to a state-bearing node downstream.
    return [x];
  },
});

// tapout~ — reads from a shared delay buffer at a given offset. Inlet 0:
// the upstream tapin~ signal (provides the bus reference); inlet 1:
// delay length in samples.
register({
  type: "tapout~",
  category: "audio-delay",
  description: "Delay read tap. Inlet 0: tapin~. Inlet 1: delay (samples).",
  inlets: [
    { kind: "audio", label: "tapin" },
    { kind: "audio", label: "delay" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  defaultArgs: [350],
  build: (ctx, args) => {
    // tapout~ keeps its own buffer mirror — the tapin~ signal flows in,
    // we write it, then read at offset. Equivalent to a delay~ node, but
    // semantically this is the "feedback-friendly" form: when the user
    // wires tapin~ → tapout~ → ... → tapin~, the cord is allowed to
    // form a cycle because of the buffer write.
    const buf = ctx.buffer.f32({ size: MAX_DELAY, name: `${ctx.id}_buf` });
    const head = ctx.state.i32(0, { name: `${ctx.id}_head` });
    const x = ctx.inAudio(0);
    const dSamp = ctx.inControl(1, args[0] ?? 350);
    const h = head.load();
    const wIdx = h.mod(MAX_DELAY);
    const rIdx = h.sub((dSamp as UNode<"f32">).toI32()).add(MAX_DELAY).mod(MAX_DELAY);
    buf.write(wIdx, x);
    head.store(h.add(1));
    return [flushDenormals(buf.read(rIdx))];
  },
});
