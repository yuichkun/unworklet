// tremolo.uwk.ts — amplitude wobble from an LFO
const input = audioInput({ channels: 2, name: "main" });
const out   = audioOutput({ channels: 2, name: "main" });
const rate  = param.f32({ default: 6, min: 0.1, max: 20 }).named();
const depth = param.f32({ default: 0.9, min: 0, max: 1 }).named();
const lfo   = state.f32(0).named();

process(() => {
  forSample((i) => {
    lfo.write((lfo + rate[i] / 48000) % 1);                 // phase 0..1
    const g = 1 - depth[i] * (0.5 - 0.5 * cos(lfo * (Math.PI * 2)));
    out.left[i]  = input.left[i] * g;
    out.right[i] = input.right[i] * g;
  });
});
