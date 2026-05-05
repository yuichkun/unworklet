import { expect, test } from "vite-plus/test";
import { encodeWAV, decodeWAV } from "@unworklet/cli";
import { renderProcessorToWav } from "@unworklet/cli";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

test("WAV round-trip preserves audio", () => {
  const sr = 48000;
  const len = 256;
  const l = new Float32Array(len);
  const r = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    l[i] = Math.sin((i / len) * Math.PI * 2) * 0.7;
    r[i] = Math.cos((i / len) * Math.PI * 2) * 0.7;
  }
  const wav = encodeWAV([l, r], sr, "float32");
  const decoded = decodeWAV(wav);
  expect(decoded.sampleRate).toBe(sr);
  expect(decoded.channels.length).toBe(2);
  for (let i = 0; i < len; i++) {
    expect(decoded.channels[0]![i]).toBeCloseTo(l[i]!, 6);
    expect(decoded.channels[1]![i]).toBeCloseTo(r[i]!, 6);
  }
});

test("CLI render: stereo gain processor produces expected gain reduction", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uw-test-"));
  const inPath = path.join(dir, "sine.wav");
  const outPath = path.join(dir, "out.wav");

  // Create input
  const sr = 48000;
  const len = sr; // 1 second
  const inL = new Float32Array(len);
  const inR = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    inL[i] = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.8;
    inR[i] = Math.sin((2 * Math.PI * 880 * i) / sr) * 0.8;
  }
  await fs.writeFile(inPath, encodeWAV([inL, inR], sr, "float32"));

  await renderProcessorToWav({
    processorPath: path.resolve("examples/src/01-stereo-gain.ts"),
    outputPath: outPath,
    inputWav: inPath,
    duration: 1,
    sampleRate: sr,
    params: { gain: 0.25 },
    format: "float32",
  });

  const buf = await fs.readFile(outPath);
  const decoded = decodeWAV(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  expect(decoded.sampleRate).toBe(sr);
  expect(decoded.channels.length).toBe(2);

  // Output peak should be 0.8 * 0.25 = 0.2
  let peakL = 0;
  let peakR = 0;
  for (let i = 0; i < decoded.channels[0]!.length; i++) {
    peakL = Math.max(peakL, Math.abs(decoded.channels[0]![i]!));
    peakR = Math.max(peakR, Math.abs(decoded.channels[1]![i]!));
  }
  expect(peakL).toBeGreaterThan(0.18);
  expect(peakL).toBeLessThan(0.22);
  expect(peakR).toBeGreaterThan(0.18);
  expect(peakR).toBeLessThan(0.22);

  // Cleanup
  await fs.rm(dir, { recursive: true, force: true });
});
