// 16-bit signed PCM WAV encoder (= RIFF / WAVE / fmt / data layout).
//
// Browser-targeted, no deps. Mirrors the shape of @unworklet/offline's
// encodeWav but stays self-contained because offline pulls binaryen
// transitively through @unworklet/core and would bloat the dev panel
// bundle (and break in the browser).

export const encodeWav = (channels: Float32Array[], sampleRate: number): Uint8Array => {
  const numChannels = channels.length;
  if (numChannels === 0) throw new Error("encodeWav: at least one channel required");
  const numSamples = channels[0]!.length;
  for (const ch of channels) {
    if (ch.length !== numSamples) throw new Error("encodeWav: channel length mismatch");
  }
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  let offset = 0;
  const writeString = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset++, s.charCodeAt(i));
    }
  };

  writeString("RIFF");
  view.setUint32(offset, totalSize - 8, true);
  offset += 4;
  writeString("WAVE");

  writeString("fmt ");
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true); // PCM format
  offset += 2;
  view.setUint16(offset, numChannels, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, byteRate, true);
  offset += 4;
  view.setUint16(offset, blockAlign, true);
  offset += 2;
  view.setUint16(offset, 16, true); // bits per sample
  offset += 2;

  writeString("data");
  view.setUint32(offset, dataSize, true);
  offset += 4;

  // Interleave channels + clamp Float32 [-1, 1] → Int16 [-32768, 32767]
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numChannels; c++) {
      const v = Math.max(-1, Math.min(1, channels[c]![i]!));
      const int16 = v < 0 ? Math.round(v * 32_768) : Math.round(v * 32_767);
      view.setInt16(offset, int16, true);
      offset += 2;
    }
  }

  return out;
};

export const timestampLabel = (): string => {
  const d = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
};
