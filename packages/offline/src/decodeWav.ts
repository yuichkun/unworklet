/**
 * WAV byte decoder helper for `renderOffline` round-trip (= encodeWav と
 * pair で `@unworklet/offline` か ら 別 export)。 内 部 で `wavefile`
 * (rochars/wavefile) を 利 用 = WAV spec compliance 1 位 = `WAVE_FORMAT_EXTENSIBLE`
 * + RIFX (big-endian) + ADPCM/Alaw/Mulaw / 全 bit depth 認 識。
 *
 * raw carry path = `wavefile.getSamples(false, Float32Array)` を そ の ま ま
 * 返 す = 32f / 64f Float wav は -1〜1 正 規 化 値、 8/16/24/32 int PCM wav は
 * **raw signed int 値** を Float32Array に carry (= wavefile 仕 様 通 り、
 * consumer 自 力 で `/ 32768` 等 で normalize)。 unworklet renderOffline
 * 出 力 (= 32f-default) と encodeWav (= 32f-default) の round-trip は
 * bit-exact。
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
