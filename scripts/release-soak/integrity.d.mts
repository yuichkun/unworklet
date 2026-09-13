export type Sequence = {
  received: number;
  first: number | null;
  last: number | null;
  gaps: number;
  duplicates: number;
  reversed: number;
  corrupt: number;
};

export function createSequence(): Sequence;
export function observeSequence(
  stream: Sequence,
  value: number,
  intact: boolean,
  modulus?: number,
): void;
export function validateReceipt(
  receipt: {
    transport: string;
    sampleRate: number;
    elapsedSeconds: number;
    audioSeconds: number;
    quanta: number;
    hiddenSeconds: number;
    visibleSeconds: number;
    transitions: { hidden: number; visible: number };
    errors: { total: number };
    streams: Record<string, Sequence>;
    overflow: Record<string, number>;
    published: { count: number; last: number; reversed: number };
    stalledIntervals: number;
  },
  transport: string,
  durationSeconds: number,
): string[];
