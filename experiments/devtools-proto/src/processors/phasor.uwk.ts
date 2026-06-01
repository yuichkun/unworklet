// @ts-nocheck — sugar is a TS error until lowered; the plugin lowers it at build.
//
// Minimal `.uwk.ts` processor for the Part-4 browser e2e: a mono sawtooth phasor.
// It exercises state read/write, bare-state-as-operator-operand, arithmetic +
// modulo sugar, and index-write — enough that "process() really ran on the audio
// thread and produced finite, non-zero signal" is a meaningful end-to-end proof.
const out = audioOutput({ channels: 1, name: "main" });
const phase = state.f32(0);

process(() => {
  forSample((i) => {
    out.ch(0)[i] = phase * 2 - 1;
    phase.write((phase + 0.01) % 1);
  });
});
