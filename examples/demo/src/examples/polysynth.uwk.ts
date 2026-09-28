// polysynth.uwk.ts — a 4-voice polyphonic MIDI synth
const out  = audioOutput({ channels: 1, name: "main" });
const keys = event.midi({ from: "main", name: "keys" });

// four fixed voices (no arrays): hz / gate / phase each
const hz0 = state.f32(0).named(); const hz1 = state.f32(0).named();
const hz2 = state.f32(0).named(); const hz3 = state.f32(0).named();
const gate0 = state.f32(0).named(); const gate1 = state.f32(0).named();
const gate2 = state.f32(0).named(); const gate3 = state.f32(0).named();
const phase0 = state.f32(0).named(); const phase1 = state.f32(0).named();
const phase2 = state.f32(0).named(); const phase3 = state.f32(0).named();
const next = state.i32(0).named();   // round-robin voice pointer

process(() => {
  keys.onEvent("noteOn", ({ note }) => {
    const f = exp(f32(note - 69) * (Math.LN2 / 12)) * 440;
    const slot = next % 4;
    hz0.write(slot === 0 ? f : hz0); hz1.write(slot === 1 ? f : hz1);
    hz2.write(slot === 2 ? f : hz2); hz3.write(slot === 3 ? f : hz3);
    gate0.write(slot === 0 ? 1 : gate0); gate1.write(slot === 1 ? 1 : gate1);
    gate2.write(slot === 2 ? 1 : gate2); gate3.write(slot === 3 ? 1 : gate3);
    next.write((next + 1) % 4);
  });
  keys.onEvent("noteOff", ({ note }) => {
    const f = exp(f32(note - 69) * (Math.LN2 / 12)) * 440;
    // close voices tuned to this note (|hz - f| < 0.5). No '&&' in sugar → use abs distance.
    gate0.write(abs(hz0 - f) < 0.5 ? 0 : gate0); gate1.write(abs(hz1 - f) < 0.5 ? 0 : gate1);
    gate2.write(abs(hz2 - f) < 0.5 ? 0 : gate2); gate3.write(abs(hz3 - f) < 0.5 ? 0 : gate3);
  });
  forSample((i) => {
    phase0.write((phase0 + hz0 / 48000) % 1); phase1.write((phase1 + hz1 / 48000) % 1);
    phase2.write((phase2 + hz2 / 48000) % 1); phase3.write((phase3 + hz3 / 48000) % 1);
    const v0 = sin(phase0 * (Math.PI * 2)) * gate0;
    const v1 = sin(phase1 * (Math.PI * 2)) * gate1;
    const v2 = sin(phase2 * (Math.PI * 2)) * gate2;
    const v3 = sin(phase3 * (Math.PI * 2)) * gate3;
    out.ch(0)[i] = (v0 + v1 + v2 + v3) * 0.15;
  });
});
