/**
 * WAV byte encoder helper for `renderOffline` outputs: the wav-side canonical
 * wrapper for the path described in `13-offline-render.md` §1 ("Output is
 * in-memory Float32Array; the consumer composes file I/O / encoders / UI
 * separately").
 *
 * Uses `wavefile` (rochars/wavefile) internally for best-in-class WAV spec
 * compliance: it switches to `WAVE_FORMAT_EXTENSIBLE` automatically for 24-bit
 * or more than 2 channels, supports `dwChannelMask` for mono/stereo/quad/5.1/
 * 7.1, RIFX big-endian, and full ADPCM / A-Law / Mu-Law, and enforces
 * `validateNumChannels` / `validateSampleRate`.
 *
 * The unworklet surface is `Float32Array[]` channels plus sampleRate plus an
 * optional `bitDepth`, passed straight through to wavefile's `fromScratch`. The
 * byte output is returned as a `Uint8Array` (so the consumer can hand it to
 * `fs.writeFile`, `Blob`, etc.).
 */

import wavefile from "wavefile";

const { WaveFile } = wavefile;

/**
 * The subset of `wavefile`'s bitDepth codes exposed here. 8 / 16 / 24 / 32 are
 * integer PCM; 32f is IEEE Float (a perfect match for AudioWorklet); 64 is IEEE
 * Double. wavefile also supports A-Law / Mu-Law / ADPCM ('8a' / '8m' / '4'),
 * but since unworklet's renderOffline output (a Float32Array) is linear PCM
 * directly, those are excluded from this canonical surface (they remain
 * accessible by using wavefile directly).
 */
export type EncodeWavBitDepth = "8" | "16" | "24" | "32" | "32f" | "64";

export type EncodeWavOptions = {
  /** Default = `"32f"` (IEEE Float, bit-exact with unworklet renderOffline output). */
  bitDepth?: EncodeWavBitDepth;
};

export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  options?: EncodeWavOptions,
): Uint8Array {
  const wf = new WaveFile();
  wf.fromScratch(channels.length, sampleRate, options?.bitDepth ?? "32f", channels);
  return wf.toBuffer();
}
