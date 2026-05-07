// Delay-line nodes. tapin~/tapout~ pair lets you write feedback patches
// without hitting topo-sort cycles — tapin~ owns a delay buffer + write
// head shared (via attrs.bus) with one or more tapout~ read heads. The
// cord between tapin~ and any tapout~ is treated as a feedback break.

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

// Shared bus shape: a buffer + write-head pair owned by the first tapin~
// declaring it, looked up by tapout~ via attrs.bus.
type DelayBus = {
  buf: ReturnType<typeof import("@unworklet/core").buffer.f32>;
  head: ReturnType<typeof import("@unworklet/core").state.i32>;
};

function getBus(ctx: any, busName: string): DelayBus {
  return ctx.shared(`tapbus:${busName}`, () => {
    const buf = ctx.buffer.f32({ size: MAX_DELAY, name: `tapbus_${busName}` });
    const head = ctx.state.i32(0, { name: `tapbus_${busName}_head` });
    return { buf, head };
  });
}

// tapin~ — feedback-friendly write head. Uses the shared bus identified by
// attrs.bus (default "delaybus"). The cord from tapin~ to tapout~ is a
// "ghost" connection at the patch level — at compile time we already share
// the buffer, so the cord just visually expresses the relationship.
register({
  type: "tapin~",
  category: "audio-delay",
  description: "Delay write head. tapout~ siblings on the same bus read the same buffer.",
  inlets: [{ kind: "audio", label: "in" }],
  outlets: [{ kind: "audio", label: "out" }],
  attrs: [{ name: "bus", kind: "string", default: "delaybus" }],
  defaultAttrs: { bus: "delaybus" },
  build: (ctx, _args, attrs) => {
    const bus = getBus(ctx, String(attrs.bus ?? "delaybus"));
    const x = ctx.inAudio(0);
    const h = bus.head.load();
    const wIdx = h.mod(MAX_DELAY);
    bus.buf.write(wIdx, x);
    // tapin~ advances the bus head exactly once per sample. (Multiple
    // tapin~ on one bus would double-advance — discouraged but handled by
    // each emitting its own write at its own offset.)
    bus.head.store(h.add(1));
    return [x];
  },
});

// tapout~ — reads from the shared bus at a given delay (samples). Inlet 0
// is wired to the originating tapin~ for visual clarity, but the actual
// data flow is via the shared bus.
register({
  type: "tapout~",
  category: "audio-delay",
  description: "Delay read tap. attrs.bus matches a tapin~ on the same bus.",
  inlets: [
    { kind: "audio", label: "tapin" },
    { kind: "audio", label: "delay" },
  ],
  outlets: [{ kind: "audio", label: "out" }],
  attrs: [{ name: "bus", kind: "string", default: "delaybus" }],
  defaultAttrs: { bus: "delaybus" },
  defaultArgs: [350],
  build: (ctx, args, attrs) => {
    const bus = getBus(ctx, String(attrs.bus ?? "delaybus"));
    const dSamp = ctx.inControl(1, args[0] ?? 350);
    const h = bus.head.load();
    // Read at h - dSamp - 1 (the most-recently-written sample before
    // tapin~ advances on the next iteration).
    const offset = (dSamp as UNode<"f32">).toI32().add(1);
    const rIdx = h.sub(offset).add(MAX_DELAY * 2).mod(MAX_DELAY);
    return [flushDenormals(bus.buf.read(rIdx))];
  },
});
