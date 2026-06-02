/**
 * Every demo example, rendered offline and checked for the behaviour it
 * advertises — using `@unworklet/test`'s own matchers and signal / MIDI builders,
 * the toolkit the README points users to. The demo compiles these same `.uwk.ts`
 * sources in the browser; if one were silently broken, "live examples" becomes a
 * lie, so each is driven through `renderOffline` here and asserted with the
 * published matchers (no ears required). Dogfooding the matchers is the point:
 * the demo's tests are written the way a user's would be.
 *
 * `renderOffline` runs the lowered processor on the Node side (binaryen → WASM),
 * the same lower step the browser uses, so a green run here means the source is
 * real DSP, not a decorative string.
 */
import { renderOffline } from "@unworklet/offline";
import {
  dc,
  expectAudioMatches,
  expectEventCount,
  expectEventsContaining,
  expectGainAtFreq,
  expectMidiOut,
  expectPeakAtSample,
  expectPeakUnder,
  expectRmsUnder,
  expectStable,
  impulse,
  midi,
  ramp,
  sine,
} from "@unworklet/test";
import { expect, test } from "vite-plus/test";

import { lowerToProcessor } from "@unworklet/lang/browser";

import { exampleBySlug } from "./examples.ts";

const SR = 48_000;
const FRAMES = 2048;
const DURATION = FRAMES / SR;

function sourceOf(slug: string): string {
  const ex = exampleBySlug(slug);
  if (!ex) throw new Error(`no example registered: ${slug}`);
  return ex.source;
}

type RenderOpts = Parameters<typeof renderOffline>[1];
async function render(slug: string, opts: Partial<RenderOpts> = {}) {
  return renderOffline(lowerToProcessor(sourceOf(slug)), {
    sampleRate: SR,
    duration: DURATION,
    ...opts,
  } as RenderOpts);
}

/** A pure tone for `FRAMES` samples — `@unworklet/test`'s `sine`, pinned to the demo's rate. */
const tone = (amplitude: number, freqHz = 220): Float32Array =>
  sine({ freqHz, durationSamples: FRAMES, sampleRate: SR, amplitude });

/**
 * Does any sample cross `floor`? The matcher set asserts upper bounds and silence
 * but has no positive "is audible" matcher, so a presence check stays inline.
 */
const isAudible = (ch: Float32Array, floor = 0.02): boolean => ch.some((v) => Math.abs(v) > floor);

test("distortion: an overdriven signal saturates to the ±1 rails, never NaN", async () => {
  const x = tone(0.5); // ×drive(4) = ±2 → must clip
  const r = await render("distortion", { inputs: { main: [x, x] } });
  expectStable(r);
  expectPeakUnder(r, 0.1); // never past the rails (±1.0 ≈ 0 dBFS)
  // No matcher asserts "reaches a level", so the rail-touch is checked directly.
  const l = r.outputs.main![0]!;
  expect(Math.max(...l)).toBeCloseTo(1, 2); // hits the top rail
  expect(Math.min(...l)).toBeCloseTo(-1, 2); // and the bottom
});

test("lowpass: a step input ramps smoothly toward it ($prev feedback works)", async () => {
  const r = await render("lowpass", { inputs: { main: [dc(FRAMES), dc(FRAMES)] } });
  expectStable(r);
  expectPeakUnder(r, 0.1); // never overshoots the input
  const l = r.outputs.main![0]!;
  expect(l[0]!).toBeCloseTo(0.2, 2); // first sample = k·x = 0.2
  expect(l[10]!).toBeGreaterThan(l[0]!); // rising
  expect(l[FRAMES - 1]!).toBeGreaterThan(0.99); // converged toward the input
});

test("tremolo: a constant input comes out amplitude-modulated by the LFO", async () => {
  const r = await render("tremolo", { inputs: { main: [dc(FRAMES), dc(FRAMES)] } });
  expectStable(r);
  expectPeakUnder(r, 0.1);
  const l = r.outputs.main![0]!;
  expect(Math.max(...l) - Math.min(...l)).toBeGreaterThan(0.05); // the wobble is real
});

