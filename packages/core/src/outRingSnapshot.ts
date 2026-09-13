import { atomicMonotoneMax, ringLeads } from "./ringIndex.ts";

export type OutRingSnapshot = {
  readonly header: Int32Array;
  readonly sharedSlots: Uint8Array;
  readonly sharedContent: Uint8Array | null;
  readonly slots: Uint8Array;
  readonly view: DataView;
  readonly content: Uint8Array | null;
  readonly access: Int32Array;
  readonly accessIndex: number;
  from: number;
  head: number;
};

export function createOutRingSnapshot(
  buffer: SharedArrayBuffer | ArrayBuffer,
  offset: number,
  slotBytes: number,
  content: Uint8Array | null,
  access: Int32Array,
  accessIndex: number,
): OutRingSnapshot {
  const slots = new Uint8Array(slotBytes);
  return {
    header: new Int32Array(buffer, offset, 3),
    sharedSlots: new Uint8Array(buffer, offset + 12, slotBytes),
    sharedContent: content,
    slots,
    view: new DataView(slots.buffer),
    content: content === null ? null : new Uint8Array(content.byteLength),
    access,
    accessIndex,
    from: 0,
    head: 0,
  };
}

/** Ownership covers slot bytes and their separately stored content together. */
export function captureOutRing(snapshot: OutRingSnapshot, localTail: number): boolean {
  const { access, accessIndex, header } = snapshot;
  if (Atomics.compareExchange(access, accessIndex, 0, 1) !== 0) return false;
  try {
    const head = Atomics.load(header, 0);
    const sharedTail = Atomics.load(header, 1);
    const from = ringLeads(sharedTail, localTail) ? sharedTail : localTail;
    if (!ringLeads(head, from)) return false;
    snapshot.slots.set(snapshot.sharedSlots);
    if (snapshot.content !== null) snapshot.content.set(snapshot.sharedContent!);
    snapshot.from = from;
    snapshot.head = head;
    // The batch belongs to main, even while its callbacks let audio continue.
    atomicMonotoneMax(header, 1, head);
    return true;
  } finally {
    Atomics.store(access, accessIndex, 0);
  }
}
