export function createSequence() {
  return { received: 0, first: null, last: null, gaps: 0, duplicates: 0, reversed: 0, corrupt: 0 };
}

export function observeSequence(stream, value, intact, modulus = 0) {
  stream.received++;
  if (!Number.isInteger(value) || !intact) stream.corrupt++;
  if (stream.first === null) stream.first = value;
  if (stream.last !== null) {
    const delta = modulus ? (value - stream.last + modulus) % modulus : value - stream.last;
    if (delta === 0) stream.duplicates++;
    else if (delta < 0 || (modulus && delta > modulus / 2)) stream.reversed++;
    else if (delta > 1) stream.gaps += delta - 1;
  }
  if (stream.last === null || modulus || value > stream.last) stream.last = value;
}

export function validateReceipt(receipt, transport, durationSeconds) {
  const failures = [];
  if (receipt.transport !== transport) failures.push("transport did not match server isolation");
  if (receipt.sampleRate !== 48000) failures.push("AudioContext sample rate was not 48000 Hz");
  if (receipt.elapsedSeconds < durationSeconds) failures.push("wall clock ended early");
  if (receipt.audioSeconds < durationSeconds * 0.95) {
    failures.push("audio clock did not cover the requested duration");
  }
  if (receipt.quanta < ((durationSeconds * 48000) / 128) * 0.85) {
    failures.push("processor did not advance for the requested duration");
  }
  if (
    !receipt.hiddenSeconds ||
    !receipt.visibleSeconds ||
    !receipt.transitions.hidden ||
    !receipt.transitions.visible
  ) {
    failures.push("document did not run in both visibility states");
  }
  if (receipt.errors.total) failures.push("browser or worklet reported errors");
  if (receipt.stalledIntervals) failures.push("processor stalled between progress receipts");
  if (!receipt.published.count || receipt.published.reversed) {
    failures.push("published processor progress was absent or reversed");
  }
  for (const [name, stream] of Object.entries(receipt.streams)) {
    if (!stream.received) failures.push(`${name} delivered no packets`);
    if (
      ["scalar", "typed", "midi", "sysex"].includes(name) &&
      stream.received < Math.floor(receipt.quanta / 64) - 4
    ) {
      failures.push(`${name} delivery did not keep pace with processor progress`);
    }
    if (stream.duplicates || stream.reversed || stream.corrupt) {
      failures.push(`${name} delivered duplicate, reversed, or corrupt packets`);
    }
    if (stream.gaps) failures.push(`${name} lost packets during the normal-rate stream`);
  }
  for (const [name, count] of Object.entries(receipt.overflow)) {
    if (count !== 0) failures.push(`${name} overflowed during the normal-rate stream`);
  }
  return failures;
}
