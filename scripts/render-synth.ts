// Render the polyphonic synth playing a chord, to a WAV file.
import { renderOffline } from '@unworklet/client';
import { encodeWAV } from '@unworklet/cli';
import { polySynth } from '@unworklet/examples';
import { promises as fs } from 'node:fs';

const SR = 48000;
const dur = 2.0;
const len = Math.ceil(SR * dur);
const sc = new Float32Array(len);

const result = await renderOffline(polySynth, {
  sampleRate: SR,
  duration: dur,
  input: { sidechain: [sc, sc] },
  midiEvents: [
    { at: 0.0, event: { type: 'noteOn', channel: 0, note: 60, velocity: 100, atSample: 0 } },
    { at: 0.0, event: { type: 'noteOn', channel: 0, note: 64, velocity: 100, atSample: 0 } },
    { at: 0.0, event: { type: 'noteOn', channel: 0, note: 67, velocity: 100, atSample: 0 } },
    { at: 0.5, event: { type: 'noteOn', channel: 0, note: 72, velocity: 110, atSample: 0 } },
    { at: 1.5, event: { type: 'noteOff', channel: 0, note: 60, velocity: 0, atSample: 0 } },
    { at: 1.5, event: { type: 'noteOff', channel: 0, note: 64, velocity: 0, atSample: 0 } },
    { at: 1.5, event: { type: 'noteOff', channel: 0, note: 67, velocity: 0, atSample: 0 } },
    { at: 1.5, event: { type: 'noteOff', channel: 0, note: 72, velocity: 0, atSample: 0 } },
  ],
});

console.log('peak:', result.peak.toFixed(4), 'rms:', result.rms.toFixed(4));
console.log('events:', result.events.length, 'midiOut:', result.midiOut.length);

const wav = encodeWAV(result.output.main!, SR, 'float32');
await fs.writeFile('/tmp/uw/synth-chord.wav', wav);
console.log('Wrote /tmp/uw/synth-chord.wav');
