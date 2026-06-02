// The example registry. Each entry is a live `.uwk.ts` source the demo lowers +
// compiles in the browser. `kind` drives how the demo drives it: an `effect`
// processes an input signal (a built-in sawtooth or a file you load); an
// `instrument` is played by sending it MIDI notes.

export type ExampleKind = "effect" | "instrument";

export type Example = {
  slug: string;
  title: string;
  blurb: string;
  kind: ExampleKind;
  source: string;
  /** MIDI port name on the node, for instruments (e.g. `keys`). */
  midiPort?: string;
};

const DISTORTION = `// distortion.uwk.ts — soft-clip distortion
const input = audioInput({ channels: 2, name: "main" });
const out   = audioOutput({ channels: 2, name: "main" });
const drive = param.f32({ default: 4, min: 1, max: 20, automationRate: "a-rate" }).named();

process(() => {
  forSample((i) => {
    const l = input.left[i] * drive[i];
    const r = input.right[i] * drive[i];
    out.left[i]  = l > 1 ? 1 : l < -1 ? -1 : l;   // soft clip via ?:
    out.right[i] = r > 1 ? 1 : r < -1 ? -1 : r;
  });
});
`;

const SYNTH = `// synth.uwk.ts — a monophonic MIDI sine voice
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
`;

const LOWPASS = `// lowpass.uwk.ts — a one-pole lowpass (per channel)
const input  = audioInput({ channels: 2, name: "main" });
const out    = audioOutput({ channels: 2, name: "main" });
const cutoff = param.f32({ default: 0.2, min: 0.01, max: 1 }).named();

// y[n] = k*x[n] + (1-k)*y[n-1]   ($prev = previous output)
const onepole = defineSubgraph((k: Node<"f32">) => ({
  process: (x: Node<"f32">) => k * x + (1 - k) * $prev,
}));
const lpL = createSubgraph(onepole, f32(0.2), { name: "lpL" });
const lpR = createSubgraph(onepole, f32(0.2), { name: "lpR" });

process(() => {
  forSample((i) => {
    out.left[i]  = lpL.process(input.left[i]);
    out.right[i] = lpR.process(input.right[i]);
  });
});
`;

const TREMOLO = `// tremolo.uwk.ts — amplitude wobble from an LFO
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
`;

const BITCRUSH = `// bitcrush.uwk.ts — quantize the signal to N bits
const input = audioInput({ channels: 2, name: "main" });
const out   = audioOutput({ channels: 2, name: "main" });
const bits  = param.f32({ default: 5, min: 1, max: 16 }).named();

process(() => {
  forSample((i) => {
    const steps = floor(exp(bits[i] * Math.LN2));           // 2^bits levels
    out.left[i]  = floor(input.left[i] * steps) / steps;
    out.right[i] = floor(input.right[i] * steps) / steps;
  });
});
`;

const GAINMETER = `// gain-meter.uwk.ts — a gain knob + a 30 fps output level meter
const input = audioInput({ channels: 2, name: "main" });
const out   = audioOutput({ channels: 2, name: "main" });
const gain  = param.f32({ default: 0.8, min: 0, max: 2, automationRate: "a-rate" }).named();

// a transient state published to the main thread 30×/sec — drives a live meter
const level = state.f32(0).expose({ snapshot: "transient", publish: { rateFps: 30 } });

process(() => {
  forSample((i) => {
    const l = input.left[i] * gain[i];
    const r = input.right[i] * gain[i];
    out.left[i]  = l;
    out.right[i] = r;
    const mag = l < 0 ? -l : l;                 // |left|
    level.write(mag > level ? mag : level * 0.99); // peak-hold, slow decay
  });
});
`;

const EQ3 = `// eq3.uwk.ts — a 3-band tone control (low / mid / high)
const input = audioInput({ channels: 2, name: "main" });
const out   = audioOutput({ channels: 2, name: "main" });
const low   = param.f32({ default: 1, min: 0, max: 2 }).named();
const mid   = param.f32({ default: 1, min: 0, max: 2 }).named();
const high  = param.f32({ default: 1, min: 0, max: 2 }).named();

// one-pole lowpass: k·x + (1-k)·$prev  ($prev = the previous output)
const lp = defineSubgraph((k: Node<"f32">) => ({
  process: (x: Node<"f32">) => k * x + (1 - k) * $prev,
}));
const loL = createSubgraph(lp, f32(0.08), { name: "loL" }); // low band
const loR = createSubgraph(lp, f32(0.08), { name: "loR" });
const hiL = createSubgraph(lp, f32(0.5), { name: "hiL" });  // low+mid split
const hiR = createSubgraph(lp, f32(0.5), { name: "hiR" });

process(() => {
  forSample((i) => {
    const xL = input.left[i];
    const bassL = loL.process(xL);
    const splitL = hiL.process(xL);
    // low + mid + high, each scaled; at unity gains the three bands sum back to x
    out.left[i] = bassL * low[i] + (splitL - bassL) * mid[i] + (xL - splitL) * high[i];
    const xR = input.right[i];
    const bassR = loR.process(xR);
    const splitR = hiR.process(xR);
    out.right[i] = bassR * low[i] + (splitR - bassR) * mid[i] + (xR - splitR) * high[i];
  });
});
`;

