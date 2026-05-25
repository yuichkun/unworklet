/**
 * WAV byte encoder helper for `renderOffline` outputs (= `13-offline-render.md`
 * §1 「Output is in-memory Float32Array; the consumer composes file I/O /
 * encoders / UI separately」 path の wav-side canonical wrap)。
 *
 * `wavefile` (rochars/wavefile) を 内 部 利 用 = WAV spec compliance 1 位
 * (= 24-bit ま た は channels > 2 で `WAVE_FORMAT_EXTENSIBLE` 自 動 切 替 +
 * `dwChannelMask` mono/stereo/quad/5.1/7.1 + RIFX big-endian + ADPCM /
 * A-Law / Mu-Law 全 対 応 + `validateNumChannels` / `validateSampleRate`
 * 強 制)。
 *
 * unworklet 側 surface = `Float32Array[]` channels + sampleRate + optional
 * `bitDepth` = wavefile の `fromScratch` に そ の ま ま 渡 す。 byte 出 力 =
 * `Uint8Array` で 返 す (= consumer が `fs.writeFile` / `Blob` 等 で 受 け る)。
 */

import { WaveFile } from "wavefile";

/**
 * `wavefile` の bitDepth code subset。 8 / 16 / 24 / 32 = integer PCM、
 * 32f = IEEE Float (= AudioWorklet と zip)、 64 = IEEE Double。 A-Law /
 * Mu-Law / ADPCM (= '8a' / '8m' / '4') は 仕 様 上 wavefile が 支 持 す る
 * が、 unworklet の renderOffline 出 力 (= Float32Array) は linear PCM 直
 * 受 け = canonical surface か ら 除 外 (= wavefile を 直 接 使 え ば access
 * 可)。
 */
export type EncodeWavBitDepth = "8" | "16" | "24" | "32" | "32f" | "64";

export type EncodeWavOptions = {
  /** Default = `"32f"` (= IEEE Float、 unworklet renderOffline 出 力 と bit-exact zip)。 */
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
