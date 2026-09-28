// granular.uwk.ts — a MIDI-played windowed grain voice
const out  = audioOutput({ channels: 1, name: "main" });
const keys = event.midi({ from: "main", name: "keys" });

const grain = 4096;                               // grain length (samples)
const pos   = state.f32(grain).named("pos");      // samples since noteOn (≥grain = idle)
const phase = state.f32(0).named("phase");
const step  = state.f32(0).named("step");         // phase increment per sample

process(() => {
  keys.onEvent("noteOn", ({ note }) => {
    const hz = exp(f32(note - 69) * (Math.LN2 / 12)) * 440;
    step.write(hz / 48000);
    pos.write(0);     // (re)trigger the grain
    phase.write(0);
  });
  forSample((i) => {
    // Hann window over the grain: rises then falls across its length
    const env = pos < grain ? (0.5 - 0.5 * cos(pos * ((Math.PI * 2) / grain))) : 0;
    out.ch(0)[i] = sin(phase * (Math.PI * 2)) * env * 0.6;
    phase.write((phase + step) % 1);
    pos.write(pos < grain ? pos + 1 : pos);
  });
});
