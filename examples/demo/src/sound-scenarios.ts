// What each example is played with when a release compares how it sounds
// between versions. Effects get a sweep on the left channel and noise on the
// right; instruments get a short phrase on their MIDI port. Every signal is
// computed from fixed parameters, so a render depends only on the packages.
import type { OfflineEvent } from "@unworklet/offline";

import type { Example } from "./examples.ts";

export const SAMPLE_RATE = 48_000;
export const DURATION = 1;

const FRAMES = SAMPLE_RATE * DURATION;

function logSweep(fromHz: number, toHz: number, amplitude: number): Float32Array {
  const data = new Float32Array(FRAMES);
  let phase = 0;
  for (let i = 0; i < FRAMES; i++) {
    phase += (2 * Math.PI * fromHz * (toHz / fromHz) ** (i / (FRAMES - 1))) / SAMPLE_RATE;
    data[i] = amplitude * Math.sin(phase);
  }
  return data;
}

function noise(seed: number, amplitude: number): Float32Array {
  const data = new Float32Array(FRAMES);
  let s = seed;
  for (let i = 0; i < FRAMES; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    data[i] = amplitude * (((s >>> 0) / 0xffffffff) * 2 - 1);
  }
  return data;
}

const PHRASE: Array<[atSample: number, type: "noteOn" | "noteOff", note: number]> = [
  [0, "noteOn", 60],
  [12_000, "noteOff", 60],
  [12_000, "noteOn", 64],
  [24_000, "noteOn", 67],
  [36_000, "noteOff", 64],
  [42_000, "noteOff", 67],
];

export function soundScenario(example: Example): {
  inputs?: Record<string, Float32Array[]>;
  events?: OfflineEvent[];
} {
  if (example.kind === "effect") {
    return { inputs: { main: [logSweep(40, 12_000, 0.5), noise(7, 0.25)] } };
  }
  return {
    events: PHRASE.map(([atSample, type, note]) => ({
      name: example.midiPort!,
      atSample,
      payload: { type, channel: 0, note, velocity: type === "noteOn" ? 100 : 0 },
    })),
  };
}
