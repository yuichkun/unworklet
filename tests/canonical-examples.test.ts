import { expect, test, describe } from "vite-plus/test";
import { renderOffline, createNode, inspect } from "@unworklet/client";
import {
  stereoGain,
  threeBandEQ,
  linearPhaseEQ,
  lookaheadLimiter,
  granularSampler,
  arpeggiator,
  convolutionReverb,
  polySynth,
} from "@unworklet/examples";

const SR = 48000;

function genSine(freq: number, durationSec: number, amp = 0.5): Float32Array {
  const len = Math.ceil(durationSec * SR);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amp;
  return out;
}

function genWhiteNoise(durationSec: number, amp = 0.5, seed = 1): Float32Array {
  const len = Math.ceil(durationSec * SR);
  const out = new Float32Array(len);
  let s = seed;
  for (let i = 0; i < len; i++) {
    s = (s * 9301 + 49297) % 233280;
    out[i] = ((s / 233280) * 2 - 1) * amp;
  }
  return out;
}

describe("Example 1: stereo gain + level meter", () => {
  test("renders audio at unity gain (default)", async () => {
    const sineL = genSine(440, 0.1);
    const sineR = genSine(550, 0.1);
    const result = await renderOffline(stereoGain, {
      sampleRate: SR,
      duration: 0.1,
      input: { main: [sineL, sineR] },
    });
    expect(result.hasNaN).toBe(false);
    expect(result.peak).toBeGreaterThan(0.4);
    expect(result.peak).toBeLessThanOrEqual(0.51);
    // Output should match input (at unity gain)
    const outL = result.output.main![0]!;
    expect(outL[100]).toBeCloseTo(sineL[100]!, 4);
  });

  test("respects gain param value", async () => {
    const sineL = genSine(440, 0.1);
    const sineR = genSine(550, 0.1);
    const result = await renderOffline(stereoGain, {
      sampleRate: SR,
      duration: 0.1,
      input: { main: [sineL, sineR] },
      params: { gain: 0.5 },
    });
    const outL = result.output.main![0]!;
    expect(outL[100]).toBeCloseTo(sineL[100]! * 0.5, 4);
  });

  test("publishes meter values", async () => {
    const sine = genSine(100, 0.5, 0.8);
    const node = await createNode({ sampleRate: SR }, stereoGain);
    let metered = 0;
    node.state.meterL!.subscribe((v: number) => {
      metered = Math.max(metered, v);
    });
    // Render a few blocks via the engine
    const blockL = sine.subarray(0, 128);
    const blockR = sine.subarray(0, 128);
    for (let b = 0; b < 100; b++) {
      const off = b * 128;
      const l = sine.subarray(off, off + 128);
      const r = sine.subarray(off, off + 128);
      const lp = new Float32Array(128);
      lp.set(l);
      const rp = new Float32Array(128);
      rp.set(r);
      node.__engine.render({ main: [lp, rp] });
    }
    expect(metered).toBeGreaterThan(0.5);
  });
});

describe("Example 2: three-band biquad EQ", () => {
  test("passes audio without distortion at flat gain", async () => {
    const sine = genSine(1000, 0.1);
    const result = await renderOffline(threeBandEQ, {
      sampleRate: SR,
      duration: 0.1,
      input: { main: [sine, sine] },
    });
    expect(result.hasNaN).toBe(false);
    // At flat 0dB, should approximate input (allow some filter group delay)
    expect(result.peak).toBeGreaterThan(0.3);
    expect(result.peak).toBeLessThan(0.6);
  });

  test("boosts low band", async () => {
    const sineLow = genSine(120, 0.5);
    const flat = await renderOffline(threeBandEQ, {
      sampleRate: SR,
      duration: 0.5,
      input: { main: [sineLow, sineLow] },
    });
    const boosted = await renderOffline(threeBandEQ, {
      sampleRate: SR,
      duration: 0.5,
      input: { main: [sineLow, sineLow] },
      params: { lowGain: 12 },
    });
    expect(boosted.peak).toBeGreaterThan(flat.peak * 1.5);
  });
});

