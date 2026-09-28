// The example registry. Each entry names a `.uwk.ts` source in `./examples/`.
// `kind` drives how the demo drives it: an `effect` processes an input signal
// (a built-in oscillator, noise or a file you load); an `instrument` is played
// by sending it MIDI notes. This list carries no sources so plain Node can read
// it; `examples.ts` joins it with the sources for the app.

export type ExampleKind = "effect" | "instrument";

export type ExampleInfo = {
  slug: string;
  title: string;
  blurb: string;
  kind: ExampleKind;
  /** MIDI port name on the node, for instruments (e.g. `keys`). */
  midiPort?: string;
};

export const exampleList: ExampleInfo[] = [
  {
    slug: "distortion",
    title: "Distortion",
    blurb: "A soft-clip distortion — `?:`, index access, infix math, a param. Feed it a signal.",
    kind: "effect",
  },
  {
    slug: "lowpass",
    title: "One-pole lowpass",
    blurb: "A feedback filter written as one line of math — `$prev` is the previous output sample.",
    kind: "effect",
  },
  {
    slug: "tremolo",
    title: "Tremolo",
    blurb: "An LFO wobbling the amplitude — a `state` phasor, `cos`, infix math.",
    kind: "effect",
  },
  {
    slug: "bitcrush",
    title: "Bitcrusher",
    blurb: "Quantize the signal to N bits — `floor` / `exp`, per-sample math on the input.",
    kind: "effect",
  },
  {
    slug: "gain-meter",
    title: "Gain + level meter",
    blurb:
      "A gain knob plus a `state` published 30×/sec — `expose({ publish })` drives a live meter.",
    kind: "effect",
  },
  {
    slug: "eq3",
    title: "Three-band EQ",
    blurb:
      "Low / mid / high tone controls from one-pole crossovers — `defineSubgraph`, `$prev`, params.",
    kind: "effect",
  },
  {
    slug: "limiter",
    title: "Lookahead limiter",
    blurb:
      "A delay-line limiter that clamps to a ceiling and fires a sample-accurate `event` on overshoot.",
    kind: "effect",
  },
  {
    slug: "reverb",
    title: "Feedback reverb",
    blurb:
      "Four feedback combs + an allpass diffuser from `state.buffer` delay lines, with a dry/wet mix.",
    kind: "effect",
  },
  {
    slug: "linear-phase",
    title: "Linear-phase FIR",
    blurb:
      "A 9-tap symmetric FIR convolution via a `state.buffer` ring — symmetric taps give linear phase.",
    kind: "effect",
  },
  {
    slug: "synth",
    title: "MIDI sine synth",
    blurb:
      "A monophonic voice driven by MIDI `noteOn` / `noteOff` — `event.midi`, state, an oscillator.",
    kind: "instrument",
    midiPort: "keys",
  },
  {
    slug: "arp",
    title: "MIDI arpeggiator",
    blurb:
      "Hold a note — it arpeggiates a chord, blips audibly, and emits `noteOn`s on a MIDI out port.",
    kind: "instrument",
    midiPort: "keys",
  },
  {
    slug: "polysynth",
    title: "4-voice polysynth",
    blurb:
      "Four round-robin voices — `noteOn` steals the next voice, `noteOff` releases the matching one.",
    kind: "instrument",
    midiPort: "keys",
  },
  {
    slug: "granular",
    title: "Granular grain voice",
    blurb:
      "A pitched, Hann-windowed grain retriggered on each `noteOn` — `state.buffer`, an envelope.",
    kind: "instrument",
    midiPort: "keys",
  },
  {
    slug: "harmonizer",
    title: "MIDI harmonizer",
    blurb:
      "Sonifies each note and emits a fifth above on a MIDI out port — `event.midi` in → out rewriting.",
    kind: "instrument",
    midiPort: "keys",
  },
];
