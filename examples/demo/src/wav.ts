export type Wav = { sampleRate: number; channels: Float32Array[] };

export function readWav(bytes: ArrayBuffer): Wav {
  const fail = (): never => {
    throw new Error("unreadable WAV");
  };
  const view = new DataView(bytes);
  const text = (at: number) => String.fromCharCode(...new Uint8Array(bytes, at, 4));
  if (bytes.byteLength < 12 || text(0) !== "RIFF" || text(8) !== "WAVE") fail();
  const end = view.getUint32(4, true) + 8;
  if (end < 12 || end > bytes.byteLength) fail();
  let format: { count: number; rate: number; block: number } | undefined;
  let data: { start: number; size: number } | undefined;
  let at = 12;
  while (at < end) {
    if (at + 8 > end) fail();
    const kind = text(at);
    const size = view.getUint32(at + 4, true);
    const start = at + 8;
    if (start + size + (size % 2) > end) fail();
    if (kind === "fmt ") {
      if (
        format ||
        size < 16 ||
        view.getUint16(start, true) !== 3 ||
        view.getUint16(start + 14, true) !== 32
      )
        fail();
      const count = view.getUint16(start + 2, true);
      const rate = view.getUint32(start + 4, true);
      const block = view.getUint16(start + 12, true);
      if (
        !count ||
        !rate ||
        block !== count * 4 ||
        view.getUint32(start + 8, true) !== rate * block
      )
        fail();
      format = { count, rate, block };
    } else if (kind === "data") {
      if (data) fail();
      data = { start, size };
    }
    at = start + size + (size % 2);
  }
  if (!format || !data || !data.size || data.size % format.block) return fail();
  const frames = data.size / format.block;
  const channels = Array.from({ length: format.count }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels.length; c++) {
      const sample = view.getFloat32(data.start + i * format.block + c * 4, true);
      if (!Number.isFinite(sample)) fail();
      channels[c]![i] = sample;
    }
  }
  return { sampleRate: format.rate, channels };
}

export function compareWav(a: Wav, b: Wav, tolerance: number): boolean {
  if (a.sampleRate !== b.sampleRate || a.channels.length !== b.channels.length) return false;
  return a.channels.every((channel, c) => {
    const other = b.channels[c]!;
    return (
      channel.length === other.length &&
      channel.every(
        (value, i) =>
          Number.isFinite(value) &&
          Number.isFinite(other[i]) &&
          Math.abs(value - other[i]!) <= tolerance,
      )
    );
  });
}
