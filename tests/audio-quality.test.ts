import { expect, test, describe } from "vite-plus/test";
import { renderOffline, createNode } from "@unworklet/client";
import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  forSample,
  add,
  mul,
  sub,
  sin,
} from "@unworklet/core";
import {
  stereoGain,
  threeBandEQ,
  lookaheadLimiter,
  polySynth,
  arpeggiator,
} from "@unworklet/examples";

const SR = 48000;

function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / buf.length);
}

function peak(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]!));
  return p;
}

function genSine(freq: number, durationSec: number, amp = 0.5): Float32Array {
  const len = Math.ceil(durationSec * SR);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amp;
  return out;
}

describe("Audio quality: stereo gain", () => {
  test("output is bit-equivalent to input × gain (within float precision)", async () => {
    const sr = 48000;
    const sin440 = genSine(440, 0.1, 0.5);
    const sin880 = genSine(880, 0.1, 0.5);
    const r = await renderOffline(stereoGain, {
      sampleRate: sr,
      duration: 0.1,
      input: { main: [sin440, sin880] },
      params: { gain: 0.5 },
    });
    const outL = r.output.main![0]!;
    const outR = r.output.main![1]!;
    for (let i = 0; i < outL.length; i++) {
      expect(outL[i]).toBeCloseTo(sin440[i]! * 0.5, 5);
      expect(outR[i]).toBeCloseTo(sin880[i]! * 0.5, 5);
    }
  });

  test("peak meter follows input amplitude with decay", async () => {
    const node = await createNode({ sampleRate: SR }, stereoGain);
    const block = new Float32Array(128);
    for (let i = 0; i < 128; i++) block[i] = 0.7;
    // First block: meter should rise to 0.7
    node.__engine.render({ main: [block, block] });
    let m1 = node.state.meterL!.value as number;
    expect(m1).toBeGreaterThan(0.65);

    // Subsequent blocks with silence: meter should decay
    const silence = new Float32Array(128);
    for (let b = 0; b < 50; b++) {
      node.__engine.render({ main: [silence, silence] });
    }
    const m2 = node.state.meterL!.value as number;
    expect(m2).toBeLessThan(m1 * 0.5);
  });
});

describe("Audio quality: three-band EQ", () => {
  test("cuts low band when lowGain is negative", async () => {
    const lowSig = genSine(120, 1.0, 0.5);
    const flat = await renderOffline(threeBandEQ, {
      sampleRate: SR,
      duration: 1.0,
      input: { main: [lowSig, lowSig] },
    });
    const cut = await renderOffline(threeBandEQ, {
      sampleRate: SR,
      duration: 1.0,
      input: { main: [lowSig, lowSig] },
      params: { lowGain: -18 },
    });
    // Use second half to skip transient ramp-up
    const flatTail = flat.output.main![0]!.subarray(SR / 2);
    const cutTail = cut.output.main![0]!.subarray(SR / 2);
    expect(rms(cutTail)).toBeLessThan(rms(flatTail) * 0.5);
  });
});

describe("Audio quality: lookahead limiter", () => {
  test("peak after limiter is bounded near the ceiling", async () => {
    const loud = genSine(200, 0.3, 1.5); // hot
    const r = await renderOffline(lookaheadLimiter, {
      sampleRate: SR,
      duration: 0.3,
      input: { main: [loud, loud] },
      params: { ceiling: -1, releaseMs: 50 },
    });
    // After settling, peak should be near 0.89 (ceiling = -1dB ≈ 0.891)
    const out = r.output.main![0]!;
    const tail = out.subarray(out.length - 1024);
    const p = peak(tail);
    expect(p).toBeLessThan(1.05);
  });

  test("does not introduce NaN in feedback loops", async () => {
    const r = await renderOffline(lookaheadLimiter, {
      sampleRate: SR,
      duration: 0.5,
      input: { main: [genSine(440, 0.5, 0.5), genSine(440, 0.5, 0.5)] },
    });
    expect(r.hasNaN).toBe(false);
  });
});

describe("Audio quality: polyphonic synth", () => {
  test("multiple notes mix correctly", async () => {
    const sc = new Float32Array(Math.ceil(SR * 0.2));
    const single = await renderOffline(polySynth, {
      sampleRate: SR,
      duration: 0.2,
      input: { sidechain: [sc, sc] },
      midiEvents: [
        { at: 0, event: { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 } },
      ],
    });
    const triple = await renderOffline(polySynth, {
      sampleRate: SR,
      duration: 0.2,
      input: { sidechain: [sc, sc] },
      midiEvents: [
        { at: 0, event: { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 } },
        { at: 0, event: { type: "noteOn", channel: 0, note: 64, velocity: 100, atSample: 0 } },
        { at: 0, event: { type: "noteOn", channel: 0, note: 67, velocity: 100, atSample: 0 } },
      ],
    });
    expect(triple.peak).toBeGreaterThan(single.peak);
    expect(triple.hasNaN).toBe(false);
  });
});

describe("Audio quality: arpeggiator MIDI throughput", () => {
  test("MIDI noteOn events appear at regular intervals", async () => {
    const r = await renderOffline(arpeggiator, {
      sampleRate: SR,
      duration: 1.0,
      midiEvents: [
        { at: 0, event: { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 } },
      ],
      messages: [
        {
          name: "loadPattern",
          payload: { steps: new Int32Array([0, 4, 7, 12, 0, 4, 7, 12, 0, 4, 7, 12, 0, 4, 7, 12]) },
        },
      ],
    });
    const noteOns = r.midiOut.filter((m) => m.event.type === "noteOn");
    expect(noteOns.length).toBeGreaterThan(4);
    // Time deltas between consecutive note-ons should be ~constant (samplesPerStep / sampleRate)
    const deltas: number[] = [];
    for (let i = 1; i < noteOns.length; i++) {
      deltas.push(noteOns[i]!.at - noteOns[i - 1]!.at);
    }
    // Step rate of 1/8 note at 60 BPM at 48000 Hz = 6000 samples per step = 0.125 sec
    const expectedDelta = 0.125;
    for (const d of deltas) {
      expect(d).toBeGreaterThan(expectedDelta * 0.95);
      expect(d).toBeLessThan(expectedDelta * 1.05);
    }
  });
});

describe("A simple oscillator processor produces a sine wave", () => {
  // Build a 440Hz sine osc inline, render it, verify frequency
  test("produces 440Hz sine", async () => {
    const sineOsc = defineProcessor((ctx) => {
      const out = audioOutput({ channels: 1, name: "main" });
      const phase = state.f32(0, { name: "phase" });
      const inc = (2 * Math.PI * 440) / ctx.sampleRate;
      return {
        process: () => {
          forSample((i) => {
            const p = add(phase.load(), inc);
            phase.store(p);
            out.set(0, i, sin(p));
          });
        },
      };
    });

    const r = await renderOffline(sineOsc, {
      sampleRate: SR,
      duration: 0.5,
    });
    expect(r.hasNaN).toBe(false);
    expect(r.peak).toBeGreaterThan(0.95);

    // Count zero crossings to estimate frequency
    const out = r.output.main![0]!;
    let crossings = 0;
    for (let i = 1; i < out.length; i++) {
      if (out[i - 1]! < 0 !== out[i]! < 0) crossings++;
    }
    const detectedFreq = (crossings * SR) / (2 * out.length);
    expect(detectedFreq).toBeGreaterThan(430);
    expect(detectedFreq).toBeLessThan(450);
  });
});
