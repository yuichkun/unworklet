import { expect, test, describe } from "vite-plus/test";
import { renderOffline } from "@unworklet/client";
import {
  feedbackDelay,
  chorus,
  distortion,
  drumSampler,
  compressor,
  fmSynth,
} from "@unworklet/examples";

const SR = 48000;

function genSine(freq: number, durationSec: number, amp = 0.5): Float32Array {
  const len = Math.ceil(durationSec * SR);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amp;
  return out;
}

describe("Extra examples", () => {
  test("feedback delay produces wet signal", async () => {
    const sine = genSine(440, 0.5, 0.5);
    const result = await renderOffline(feedbackDelay, {
      sampleRate: SR,
      duration: 0.5,
      input: { main: [sine, sine] },
      params: { delayMs: 250, feedback: 0.5, wet: 0.6, dry: 0.5 },
    });
    expect(result.hasNaN).toBe(false);
    expect(result.peak).toBeGreaterThan(0.0);
  });

  test("chorus passes audio with mix", async () => {
    const sine = genSine(440, 0.2, 0.5);
    const result = await renderOffline(chorus, {
      sampleRate: SR,
      duration: 0.2,
      input: { main: [sine, sine] },
    });
    expect(result.hasNaN).toBe(false);
    expect(result.peak).toBeGreaterThan(0.1);
  });

  test("distortion produces hot saturated output", async () => {
    const sine = genSine(440, 0.1, 0.5);
    const result = await renderOffline(distortion, {
      sampleRate: SR,
      duration: 0.1,
      input: { main: [sine, sine] },
      params: { drive: 8, tone: 0.5, outGain: 0.5 },
    });
    expect(result.hasNaN).toBe(false);
    expect(result.peak).toBeGreaterThan(0.0);
  });

  test("drum sampler triggers a pad via message and produces audio", async () => {
    const click = new Float32Array(2400);
    for (let i = 0; i < click.length; i++) {
      click[i] = Math.sin((i / click.length) * 60 * Math.PI) * Math.exp(-i / 300) * 0.6;
    }
    const result = await renderOffline(drumSampler, {
      sampleRate: SR,
      duration: 0.2,
      messages: [
        { name: "uploadPad", payload: { pad: 0, samples: click } },
        { at: 0.005, name: "triggerPad", payload: { pad: 0, velocity: 1.0 } },
      ],
    });
    expect(result.hasNaN).toBe(false);
    expect(result.peak).toBeGreaterThan(0.0);
  });

  test("compressor reduces gain on loud input", async () => {
    const loud = genSine(220, 0.5, 1.4);
    const r = await renderOffline(compressor, {
      sampleRate: SR,
      duration: 0.5,
      input: { main: [loud, loud] },
      params: { threshold: -10, ratio: 8, attackMs: 1, releaseMs: 50, kneeDb: 6 },
    });
    expect(r.hasNaN).toBe(false);
    // Peak after compressor should be lower than uncompressed (1.4)
    expect(r.peak).toBeLessThan(1.3);
  });

  test("fm synth produces audio on noteOn", async () => {
    const r = await renderOffline(fmSynth, {
      sampleRate: SR,
      duration: 0.2,
      midiEvents: [
        { at: 0.005, event: { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 } },
      ],
    });
    expect(r.hasNaN).toBe(false);
    expect(r.peak).toBeGreaterThan(0.05);
    expect(r.events.find((e) => e.name === "notePlayed")).toBeDefined();
  });
});
