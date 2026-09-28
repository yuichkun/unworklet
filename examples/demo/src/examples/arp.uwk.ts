// arp.uwk.ts — a monophonic MIDI arpeggiator
const out    = audioOutput({ channels: 1, name: "main" });
const keys   = event.midi({ from: "main", name: "keys" });
const arpOut = event.midi({ to: "main", name: "arpOut" });

const root    = state.i32(60).named();  // latched root note
const playing = state.i32(0).named();   // 1 while a key is held
const step    = state.i32(0).named();   // index into the chord pattern
const counter = state.i32(0).named();   // samples since the last step
const hz      = state.f32(0).named();   // current blip frequency
const phase   = state.f32(0).named();
const env     = state.f32(0).named();   // blip amplitude envelope

process(() => {
  keys.onEvent("noteOn", ({ note }) => {
    root.write(note);
    playing.write(1);
  });
  keys.onEvent("noteOff", () => playing.write(0));

  forSample((i) => {
    const samplesPerStep = 256;
    const held = playing > 0;
    const advance = held ? counter >= samplesPerStep - 1 : false;
    counter.write(advance ? i32(0) : held ? counter + 1 : i32(0));
    const nextStep = advance ? (step + 1) % 4 : step;
    step.write(nextStep);
    // chord-tone offset for the step [+0,+4,+7,+12]
    const offset = nextStep === 0 ? i32(0) : nextStep === 1 ? i32(4) : nextStep === 2 ? i32(7) : i32(12);
    const note = root + offset;
    hz.write(advance ? exp(f32(note - 69) * (Math.LN2 / 12)) * 440 : hz);
    env.write(advance ? 1 : env * 0.999);
    arpOut.emitIf(advance, { type: "noteOn", channel: 0, note, velocity: 100, atSample: i });
    phase.write((phase + hz / 48000) % 1);
    out.ch(0)[i] = sin(phase * (Math.PI * 2)) * env * f32(playing) * 0.2;
  });
});
