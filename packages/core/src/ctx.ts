import type { ProcessorContext } from "./types.js";

export function buildProcessorContext(opts: {
  sampleRate: number;
  renderQuantum: number;
}): ProcessorContext {
  const { sampleRate, renderQuantum } = opts;
  return {
    sampleRate,
    renderQuantum,
    samples(ms: number): number {
      return Math.max(0, Math.round((ms * sampleRate) / 1000));
    },
    hz(midiNote: number): number {
      return 440 * Math.pow(2, (midiNote - 69) / 12);
    },
  };
}