const LIMITER = `// limiter.uwk.ts — a lookahead limiter that fires an overshoot event
const input   = audioInput({ channels: 1, name: "main" });
const out     = audioOutput({ channels: 1, name: "main" });
const ceiling = param.f32({ default: 0.5, min: 0.05, max: 1, automationRate: "a-rate" }).named();

const dly  = state.buffer.f32({ size: 64 }).named("dly"); // lookahead delay line
const head = state.i32(0).named("head");
const env  = state.f32(0).named("env");
// a typed event back to the main thread, fired sample-accurately on an overshoot
const overshoot = event({ to: "main", name: "overshoot" });

process(() => {
  forSample((i) => {
    const x = input.ch(0)[i];
    const mag = x < 0 ? -x : x;
    env.write(mag > env ? mag : env * 0.9995);      // fast attack, slow release
    const w = head;                                  // current write head (i32)
    dly[w] = x;                                       // delay-line write
    const delayed = dly[(w + 1) % 64];                // read the oldest sample
    const g = env > ceiling[i] ? ceiling[i] / env : 1; // gain reduction
    out.ch(0)[i] = delayed * g;
    head.write((w + 1) % 64);
    overshoot.emitIf(mag > ceiling[i], { atSample: i, level: mag });
  });
});
`;

const REVERB = `// reverb.uwk.ts — a small feedback reverb (4 comb filters + 1 allpass)
const input = audioInput({ channels: 1, name: "main" });
const out   = audioOutput({ channels: 1, name: "main" });
const mix   = param.f32({ default: 0.5, min: 0, max: 1 }).named();

// four parallel feedback combs, prime-ish delay lengths (Schroeder/Freeverb-style)
const c0 = state.buffer.f32({ size: 1116 }).named("c0");
const c1 = state.buffer.f32({ size: 1188 }).named("c1");
const c2 = state.buffer.f32({ size: 1277 }).named("c2");
const c3 = state.buffer.f32({ size: 1356 }).named("c3");
const h0 = state.i32(0).named("h0");
const h1 = state.i32(0).named("h1");
const h2 = state.i32(0).named("h2");
const h3 = state.i32(0).named("h3");
const a0 = state.buffer.f32({ size: 556 }).named("a0"); // allpass diffuser
const ah = state.i32(0).named("ah");

process(() => {
  forSample((i) => {
    const x = input.ch(0)[i];
    const w0 = h0; const r0 = c0[w0]; c0[w0] = x + r0 * 0.7; h0.write((w0 + 1) % 1116);
    const w1 = h1; const r1 = c1[w1]; c1[w1] = x + r1 * 0.7; h1.write((w1 + 1) % 1188);
    const w2 = h2; const r2 = c2[w2]; c2[w2] = x + r2 * 0.7; h2.write((w2 + 1) % 1277);
    const w3 = h3; const r3 = c3[w3]; c3[w3] = x + r3 * 0.7; h3.write((w3 + 1) % 1356);
    const combs = (r0 + r1 + r2 + r3) * 0.25;
    const wa = ah; const da = a0[wa];
    const apOut = -0.5 * combs + da;
    a0[wa] = combs + 0.5 * apOut;
    ah.write((wa + 1) % 556);
    out.ch(0)[i] = (1 - mix[i]) * x + mix[i] * apOut; // dry / wet
  });
});
`;

const LINEARPHASE = `// linear-phase.uwk.ts — a symmetric (linear-phase) FIR lowpass
const input = audioInput({ channels: 1, name: "main" });
const out   = audioOutput({ channels: 1, name: "main" });

// 9-tap triangular kernel [1,2,3,4,5,4,3,2,1]/25. Symmetric taps (c_k = c_{8-k})
// are exactly what make the filter linear phase. A ring buffer holds the last 9
// samples; the output is the kernel convolved with that window (scalar FIR).
const z    = state.buffer.f32({ size: 9 }).named("z");
const head = state.i32(0).named("head");

process(() => {
  forSample((i) => {
    const w = head;
    z[w] = input.ch(0)[i];                  // newest sample x[n]
    const x0 = z[w];
    const x1 = z[(w + 8) % 9];
    const x2 = z[(w + 7) % 9];
    const x3 = z[(w + 6) % 9];
    const x4 = z[(w + 5) % 9];
    const x5 = z[(w + 4) % 9];
    const x6 = z[(w + 3) % 9];
    const x7 = z[(w + 2) % 9];
    const x8 = z[(w + 1) % 9];
    out.ch(0)[i] =
      (x0 * 1 + x8 * 1 + x1 * 2 + x7 * 2 + x2 * 3 + x6 * 3 + x3 * 4 + x5 * 4 + x4 * 5) / 25;
    head.write((w + 1) % 9);
  });
});
`;

