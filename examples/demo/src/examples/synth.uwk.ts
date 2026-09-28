// synth.uwk.ts — a monophonic MIDI sine voice
const out  = audioOutput({ channels: 1, name: "main" });
const keys = event.midi({ from: "main", name: "keys" });

const hz    = state.f32(440).named();
const gate  = state.f32(0).named();
const phase = state.f32(0).named();

process(() => {
  keys.onEvent("noteOn", ({ note }) => {
    hz.write(exp(f32(note - 69) * (Math.LN2 / 12)) * 440); // MIDI note → Hz
    gate.write(1);
  });
  keys.onEvent("noteOff", () => gate.write(0));

  forSample((i) => {
    phase.write((phase + hz / 48000) % 1);            // advance the oscillator
    out.ch(0)[i] = sin(phase * (Math.PI * 2)) * gate * 0.2;
  });
});
