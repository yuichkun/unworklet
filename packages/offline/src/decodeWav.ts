/**
 * WAV byte decoder helper for the `renderOffline` round-trip, exported from
 * `@unworklet/offline` alongside its counterpart encodeWav. It uses `wavefile`
 * (rochars/wavefile) internally for best-in-class WAV spec compliance:
 * `WAVE_FORMAT_EXTENSIBLE`, RIFX (big-endian), ADPCM/Alaw/Mulaw, and every bit
 * depth recognized.
 *
 * The raw carry path returns `wavefile.getSamples(false, Float32Array)`
 * verbatim: 32f / 64f float WAV yields values already normalized to the -1..1
 * range, while 8/16/24/32 int PCM WAV carries the **raw signed int values** in
 * a Float32Array (per the wavefile contract, the consumer normalizes itself,
 * e.g. by dividing by 32768). The round-trip between unworklet renderOffline
 * output (32f by default) and encodeWav (32f by default) is bit-exact.
 */

import wavefile from "wavefile";

const { WaveFile } = wavefile;

export type DecodeWavResult = {
  channels: Float32Array[];
  sampleRate: number;
};

export function decodeWav(bytes: Uint8Array): DecodeWavResult {
  const wf = new WaveFile();
  wf.fromBuffer(bytes);
  const samples = wf.getSamples(false, Float32Array) as unknown as Float32Array | Float32Array[];
  const channels = Array.isArray(samples)
    ? samples.map((c) => new Float32Array(c))
    : [new Float32Array(samples)];
  const fmt = wf.fmt as { sampleRate: number };
  return { channels, sampleRate: fmt.sampleRate };
}