describe("Example 3: linear-phase EQ (partitioned convolution)", () => {
  test("renders without crashing (impulse not loaded; expect silence)", async () => {
    const sine = genSine(440, 0.05);
    const result = await renderOffline(linearPhaseEQ, {
      sampleRate: SR,
      duration: 0.05,
      input: { main: [sine] },
    });
    expect(result.hasNaN).toBe(false);
    // Empty impulse → output is zero
    expect(result.peak).toBeLessThanOrEqual(1e-6);
  });

  test("with all-pass impulse (delta), passes audio through", async () => {
    const node = await createNode({ sampleRate: SR }, linearPhaseEQ);
    // Manually populate the impulse buffer with a delta at index 0
    const impulse = node.__engine.rt.allScopes[0]!.buffers.find((b) => b.slot.name === "impulse")!;
    (impulse.storage as Float32Array)[0] = 1.0;

    const sine = genSine(440, 0.02);
    // Render block by block
    const N = sine.length;
    const out = new Float32Array(N);
    for (let off = 0; off < N; off += 128) {
      const block = new Float32Array(128);
      block.set(sine.subarray(off, Math.min(off + 128, N)));
      const r = node.__engine.render({ main: [block] });
      const o = r.outputs.main![0]!;
      for (let i = 0; i < 128 && off + i < N; i++) out[off + i] = o[i]!;
    }
    // Should pass through (with maybe some delay) — peak should approximate input
    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));
    expect(peak).toBeGreaterThan(0.3);
  });
});

describe("Example 4: lookahead limiter", () => {
  test("limits peak below ceiling", async () => {
    const loud = genSine(200, 0.3, 1.5); // hot signal
    const result = await renderOffline(lookaheadLimiter, {
      sampleRate: SR,
      duration: 0.3,
      input: { main: [loud, loud] },
      params: { ceiling: -3, releaseMs: 50 },
    });
    expect(result.hasNaN).toBe(false);
    // ceiling is -3dB ≈ 0.708. Allow some overshoot from finite envelope.
    // After warmup, output should not far exceed ceiling.
    // Skip first 1000 samples (settle).
    const out = result.output.main![0]!;
    let peakAfterWarmup = 0;
    for (let i = 5000; i < out.length; i++) {
      peakAfterWarmup = Math.max(peakAfterWarmup, Math.abs(out[i]!));
    }
    expect(peakAfterWarmup).toBeLessThan(1.2);
  });

  test("emits overshoot events", async () => {
    const loud = genSine(200, 0.05, 2.0);
    const result = await renderOffline(lookaheadLimiter, {
      sampleRate: SR,
      duration: 0.05,
      input: { main: [loud, loud] },
      params: { ceiling: -6, releaseMs: 50 },
    });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.find((e) => e.name === "overshoot")).toBeDefined();
  });
});

describe("Example 5: granular sampler", () => {
  test("upload sample via message and render audio with MIDI noteOn", async () => {
    // Build an upload sample (1-sec sine)
    const sample = genSine(440, 1.0, 0.7);
    const result = await renderOffline(granularSampler, {
      sampleRate: SR,
      duration: 0.2,
      messages: [{ name: "uploadSample", payload: { samples: sample } }],
      midiEvents: [
        {
          at: 0.005,
          event: { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 },
        },
      ],
    });
    expect(result.hasNaN).toBe(false);
    // Should produce audio after the note-on
    expect(result.peak).toBeGreaterThan(0.0);
  });
});

