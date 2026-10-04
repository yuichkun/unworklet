import "./extend.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import wavefile from "wavefile";
import { expectAudioMatchesGolden, type RenderResultLike } from "./index.ts";

const monoResult = (channel: Float32Array): RenderResultLike => ({
  outputs: { main: [channel] },
  events: [],
  state: new Uint8Array(),
  sampleRate: 48000,
});

test.each([8, 16, 24, 32])("PCM%i golden uses normalized sample amplitudes", (bits) => {
  // Construct a RIFF PCM file directly; neither WAV helper supplies the oracle.
  const samples = [0.5, -0.5, 0, -1];
  const bytesPerSample = bits / 8;
  const wav = Buffer.alloc(44 + samples.length * bytesPerSample);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(48000 * bytesPerSample, 28);
  wav.writeUInt16LE(bytesPerSample, 32);
  wav.writeUInt16LE(bits, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples.length * bytesPerSample, 40);
  samples.forEach((sample, i) => {
    const offset = 44 + i * bytesPerSample;
    if (bits === 8) wav.writeUInt8(sample * 128 + 128, offset);
    else wav.writeIntLE(sample * 2 ** (bits - 1), offset, bytesPerSample);
  });
  const path = join(mkdtempSync(join(tmpdir(), "unworklet-pcm-")), "reference.wav");
  writeFileSync(path, wav);
  expectAudioMatchesGolden(monoResult(Float32Array.from(samples)), path);
  expect(monoResult(Float32Array.from(samples))).toMatchAudioFile(path);
  expect(() =>
    expect(monoResult(Float32Array.of(0.25, -0.5, 0, -1))).toMatchAudioFile(path),
  ).toThrow(/diff/);
  expect(() =>
    expectAudioMatchesGolden(monoResult(Float32Array.of(0.25, -0.5, 0, -1)), path, {
      tolerance: 0.01,
    }),
  ).toThrow(/diff/);
});

test.each(["16", "32f", "64"])(
  "stereo %s golden preserves channel values and sample rate",
  (bitDepth) => {
    const channels = [Float32Array.of(0.5, -0.5, 0), Float32Array.of(-1, 0.25, 0.75)];
    const wav = new wavefile.WaveFile();
    wav.fromScratch(
      2,
      48000,
      bitDepth,
      channels.map((ch) => Array.from(ch, (v) => (bitDepth === "16" ? v * 32768 : v))),
    );
    const path = join(mkdtempSync(join(tmpdir(), "unworklet-stereo-golden-")), "ref.wav");
    writeFileSync(path, wav.toBuffer());
    const result = { ...monoResult(channels[0]!), outputs: { main: channels } };
    expectAudioMatchesGolden(result, path);
    expect(result).toMatchAudioFile(path);
    expect(() =>
      expectAudioMatchesGolden({ ...result, outputs: { main: [...channels].reverse() } }, path),
    ).toThrow(/diff/);
    expect(() => expectAudioMatchesGolden({ ...result, sampleRate: 44100 }, path)).toThrow(
      /sampleRate/,
    );
  },
);

test("compressed golden reports unsupported sample format", () => {
  const wav = new wavefile.WaveFile();
  wav.fromScratch(1, 48000, "16", [0, 16384]);
  wav.toALaw();
  const path = join(mkdtempSync(join(tmpdir(), "unworklet-alaw-golden-")), "ref.wav");
  writeFileSync(path, wav.toBuffer());
  expect(() => expectAudioMatchesGolden(monoResult(Float32Array.of(0, 0.5)), path)).toThrow(
    /unsupported WAV bit depth/,
  );
});
