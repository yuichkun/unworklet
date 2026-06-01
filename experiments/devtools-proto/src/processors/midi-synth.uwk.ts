// @ts-nocheck — sugar is a TS error until lowered; the plugin lowers it at build.
//
// RC-20-style MIDI synth voice — Tier-B `.uwk.ts`. Monophonic sine driven by Web
// MIDI; f64 phase accumulation. The `event.midi` port auto-derives its name ("notes")
// from the binding, the onEvent handlers stay as-is, and the equal-temperament
// frequency math reads as math via operator + free-function sugar (f32/f64 casts kept).
const SAMPLE_RATE = 48000;
const TWO_PI = 2 * Math.PI;
const PHASE_INC_PER_HZ = TWO_PI / SAMPLE_RATE;
const LN2_OVER_12 = Math.LN2 / 12;

const out = audioOutput({ channels: 1, name: "main" });
const notes = event.midi({ from: "main" });

const phase = state.f64(0).named();
const note = state.i32(69).named(); // default A4
const gate = state.bool(false).named();

process(() => {
  notes.onEvent("noteOn", ({ note: n }) => {
    note.write(n);
    gate.write(true);
  });
  notes.onEvent("noteOff", () => {
    gate.write(false);
  });

  forSample((i) => {
    // note → Hz via equal temperament: 440 * 2^((note-69)/12).
    const freqHz = exp((f32(note.read()) - 69) * LN2_OVER_12) * 440;
    const inc = freqHz * PHASE_INC_PER_HZ;
    const p = (phase.read() + f64(inc)) % TWO_PI;
    const gain = select(gate, 0.3, 0);
    out.ch(0)[i] = f32(sin(p)) * gain;
    phase.write(p);
  });
});