const ARP = `// arp.uwk.ts — a monophonic MIDI arpeggiator
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
`;

const POLYSYNTH = `// polysynth.uwk.ts — a 4-voice polyphonic MIDI synth
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
`;

const GRANULAR = `// granular.uwk.ts — a MIDI-played windowed grain voice
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
`;

const HARMONIZER = `// harmonizer.uwk.ts — sonify each note + emit a fifth above on MIDI out
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
`;

export const examples: Example[] = [
  {
    slug: "distortion",
    title: "Distortion",
    blurb: "A soft-clip distortion — `?:`, index access, infix math, a param. Feed it a signal.",
    kind: "effect",
    source: DISTORTION,
  },
  {
    slug: "lowpass",
    title: "One-pole lowpass",
    blurb: "A feedback filter written as one line of math — `$prev` is the previous output sample.",
    kind: "effect",
    source: LOWPASS,
  },
  {
    slug: "tremolo",
    title: "Tremolo",
    blurb: "An LFO wobbling the amplitude — a `state` phasor, `cos`, infix math.",
    kind: "effect",
    source: TREMOLO,
  },
  {
    slug: "bitcrush",
    title: "Bitcrusher",
    blurb: "Quantize the signal to N bits — `floor` / `exp`, per-sample math on the input.",
    kind: "effect",
    source: BITCRUSH,
  },
  {
    slug: "gain-meter",
    title: "Gain + level meter",
    blurb:
      "A gain knob plus a `state` published 30×/sec — `expose({ publish })` drives a live meter.",
    kind: "effect",
    source: GAINMETER,
  },
  {
    slug: "eq3",
    title: "Three-band EQ",
    blurb:
      "Low / mid / high tone controls from one-pole crossovers — `defineSubgraph`, `$prev`, params.",
    kind: "effect",
    source: EQ3,
  },
  {
    slug: "limiter",
    title: "Lookahead limiter",
    blurb:
      "A delay-line limiter that clamps to a ceiling and fires a sample-accurate `event` on overshoot.",
    kind: "effect",
    source: LIMITER,
  },
  {
    slug: "reverb",
    title: "Feedback reverb",
    blurb:
      "Four feedback combs + an allpass diffuser from `state.buffer` delay lines, with a dry/wet mix.",
    kind: "effect",
    source: REVERB,
  },
  {
    slug: "linear-phase",
    title: "Linear-phase FIR",
    blurb:
      "A 9-tap symmetric FIR convolution via a `state.buffer` ring — symmetric taps give linear phase.",
    kind: "effect",
    source: LINEARPHASE,
  },
  {
    slug: "synth",
    title: "MIDI sine synth",
    blurb:
      "A monophonic voice driven by MIDI `noteOn` / `noteOff` — `event.midi`, state, an oscillator.",
    kind: "instrument",
    source: SYNTH,
    midiPort: "keys",
  },
  {
    slug: "arp",
    title: "MIDI arpeggiator",
    blurb:
      "Hold a note — it arpeggiates a chord, blips audibly, and emits `noteOn`s on a MIDI out port.",
    kind: "instrument",
    source: ARP,
    midiPort: "keys",
  },
  {
    slug: "polysynth",
    title: "4-voice polysynth",
    blurb:
      "Four round-robin voices — `noteOn` steals the next voice, `noteOff` releases the matching one.",
    kind: "instrument",
    source: POLYSYNTH,
    midiPort: "keys",
  },
  {
    slug: "granular",
    title: "Granular grain voice",
    blurb:
      "A pitched, Hann-windowed grain retriggered on each `noteOn` — `state.buffer`, an envelope.",
    kind: "instrument",
    source: GRANULAR,
    midiPort: "keys",
  },
  {
    slug: "harmonizer",
    title: "MIDI harmonizer",
    blurb:
      "Sonifies each note and emits a fifth above on a MIDI out port — `event.midi` in → out rewriting.",
    kind: "instrument",
    source: HARMONIZER,
    midiPort: "keys",
  },
];

export const exampleBySlug = (slug: string): Example | undefined =>
  examples.find((e) => e.slug === slug);
