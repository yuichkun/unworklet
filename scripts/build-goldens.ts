// Render each canonical example through the WASM offline renderer with a
// fixed input + parameters and write the result to tests/golden/*.wav.
//
// Run via: pnpm tsx scripts/build-goldens.ts
//
// The companion test (tests/golden-wav.test.ts) then re-renders and compares
// against these files bit-for-bit (within a small FP tolerance) so any
// silent regression in the codegen / runtime is surfaced.
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { renderOfflineWasm } from "@unworklet/test";
import { encodeWAV } from "@unworklet/cli";
import { stereoGain } from "@unworklet/examples";
import { threeBandEQ } from "@unworklet/examples";
import { lookaheadLimiter } from "@unworklet/examples";
import { feedbackDelay } from "@unworklet/examples";
import { chorus } from "@unworklet/examples";
import { distortion } from "@unworklet/examples";
import { compressor } from "@unworklet/examples";
import { polySynth } from "@unworklet/examples";
import { fmSynth } from "@unworklet/examples";
import { drumSampler } from "@unworklet/examples";
import { granularSampler } from "@unworklet/examples";
import { convolutionReverb } from "@unworklet/examples";
import { linearPhaseEQ } from "@unworklet/examples";

const SR = 48000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goldenDir = path.resolve(__dirname, "..", "tests", "golden");
await fs.mkdir(goldenDir, { recursive: true });

function sin(freq: number, dur: number) {
  const l = new Float32Array((dur * SR) | 0);
  const r = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) {
    l[i] = Math.sin((2 * Math.PI * freq * i) / SR) * 0.5;
    r[i] = Math.sin((2 * Math.PI * (freq * 1.5) * i) / SR) * 0.5;
  }
  return { main: [l, r] };
}

// Build a 0.2s sine click sample for the typed-array uploads.
const sampleClick = (() => {
  const buf = new Float32Array((0.2 * SR) | 0);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.6 * Math.exp(-i / (SR * 0.05));
  }
  return buf;
})();
const ir = (() => {
  const buf = new Float32Array(64);
  buf[0] = 1.0; // identity IR (passthrough)
  return buf;
})();

const cases: Array<{ name: string; processor: any; opts?: any; inputs?: any }> = [
  { name: "01-stereo-gain", processor: stereoGain, inputs: sin(440, 0.05) },
  { name: "02-three-band-eq", processor: threeBandEQ, inputs: sin(440, 0.05) },
  { name: "04-lookahead-limiter", processor: lookaheadLimiter, inputs: sin(220, 0.1) },
  { name: "09-feedback-delay", processor: feedbackDelay, inputs: sin(440, 0.1) },
  { name: "10-chorus", processor: chorus, inputs: sin(440, 0.1) },
  { name: "11-distortion", processor: distortion, inputs: sin(220, 0.05) },
  { name: "13-compressor", processor: compressor, inputs: sin(220, 0.1) },
  {
    name: "08-poly-synth",
    processor: polySynth,
    opts: { midi: [{ type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 }] },
  },
  {
    name: "14-fm-synth",
    processor: fmSynth,
    opts: { midi: [{ type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 }] },
  },
  {
    name: "07-convolution-reverb",
    processor: convolutionReverb,
    inputs: sin(440, 0.05),
    opts: {
      messages: [{ at: 0, name: "uploadIR", payload: { irL: ir, irR: ir } }],
    },
  },
  {
    name: "12-drum-sampler",
    processor: drumSampler,
    opts: {
      durationSec: 0.2,
      messages: [
        { at: 0, name: "uploadPad", payload: { pad: 0, samples: sampleClick } },
        { at: 0.005, name: "triggerPad", payload: { pad: 0, velocity: 1 } },
      ],
    },
  },
];

for (const c of cases) {
  const cfg: any = {
    sampleRate: SR,
    duration: c.opts?.durationSec ?? 0.1,
    midiEvents: (c.opts?.midi ?? []).map((event: any) => ({ at: 0, event })),
    messages: c.opts?.messages,
  };
  if (c.inputs) {
    cfg.input = c.inputs;
  }
  const out = await renderOfflineWasm(c.processor, cfg);
  const firstName = Object.keys(out.output)[0]!;
  const ch = out.output[firstName]!;
  const ch0 = ch[0]!;
  const ch1 = ch[1] ?? ch0;
  const wav = encodeWAV([ch0, ch1], SR, "float32");
  const file = path.join(goldenDir, c.name + ".wav");
  await fs.writeFile(file, wav);
  console.log(`wrote ${file} (${wav.byteLength} bytes, peak=${out.peak.toFixed(4)})`);
}

console.log("done");
