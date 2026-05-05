// Minimal WAV writer — 16-bit PCM and 32-bit float.
// Spec: http://www-mmsp.ece.mcgill.ca/Documents/AudioFormats/WAVE/WAVE.html

export type WavFormat = "pcm16" | "pcm24" | "float32";

export function encodeWAV(
  channels: Float32Array[],
  sampleRate: number,
  format: WavFormat = "float32",
): Uint8Array {
  const numChannels = channels.length;
  if (numChannels === 0) throw new Error("encodeWAV: no channels");
  const numSamples = channels[0]!.length;
  for (const c of channels) {
    if (c.length !== numSamples) throw new Error("encodeWAV: all channels must be the same length");
  }

  const bitsPerSample = format === "pcm16" ? 16 : format === "pcm24" ? 24 : 32;
  const formatTag = format === "float32" ? 3 : 1; // 1 = PCM, 3 = IEEE float
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const totalSize = 44 + dataSize;

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  let off = 0;
  const writeStr = (s: string) => {
    for (const ch of s) view.setUint8(off++, ch.charCodeAt(0));
  };

  writeStr("RIFF");
  view.setUint32(off, totalSize - 8, true);
  off += 4;
  writeStr("WAVE");
  writeStr("fmt ");
  view.setUint32(off, 16, true);
  off += 4; // fmt chunk size
  view.setUint16(off, formatTag, true);
  off += 2;
  view.setUint16(off, numChannels, true);
  off += 2;
  view.setUint32(off, sampleRate, true);
  off += 4;
  view.setUint32(off, byteRate, true);
  off += 4;
  view.setUint16(off, blockAlign, true);
  off += 2;
  view.setUint16(off, bitsPerSample, true);
  off += 2;
  writeStr("data");
  view.setUint32(off, dataSize, true);
  off += 4;

  // Interleaved channel data
  if (format === "float32") {
    for (let s = 0; s < numSamples; s++) {
      for (let c = 0; c < numChannels; c++) {
        view.setFloat32(off, channels[c]![s]!, true);
        off += 4;
      }
    }
  } else if (format === "pcm16") {
    for (let s = 0; s < numSamples; s++) {
      for (let c = 0; c < numChannels; c++) {
        const v = Math.max(-1, Math.min(1, channels[c]![s]!));
        view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        off += 2;
      }
    }
  } else {
    // pcm24
    for (let s = 0; s < numSamples; s++) {
      for (let c = 0; c < numChannels; c++) {
        const v = Math.max(-1, Math.min(1, channels[c]![s]!));
        const i = Math.round(v < 0 ? v * 0x800000 : v * 0x7fffff) | 0;
        view.setUint8(off, i & 0xff);
        view.setUint8(off + 1, (i >>> 8) & 0xff);
        view.setUint8(off + 2, (i >>> 16) & 0xff);
        off += 3;
      }
    }
  }

  return new Uint8Array(buf);
}

export function decodeWAV(buf: Uint8Array): {
  channels: Float32Array[];
  sampleRate: number;
} {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (
    String.fromCharCode(buf[0]!, buf[1]!, buf[2]!, buf[3]!) !== "RIFF" ||
    String.fromCharCode(buf[8]!, buf[9]!, buf[10]!, buf[11]!) !== "WAVE"
  ) {
    throw new Error("Not a RIFF/WAVE file");
  }
  let off = 12;
  let formatTag = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOff = 0;
  let dataSize = 0;
  while (off < buf.length) {
    const id = String.fromCharCode(buf[off]!, buf[off + 1]!, buf[off + 2]!, buf[off + 3]!);
    const size = view.getUint32(off + 4, true);
    if (id === "fmt ") {
      formatTag = view.getUint16(off + 8, true);
      numChannels = view.getUint16(off + 10, true);
      sampleRate = view.getUint32(off + 12, true);
      bitsPerSample = view.getUint16(off + 22, true);
    } else if (id === "data") {
      dataOff = off + 8;
      dataSize = size;
      break;
    }
    off += 8 + size;
  }
  if (!dataOff) throw new Error("No data chunk in WAV");
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = dataSize / (numChannels * bytesPerSample);
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(numSamples));
  for (let s = 0; s < numSamples; s++) {
    for (let c = 0; c < numChannels; c++) {
      const i = dataOff + (s * numChannels + c) * bytesPerSample;
      let v = 0;
      if (formatTag === 3 && bitsPerSample === 32) {
        v = view.getFloat32(i, true);
      } else if (formatTag === 1 && bitsPerSample === 16) {
        v = view.getInt16(i, true) / 0x8000;
      } else if (formatTag === 1 && bitsPerSample === 24) {
        const b0 = buf[i]!;
        const b1 = buf[i + 1]!;
        const b2 = buf[i + 2]!;
        const sign = b2 & 0x80;
        let n = b0 | (b1 << 8) | (b2 << 16);
        if (sign) n |= 0xff000000 | 0;
        v = n / 0x800000;
      } else if (formatTag === 1 && bitsPerSample === 8) {
        v = (buf[i]! - 128) / 128;
      }
      channels[c]![s] = v;
    }
  }
  return { channels, sampleRate };
}
