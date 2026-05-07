// Conversion nodes: MIDI ↔ Hz, dB ↔ amplitude, ms ↔ samples.

import { num, type Node as UNode } from "@unworklet/core";
import { register } from "./store";

register({
  type: "mtof~",
  category: "audio-conv",
  description: "MIDI note → Hz. f = 440 × 2^((n - 69) / 12).",
  inlets: [{ kind: "audio", label: "midi" }],
  outlets: [{ kind: "audio", label: "Hz" }],
  build: (ctx) => [ctx.inAudio(0).sub(69).mul(Math.LN2 / 12).exp().mul(440)],
});

register({
  type: "ftom~",
  category: "audio-conv",
  description: "Hz → MIDI note. n = 69 + 12 × log2(f / 440).",
  inlets: [{ kind: "audio", label: "Hz" }],
  outlets: [{ kind: "audio", label: "midi" }],
  build: (ctx) => [ctx.inAudio(0).div(440).log().mul(12 / Math.LN2).add(69)],
});

register({
  type: "dbtoa~",
  category: "audio-conv",
  description: "dB → linear amplitude. a = 10^(dB/20).",
  inlets: [{ kind: "audio", label: "dB" }],
  outlets: [{ kind: "audio", label: "amp" }],
  build: (ctx) => [ctx.inAudio(0).mul(Math.LN10 / 20).exp()],
});

register({
  type: "atodb~",
  category: "audio-conv",
  description: "Linear amplitude → dB. dB = 20 × log10(a).",
  inlets: [{ kind: "audio", label: "amp" }],
  outlets: [{ kind: "audio", label: "dB" }],
  build: (ctx) => [ctx.inAudio(0).log().mul(20 / Math.LN10)],
});

register({
  type: "mstosamps~",
  category: "audio-conv",
  description: "ms → samples at the current sample rate.",
  inlets: [{ kind: "audio", label: "ms" }],
  outlets: [{ kind: "audio", label: "samps" }],
  build: (ctx) => [ctx.inAudio(0).mul(ctx.sampleRate / 1000)],
});

register({
  type: "sampstoms~",
  category: "audio-conv",
  description: "samples → ms at the current sample rate.",
  inlets: [{ kind: "audio", label: "samps" }],
  outlets: [{ kind: "audio", label: "ms" }],
  build: (ctx) => [ctx.inAudio(0).mul(1000 / ctx.sampleRate)],
});
