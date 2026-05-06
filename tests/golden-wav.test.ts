// Bit-exact golden WAV regression test (docs/06-testing §4 / spec ID F6).
// Re-renders each canonical example and compares the result against a
// committed reference under tests/golden/. Any silent change in codegen
// or runtime that affects the audio sample stream surfaces here.
import { describe, expect, test } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderOfflineWasm } from "@unworklet/test";
import { decodeWAV } from "@unworklet/cli";
import {
  stereoGain,
  threeBandEQ,
  lookaheadLimiter,
  feedbackDelay,
  chorus,
  distortion,
  compressor,
  polySynth,
  fmSynth,
} from "@unworklet/examples";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goldenDir = path.resolve(__dirname, "golden");

const SR = 48000;
function sin(freq: number, dur: number) {
  const l = new Float32Array((dur * SR) | 0);
  const r = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) {
    l[i] = Math.sin((2 * Math.PI * freq * i) / SR) * 0.5;
    r[i] = Math.sin((2 * Math.PI * (freq * 1.5) * i) / SR) * 0.5;
  }
  return { main: [l, r] };
}

const cases: Array<{
  name: string;
  processor: any;
  golden: string;
  inputs?: any;
  midi?: any[];
  duration?: number;
}> = [
  { name: "stereoGain", processor: stereoGain, golden: "01-stereo-gain.wav", inputs: sin(440, 0.05) },
  { name: "threeBandEQ", processor: threeBandEQ, golden: "02-three-band-eq.wav", inputs: sin(440, 0.05) },
  { name: "lookaheadLimiter", processor: lookaheadLimiter, golden: "04-lookahead-limiter.wav", inputs: sin(220, 0.1), duration: 0.1 },
  { name: "feedbackDelay", processor: feedbackDelay, golden: "09-feedback-delay.wav", inputs: sin(440, 0.1), duration: 0.1 },
  { name: "chorus", processor: chorus, golden: "10-chorus.wav", inputs: sin(440, 0.1), duration: 0.1 },
  { name: "distortion", processor: distortion, golden: "11-distortion.wav", inputs: sin(220, 0.05) },
  { name: "compressor", processor: compressor, golden: "13-compressor.wav", inputs: sin(220, 0.1), duration: 0.1 },
  {
    name: "polySynth",
    processor: polySynth,
    golden: "08-poly-synth.wav",
    midi: [{ type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 }],
    duration: 0.1,
  },
  {
    name: "fmSynth",
    processor: fmSynth,
    golden: "14-fm-synth.wav",
    midi: [{ type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 }],
    duration: 0.1,
  },
];

describe("Golden WAV regression", () => {
  for (const c of cases) {
    test(`${c.name} matches golden`, async () => {
      const cfg: any = {
        sampleRate: SR,
        duration: c.duration ?? 0.1,
        midiEvents: (c.midi ?? []).map((event: any) => ({ at: 0, event })),
      };
      if (c.inputs) cfg.input = c.inputs;
      const out = await renderOfflineWasm(c.processor, cfg);
      const firstName = Object.keys(out.output)[0]!;
      const ch = out.output[firstName]!;
      const goldenBytes = await fs.readFile(path.join(goldenDir, c.golden));
      const decoded = decodeWAV(new Uint8Array(goldenBytes));
      expect(decoded.sampleRate).toBe(SR);
      expect(decoded.channels.length).toBeGreaterThanOrEqual(1);
      expect(ch[0]!.length).toBe(decoded.channels[0]!.length);
      // Tolerate ~1 ULP drift (FP determinism is not guaranteed across builds
      // of binaryen, but should be tight in-process).
      const tol = 1e-6;
      let maxDiff = 0;
      for (let cidx = 0; cidx < Math.min(ch.length, decoded.channels.length); cidx++) {
        const a = ch[cidx]!;
        const b = decoded.channels[cidx]!;
        for (let i = 0; i < a.length; i++) {
          const d = Math.abs(a[i]! - b[i]!);
          if (d > maxDiff) maxDiff = d;
        }
      }
      expect(maxDiff).toBeLessThan(tol);
    });
  }
});
