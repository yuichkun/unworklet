// Generate a 1-second 440Hz stereo sine WAV at 48kHz for testing.
import { encodeWAV } from "@unworklet/cli";
import { promises as fs } from "node:fs";

const sampleRate = 48000;
const dur = 1.0;
const len = Math.ceil(dur * sampleRate);
const left = new Float32Array(len);
const right = new Float32Array(len);
for (let i = 0; i < len; i++) {
  const t = i / sampleRate;
  left[i] = Math.sin(2 * Math.PI * 440 * t) * 0.5;
  right[i] = Math.sin(2 * Math.PI * 660 * t) * 0.5;
}
const wav = encodeWAV([left, right], sampleRate, "float32");
await fs.writeFile("/tmp/uw/sine.wav", wav);
console.log("Wrote /tmp/uw/sine.wav");