test("bitcrush: a fine ramp collapses onto a small set of quantization levels", async () => {
  const x = ramp({ durationSamples: FRAMES, from: -1, to: 1 });
  const r = await render("bitcrush", { inputs: { main: [x, x] } });
  expectStable(r);
  const l = r.outputs.main![0]!;
  const levels = new Set(Array.from(l, (v) => Math.round(v * 1e4))).size;
  expect(levels).toBeLessThan(80); // 5 bits → ~64 levels, far below 2048 inputs
  expect(levels).toBeGreaterThan(2); // but not collapsed to a constant
});

test("gain-meter: applies the 0.8 gain; the 30 fps meter publish doesn't break offline render", async () => {
  const x = tone(0.5, 468.75); // bin-aligned (= 20 × 23.4375 Hz) for a clean FFT read
  const r = await render("gain-meter", { inputs: { main: [x, x] } });
  expectStable(r);
  // input 0.5 × default gain 0.8 = 0.4 → 20·log10(0.4) = −7.96 dBFS
  expectGainAtFreq(r, 468.75, -7.96, 0.8, { channel: 0 });
});

test("eq3: unity gains reconstruct the input; boosting low lifts a low tone", async () => {
  const t = tone(0.5, 300);
  const flat = await render("eq3", { inputs: { main: [t, t] } });
  expectAudioMatches(flat, [t, t], { tolerance: 1e-3 }); // low+mid+high sum back to x at unity

  const low = tone(0.4, 70.3125); // bin-aligned low tone (= 3 × 23.4375 Hz)
  const boosted = await render("eq3", {
    inputs: { main: [low, low] },
    params: { low: [2], mid: [1], high: [1] },
  });
  const unity = await render("eq3", { inputs: { main: [low, low] } });
  // unity passes the 0.4 tone (−7.96 dBFS); low×2 ≈ doubles the low band (≈ −2 dBFS)
  expectGainAtFreq(unity, 70.3125, -7.96, 0.6, { channel: 0 });
  expectGainAtFreq(boosted, 70.3125, -2.0, 1.5, { channel: 0 });
});

test("limiter: clamps a loud signal near the ceiling and fires overshoot events", async () => {
  const r = await render("limiter", { inputs: { main: [tone(0.9)] } });
  expectStable(r);
  expectPeakUnder(r, -4.0); // gain-reduced toward ceiling 0.5 (well under the 0.9 input)
  expectEventsContaining(r, [{ name: "overshoot" }]); // it fired at least one

  const quiet = await render("limiter", { inputs: { main: [tone(0.2)] } });
  expectEventCount(quiet, "overshoot", 0); // below the ceiling → no limiting, no events
});

test("synth: a MIDI noteOn produces a non-silent tone; noteOff returns to silence", async () => {
  const on = await render("synth", {
    events: midi.sequence("keys", [{ at: 0, event: midi.noteOn({ note: 69, velocity: 100 }) }]),
  });
  expectStable(on);
  expect(isAudible(on.outputs.main![0]!, 0.05)).toBe(true); // it actually sounds
  expectPeakUnder(on, -12); // ×0.2 gain, no runaway (≤ ~0.25)

  const off = await render("synth", {
    events: midi.sequence("keys", [
      { at: 0, event: midi.noteOn({ note: 69, velocity: 100 }) },
      { at: 1, event: midi.noteOff({ note: 69 }) },
    ]),
  });
  expectRmsUnder(off, -40); // gate closed → silent
});

test("reverb: an impulse leaves a finite, stable, decaying tail; mix=0 is dry-only", async () => {
  const imp = impulse(FRAMES);
  const wet = await render("reverb", { inputs: { main: [imp] }, params: { mix: [0.6] } });
  expectStable(wet);
  expectPeakUnder(wet, 9.6); // feedback < 1 → bounded (≤ ~3)
  const w = wet.outputs.main![0]!;
  let tail = 0;
  for (let i = 200; i < FRAMES; i++) tail += Math.abs(w[i]!);
  expect(tail).toBeGreaterThan(0.05); // a real decaying tail

  const dry = await render("reverb", { inputs: { main: [imp] }, params: { mix: [0] } });
  expectAudioMatches(dry, [imp], { tolerance: 1e-6 }); // mix=0 → output IS the dry input
});

