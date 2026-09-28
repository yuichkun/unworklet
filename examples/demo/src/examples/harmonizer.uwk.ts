// harmonizer.uwk.ts — sonify each note + emit a fifth above on MIDI out
const out     = audioOutput({ channels: 1, name: "main" });
const keys    = event.midi({ from: "main", name: "keys" });
const harmony = event.midi({ to: "main", name: "harmony" });

const hz    = state.f32(440).named();
const gate  = state.f32(0).named();
const phase = state.f32(0).named();

process(() => {
  keys.onEvent("noteOn", ({ note, velocity }) => {
    hz.write(exp(f32(note - 69) * (Math.LN2 / 12)) * 440);
    gate.write(1);
    // re-emit a perfect fifth (note + 7) on the "harmony" out port
    harmony.emitIf(velocity > 0, { type: "noteOn", channel: 0, note: note + 7, velocity: 100, atSample: 0 });
  });
  keys.onEvent("noteOff", () => gate.write(0));
  forSample((i) => {
    phase.write((phase + hz / 48000) % 1);
    out.ch(0)[i] = sin(phase * (Math.PI * 2)) * gate * 0.2;
  });
});
