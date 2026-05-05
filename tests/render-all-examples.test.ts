// End-to-end smoke test: render every canonical example to a WAV file via the CLI render
// pipeline and verify the file is well-formed and contains expected audio.
import { expect, test, describe } from "vite-plus/test";
import { renderProcessorToWav, decodeWAV } from "@unworklet/cli";
import { encodeWAV } from "@unworklet/cli";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const SR = 48000;

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uw-render-"));
  return dir;
}

async function teardown(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}

function genSineFile(freq: number, durationSec: number, amp = 0.7): Float32Array[] {
  const len = Math.ceil(durationSec * SR);
  const l = new Float32Array(len);
  const r = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    l[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amp;
    r[i] = Math.sin((2 * Math.PI * (freq * 1.5) * i) / SR) * amp;
  }
  return [l, r];
}

describe("Render all canonical examples to WAV", () => {
  test("01 stereoGain renders WAV", async () => {
    const dir = await setup();
    try {
      const inPath = path.join(dir, "in.wav");
      const outPath = path.join(dir, "out.wav");
      const [l, r] = genSineFile(440, 0.2);
      await fs.writeFile(inPath, encodeWAV([l, r], SR, "float32"));
      const { result } = await renderProcessorToWav({
        processorPath: path.resolve("examples/src/01-stereo-gain.ts"),
        outputPath: outPath,
        inputWav: inPath,
        duration: 0.2,
        sampleRate: SR,
        params: { gain: 0.5 },
      });
      expect(result.peak).toBeGreaterThan(0.3);
      expect(result.hasNaN).toBe(false);
      const stat = await fs.stat(outPath);
      expect(stat.size).toBeGreaterThan(44);
    } finally {
      await teardown(dir);
    }
  });

  test("02 threeBandEQ renders WAV", async () => {
    const dir = await setup();
    try {
      const inPath = path.join(dir, "in.wav");
      const outPath = path.join(dir, "out.wav");
      const [l, r] = genSineFile(1000, 0.2);
      await fs.writeFile(inPath, encodeWAV([l, r], SR, "float32"));
      const { result } = await renderProcessorToWav({
        processorPath: path.resolve("examples/src/02-three-band-eq.ts"),
        outputPath: outPath,
        inputWav: inPath,
        duration: 0.2,
        sampleRate: SR,
      });
      expect(result.hasNaN).toBe(false);
      expect(result.peak).toBeGreaterThan(0.0);
    } finally {
      await teardown(dir);
    }
  });

  test("03 linearPhaseEQ renders WAV (silence without IR)", async () => {
    const dir = await setup();
    try {
      const inPath = path.join(dir, "in.wav");
      const outPath = path.join(dir, "out.wav");
      const [l] = genSineFile(440, 0.05);
      await fs.writeFile(inPath, encodeWAV([l], SR, "float32"));
      const { result } = await renderProcessorToWav({
        processorPath: path.resolve("examples/src/03-linear-phase-eq.ts"),
        outputPath: outPath,
        inputWav: inPath,
        duration: 0.05,
        sampleRate: SR,
      });
      expect(result.hasNaN).toBe(false);
      // No IR loaded → silent
      expect(result.peak).toBeLessThanOrEqual(1e-6);
    } finally {
      await teardown(dir);
    }
  });

  test("04 lookaheadLimiter renders WAV", async () => {
    const dir = await setup();
    try {
      const inPath = path.join(dir, "in.wav");
      const outPath = path.join(dir, "out.wav");
      const [l, r] = genSineFile(220, 0.3, 1.4);
      await fs.writeFile(inPath, encodeWAV([l, r], SR, "float32"));
      const { result } = await renderProcessorToWav({
        processorPath: path.resolve("examples/src/04-lookahead-limiter.ts"),
        outputPath: outPath,
        inputWav: inPath,
        duration: 0.3,
        sampleRate: SR,
        params: { ceiling: -3, releaseMs: 50 },
      });
      expect(result.hasNaN).toBe(false);
      expect(result.events.length).toBeGreaterThan(0);
    } finally {
      await teardown(dir);
    }
  });

  test("05 granularSampler renders WAV with sample upload + MIDI", async () => {
    const dir = await setup();
    try {
      const outPath = path.join(dir, "out.wav");
      // Build a sample buffer to upload
      const sampleLen = SR;
      const sampleBuf = new Float32Array(sampleLen);
      for (let i = 0; i < sampleLen; i++) {
        sampleBuf[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.7;
      }
      const { result } = await renderProcessorToWav({
        processorPath: path.resolve("examples/src/05-granular-sampler.ts"),
        outputPath: outPath,
        duration: 0.2,
        sampleRate: SR,
        messages: [{ name: "uploadSample", payload: { samples: sampleBuf } }],
        midiEvents: [
          {
            at: 0.005,
            event: { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 },
          },
        ],
      });
      expect(result.hasNaN).toBe(false);
    } finally {
      await teardown(dir);
    }
  });

  test("06 arpeggiator renders WAV (silent passthrough; MIDI events emitted)", async () => {
    const dir = await setup();
    try {
      const outPath = path.join(dir, "out.wav");
      const { result } = await renderProcessorToWav({
        processorPath: path.resolve("examples/src/06-arpeggiator.ts"),
        outputPath: outPath,
        duration: 0.5,
        sampleRate: SR,
        midiEvents: [
          { at: 0, event: { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 } },
        ],
        messages: [
          {
            name: "loadPattern",
            payload: { steps: new Int32Array([0, 4, 7, 12, 7, 4, 0, 4, 0, 4, 7, 12, 7, 4, 0, 4]) },
          },
        ],
      });
      expect(result.midiOut.length).toBeGreaterThan(0);
    } finally {
      await teardown(dir);
    }
  });

  test("07 convolutionReverb renders WAV with delta IR (passthrough)", async () => {
    const dir = await setup();
    try {
      const inPath = path.join(dir, "in.wav");
      const outPath = path.join(dir, "out.wav");
      const [l, r] = genSineFile(440, 0.05);
      await fs.writeFile(inPath, encodeWAV([l, r], SR, "float32"));
      // Build a small delta IR
      const ir = new Float32Array(64);
      ir[0] = 1.0;
      const { result } = await renderProcessorToWav({
        processorPath: path.resolve("examples/src/07-convolution-reverb.ts"),
        outputPath: outPath,
        inputWav: inPath,
        duration: 0.05,
        sampleRate: SR,
        params: { wetGain: 0, dryGain: 1 }, // pure dry
        messages: [{ name: "uploadIR", payload: { irL: ir, irR: ir } }],
      });
      expect(result.hasNaN).toBe(false);
      expect(result.peak).toBeGreaterThan(0.3);
    } finally {
      await teardown(dir);
    }
  });

  test("08 polySynth renders WAV with notes", async () => {
    const dir = await setup();
    try {
      const inPath = path.join(dir, "sc.wav");
      const outPath = path.join(dir, "out.wav");
      const sc = new Float32Array(Math.ceil(SR * 0.3));
      await fs.writeFile(inPath, encodeWAV([sc, sc], SR, "float32"));
      const { result } = await renderProcessorToWav({
        processorPath: path.resolve("examples/src/08-poly-synth.ts"),
        outputPath: outPath,
        inputWav: inPath,
        inputName: "sidechain",
        duration: 0.3,
        sampleRate: SR,
        midiEvents: [
          { at: 0.01, event: { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 } },
          { at: 0.05, event: { type: "noteOn", channel: 0, note: 64, velocity: 100, atSample: 0 } },
          { at: 0.09, event: { type: "noteOn", channel: 0, note: 67, velocity: 100, atSample: 0 } },
        ],
      });
      expect(result.hasNaN).toBe(false);
      expect(result.peak).toBeGreaterThan(0.05);
      expect(result.events.find((e) => e.name === "notePlayed")).toBeDefined();
    } finally {
      await teardown(dir);
    }
  });
});