test("linear-phase: symmetric impulse response (linear phase) + lowpass attenuation", async () => {
  const ir = await render("linear-phase", { inputs: { main: [impulse(FRAMES)] } });
  expectStable(ir);
  expectPeakAtSample(ir, 4, { tolerance: 0 }); // center tap (weight 5) dominates at sample 4
  const h = ir.outputs.main![0]!;
  for (let k = 1; k <= 4; k++) {
    expect(Math.abs(h[4 - k]! - h[4 + k]!)).toBeLessThan(1e-5); // symmetric ⇒ linear phase
  }

  // passband ≈ unity, stopband deeply attenuated (input amp 0.5, both bin-aligned)
  const lo = await render("linear-phase", { inputs: { main: [tone(0.5, 281.25)] } });
  const hi = await render("linear-phase", { inputs: { main: [tone(0.5, 12000)] } });
  expectGainAtFreq(lo, 281.25, -6.05, 0.6); // 0.5 × |H|≈1.0 → −6 dBFS
  expectGainAtFreq(hi, 12000, -34, 2.0); // 0.5 × |H|=0.04 → −34 dBFS
});

test("arp: a held note arpeggiates the chord [+0,+4,+7,+12] — audible blips + MIDI out", async () => {
  const r = await render("arp", {
    events: midi.sequence("keys", [{ at: 0, event: midi.noteOn({ note: 60, velocity: 100 }) }]),
  });
  expectStable(r);
  expect(isAudible(r.outputs.main![0]!)).toBe(true); // blips are audible
  expectPeakUnder(r, -12); // ≤ ~0.25
  // the first two steps emit the +4 and +7 chord tones on the arpOut MIDI port
  expectEventsContaining(r, [
    { name: "arpOut", payload: midi.noteOn({ note: 64, velocity: 100 }) },
    { name: "arpOut", payload: midi.noteOn({ note: 67, velocity: 100 }) },
  ]);
});

test("polysynth: a 3-note chord sounds, stays bounded, and is louder than one note", async () => {
  const chord = await render("polysynth", {
    events: midi.sequence("keys", [
      { at: 0, event: midi.noteOn({ note: 60, velocity: 100 }) },
      { at: 0, event: midi.noteOn({ note: 64, velocity: 100 }) },
      { at: 0, event: midi.noteOn({ note: 67, velocity: 100 }) },
    ]),
  });
  expectStable(chord);
  expect(isAudible(chord.outputs.main![0]!)).toBe(true);
  expectPeakUnder(chord, -3); // ≤ ~0.7

  const single = await render("polysynth", {
    events: midi.sequence("keys", [{ at: 0, event: midi.noteOn({ note: 60, velocity: 100 }) }]),
  });
  // −17 dBFS sits between one voice and the chord, so the matcher itself proves "louder"
  expectRmsUnder(single, -17); // one voice is quieter
  expect(() => expectRmsUnder(chord, -17)).toThrow(); // the chord is louder
});

test("granular: a MIDI noteOn fires an audible windowed grain; finite and bounded", async () => {
  const r = await render("granular", {
    events: midi.sequence("keys", [{ at: 0, event: midi.noteOn({ note: 60, velocity: 100 }) }]),
  });
  expectStable(r);
  expect(isAudible(r.outputs.main![0]!)).toBe(true); // the grain sounds
  expectPeakUnder(r, 0.1); // ≤ ~1.0
});

test("harmonizer: sonifies the note AND emits a fifth-up noteOn on the harmony port", async () => {
  const r = await render("harmonizer", {
    events: midi.sequence("keys", [{ at: 0, event: midi.noteOn({ note: 60, velocity: 100 }) }]),
  });
  expectStable(r);
  expect(isAudible(r.outputs.main![0]!)).toBe(true); // original note audible
  expectMidiOut(r, "harmony", [midi.noteOn({ note: 67, velocity: 100 })]); // 60 + 7
});
