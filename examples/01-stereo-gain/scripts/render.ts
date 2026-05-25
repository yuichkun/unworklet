// cspell:ignore afplay

/**
 * Demo render = canonical Ex 1 minus meter (= stereo gain) を end-to-end
 * 実 機 音 で 確 認 す る ため の wav round-trip script。
 *
 * Flow:
 *   1) 440 Hz sine wave 1 sec 構 築 (= L 0.8 amp + R 0.4 amp で stereo
 *      差 を 出 し て 左 右 が 違 う こ と が 聞 こ え る 形)
 *   2) `encodeWav` で `input.wav` 書 き 出 し
 *   3) `decodeWav` で 読 み 戻 す (= round-trip 確 認 path)
 *   4) `stereoGain` processor を `renderOffline` で 走 ら せ る
 *      (= gain = 0.3 で 全 体 volume 下 げ る)
 *   5) `encodeWav` で `out.wav` 書 き 出 し
 *
 * Play:
 *   afplay examples/01-stereo-gain/input.wav
 *   afplay examples/01-stereo-gain/out.wav
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeWav, encodeWav, renderOffline } from "@unworklet/offline";

import { stereoGain } from "../src/processor.ts";

const SAMPLE_RATE = 48000;
const DURATION_SEC = 1;
const FREQ_HZ = 440;
const PEAK_L = 0.8;
const PEAK_R = 0.4;
const GAIN = 0.3;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// 1) sine wave 構 築
const totalSamples = Math.ceil(DURATION_SEC * SAMPLE_RATE);
const left = new Float32Array(totalSamples);
const right = new Float32Array(totalSamples);
for (let i = 0; i < totalSamples; i++) {
  const t = i / SAMPLE_RATE;
  const sineSample = Math.sin(2 * Math.PI * FREQ_HZ * t);
  left[i] = sineSample * PEAK_L;
  right[i] = sineSample * PEAK_R;
}

// 2) input.wav 書 き 出 し
const inputWav = encodeWav([left, right], SAMPLE_RATE);
const inputPath = join(ROOT, "input.wav");
writeFileSync(inputPath, inputWav);
console.log(
  `✓ wrote ${inputPath} (${inputWav.byteLength} bytes、 ${DURATION_SEC}s sine ${FREQ_HZ}Hz L=${PEAK_L} R=${PEAK_R})`,
);

// 3) input.wav decode (= round-trip 確 認)
const decoded = decodeWav(inputWav);

// 4) stereoGain renderOffline
const result = await renderOffline(stereoGain, {
  sampleRate: decoded.sampleRate,
  duration: DURATION_SEC,
  inputs: { main: decoded.channels },
  params: { gain: [GAIN] },
});

// 5) out.wav 書 き 出 し
const outputWav = encodeWav(result.outputs["main"]!, decoded.sampleRate);
const outputPath = join(ROOT, "out.wav");
writeFileSync(outputPath, outputWav);
console.log(`✓ wrote ${outputPath} (${outputWav.byteLength} bytes、 input × gain ${GAIN})`);

console.log("");
console.log("Play:");
console.log(`  afplay ${inputPath}`);
console.log(`  afplay ${outputPath}`);
