/**
 * Offline verification of the RC-20 supply modules (DEVTOOLS handoff §6: the
 * dev-dump X-ray is checked against a known-correct data source). Run with:
 *
 *   NODE_OPTIONS="--conditions=development" vp dlx tsx \
 *     experiments/devtools-proto/scripts/verify-processors.ts
 *
 * A plain script rather than a Vitest test: this app depends on @vitejs/devtools,
 * which duplicates the Vitest runner instance and breaks in-app test collection.
 * renderOffline is the deterministic oracle either way.
 */

import { renderOffline } from "@unworklet/offline";

import { crusher } from "../src/processors/crusher.processor.ts";
import { midiSynth } from "../src/processors/midi-synth.processor.ts";
import { noiseDrive } from "../src/processors/noise-drive.processor.ts";
import { tapeDelay } from "../src/processors/tape-delay.processor.ts";

const SAMPLE_RATE = 48000;
const QUANTA = 8;
const DURATION = (QUANTA * 128) / SAMPLE_RATE;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`verify failed: ${msg}`);
}

function rms(ch: Float32Array): number {
  let sum = 0;
  for (const x of ch) sum += x * x;
  return Math.sqrt(sum / ch.length);
}

function checkFinite(outputs: Record<string, Float32Array[]>, name: string): void {
  for (const ch of Object.values(outputs)) {
    for (const c of ch) {
      for (const x of c) {
        assert(Number.isFinite(x), `${name}: non-finite sample ${x}`);
        assert(Math.abs(x) <= 4, `${name}: out-of-range sample ${x}`);
      }
    }
  }
}

function tone(samples: number): Float32Array {
  const buf = new Float32Array(samples);
  for (let k = 0; k < samples; k++) {
    buf[k] = Math.sin((2 * Math.PI * 220 * k) / SAMPLE_RATE) * 0.5;
  }
  return buf;
}

const n = await renderOffline(noiseDrive, { sampleRate: SAMPLE_RATE, duration: DURATION });
checkFinite(n.outputs, "noiseDrive");
assert(rms(n.outputs["main"]![0]!) > 0, "noiseDrive: silent");

const t = await renderOffline(tapeDelay, {
  sampleRate: SAMPLE_RATE,
  duration: DURATION,
  inputs: { main: [tone(QUANTA * 128)] },
});
checkFinite(t.outputs, "tapeDelay");
assert(rms(t.outputs["main"]![0]!) > 0, "tapeDelay: silent");
assert(t.state.byteLength > 0, "tapeDelay: empty snapshot (delayLine is persistent)");

const c = await renderOffline(crusher, {
  sampleRate: SAMPLE_RATE,
  duration: DURATION,
  inputs: { main: [tone(QUANTA * 128)] },
});
checkFinite(c.outputs, "crusher");
assert(rms(c.outputs["main"]![0]!) > 0, "crusher: silent");

// No MIDI events scheduled → the gate stays closed and the voice is silent,
// which still exercises the full process body (note→Hz, f64 phase) without NaN.
const m = await renderOffline(midiSynth, { sampleRate: SAMPLE_RATE, duration: DURATION });
checkFinite(m.outputs, "midiSynth");

console.log(
  "OK — all 4 supply processors render finite, in-range output (noiseDrive/tapeDelay/crusher non-silent).",
);