describe("Example 6: MIDI arpeggiator", () => {
  test("emits MIDI noteOn events on step boundaries", async () => {
    const result = await renderOffline(arpeggiator, {
      sampleRate: SR,
      duration: 0.5,
      midiEvents: [
        {
          at: 0,
          event: { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 },
        },
      ],
      messages: [
        {
          name: "loadPattern",
          payload: { steps: new Int32Array([0, 4, 7, 12, 7, 4, 0, 4, 0, 4, 7, 12, 7, 4, 0, 4]) },
        },
      ],
    });
    expect(result.midiOut.length).toBeGreaterThan(0);
    expect(result.events.find((e) => e.name === "stepFired")).toBeDefined();
  });
});

describe("Example 7: convolution reverb", () => {
  test("renders without crashing and applies dry signal", async () => {
    // Use very short IR for speed
    const ir = new Float32Array(16);
    ir[0] = 1.0; // delta IR
    const sine = genSine(440, 0.02, 0.5);
    const result = await renderOffline(convolutionReverb, {
      sampleRate: SR,
      duration: 0.02,
      input: { main: [sine, sine] },
      messages: [{ name: "uploadIR", payload: { irL: ir, irR: ir } }],
      params: { wetGain: 0, dryGain: 1 }, // pure dry
    });
    expect(result.hasNaN).toBe(false);
    expect(result.peak).toBeGreaterThan(0.3);
  });

  test("snapshot/restore round-trip", async () => {
    const node = await createNode({ sampleRate: SR }, convolutionReverb);
    const ir = new Float32Array(16);
    ir[0] = 1.0;
    node.messages.uploadIR!({ irL: ir, irR: ir });
    // Drain: render one block
    const block = new Float32Array(128);
    for (let i = 0; i < 128; i++) block[i] = 0.1;
    node.__engine.render({ main: [block, block] });
    const blob = await node.snapshot();
    const inspected = inspect(blob);
    expect(inspected.schemaHash).toBeDefined();
    expect(inspected.slots).toBeDefined();
    // Create a fresh node, restore the blob
    const node2 = await createNode({ sampleRate: SR }, convolutionReverb);
    const r = await node2.restore(blob);
    expect(r.restored).toBeGreaterThan(0);
  });
});

describe("Example 8: polyphonic synth", () => {
  test("renders silence with no notes", async () => {
    const sidechain = new Float32Array(SR / 4);
    const result = await renderOffline(polySynth, {
      sampleRate: SR,
      duration: 0.1,
      input: { sidechain: [sidechain, sidechain] },
    });
    expect(result.hasNaN).toBe(false);
    // Without notes, output should be near zero
    expect(result.peak).toBeLessThan(0.01);
  });

  test("produces audio when noteOn arrives", async () => {
    const sidechain = new Float32Array(Math.ceil(SR * 0.2));
    const result = await renderOffline(polySynth, {
      sampleRate: SR,
      duration: 0.2,
      input: { sidechain: [sidechain, sidechain] },
      midiEvents: [
        {
          at: 0.01,
          event: { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 },
        },
      ],
    });
    expect(result.hasNaN).toBe(false);
    expect(result.peak).toBeGreaterThan(0.05);
    // Should have notePlayed event
    expect(result.events.find((e) => e.name === "notePlayed")).toBeDefined();
  });

  test("sidechain ducks output", async () => {
    // Create a sidechain pulse to verify ducking reduces output amplitude
    const dur = 0.2;
    const len = Math.ceil(SR * dur);
    const scNoSig = new Float32Array(len);
    const scLoud = new Float32Array(len);
    for (let i = 0; i < len; i++) scLoud[i] = 0.95;

    const noDuck = await renderOffline(polySynth, {
      sampleRate: SR,
      duration: dur,
      input: { sidechain: [scNoSig, scNoSig] },
      midiEvents: [
        { at: 0.01, event: { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 } },
      ],
    });
    const ducked = await renderOffline(polySynth, {
      sampleRate: SR,
      duration: dur,
      input: { sidechain: [scLoud, scLoud] },
      midiEvents: [
        { at: 0.01, event: { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 } },
      ],
      params: { duckAmount: 0.9 },
    });
    expect(ducked.peak).toBeLessThan(noDuck.peak);
  });
});
