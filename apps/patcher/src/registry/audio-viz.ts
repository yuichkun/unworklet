// Visualization nodes. They tap an audio signal and publish either:
// - a per-sample buffer (scope~, spectroscope~) — main thread reads via
//   node.state.<name>.subscribe(view)
// - a peak f32 state slot (meter~, number~) — main thread polls via
//   node.state.<name>.value
//
// All viz nodes are passthrough on the audio side (audio in → audio out =
// in) so they can be inserted inline in a patch.

import { type Node as UNode } from "@unworklet/core";
import { register } from "./store";

const SCOPE_LEN = 1024;

// scope~ — oscilloscope. Pushes successive samples into a ring buffer that
// the main thread reads at ~30 fps for visualization.
register({
  type: "scope~",
  category: "audio-viz",
  description: "Oscilloscope. Passthrough; main-side reads buffer at 30 fps.",
  inlets: [{ kind: "audio", label: "in" }],
  outlets: [{ kind: "audio", label: "out" }],
  component: "ScopeView",
  build: (ctx) => {
    const buf = ctx.buffer.f32({
      size: SCOPE_LEN,
      name: `${ctx.id}_scope`,
      publish: { rateFps: 30 },
    });
    const head = ctx.state.i32(0, { name: `${ctx.id}_scopeHead` });
    const x = ctx.inAudio(0);
    const h = head.load().mod(SCOPE_LEN);
    buf.write(h, x);
    head.store(h.add(1));
    return [x];
  },
});

// meter~ — peak meter. State slot holding the rolling peak of |x|.
register({
  type: "meter~",
  category: "audio-viz",
  description: "Peak meter. Passthrough; main-side reads peak via .value.",
  inlets: [{ kind: "audio", label: "in" }],
  outlets: [{ kind: "audio", label: "out" }],
  component: "MeterView",
  build: (ctx) => {
    const peak = ctx.state.f32(0, {
      name: `${ctx.id}_peak`,
      publish: { rateFps: 30 },
    });
    const x = ctx.inAudio(0);
    peak.store(peak.load().mul(0.92).max(x.abs()));
    return [x];
  },
});

// spectroscope~ — same buffer-publish as scope~; the UI does FFT on the
// main thread. Audio path is passthrough.
register({
  type: "spectroscope~",
  category: "audio-viz",
  description: "Spectroscope. Passthrough; FFT done main-side over published buffer.",
  inlets: [{ kind: "audio", label: "in" }],
  outlets: [{ kind: "audio", label: "out" }],
  component: "SpectroscopeView",
  build: (ctx) => {
    const buf = ctx.buffer.f32({
      size: SCOPE_LEN,
      name: `${ctx.id}_spec`,
      publish: { rateFps: 30 },
    });
    const head = ctx.state.i32(0, { name: `${ctx.id}_specHead` });
    const x = ctx.inAudio(0);
    const h = head.load().mod(SCOPE_LEN);
    buf.write(h, x);
    head.store(h.add(1));
    return [x];
  },
});

// number~ — published f32 state. Main thread polls via .value at ~10 fps.
register({
  type: "number~",
  category: "audio-viz",
  description: "Audio-rate number readout. Latest sample published to main.",
  inlets: [{ kind: "audio", label: "in" }],
  outlets: [{ kind: "audio", label: "out" }],
  component: "NumberView",
  build: (ctx) => {
    const s = ctx.state.f32(0, {
      name: `${ctx.id}_val`,
      publish: { rateFps: 10 },
    });
    const x = ctx.inAudio(0);
    s.store(x);
    return [x];
  },
});
