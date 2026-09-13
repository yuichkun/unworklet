import { ringCount, ringSlotIndex } from "./ringIndex.ts";

export interface SabIngressRing {
  readonly header: Int32Array;
  readonly slots: readonly Uint8Array[];
  readonly data: readonly DataView[];
  readonly content: readonly Uint8Array[];
  readonly capacity: number;
  readonly slotBytes: number;
  readonly contentBytes: number;
  readonly contentOffset: number;
  readonly midi: boolean;
}

export function bindSabIngress(
  bytes: Uint8Array,
  content: Uint8Array | null,
  capacity: number,
  contentOffset: number,
  midi: boolean,
): SabIngressRing {
  const slotBytes = (bytes.byteLength - 12) / capacity;
  const contentBytes = content === null ? 0 : content.byteLength / capacity;
  return {
    header: new Int32Array(bytes.buffer, bytes.byteOffset, 3),
    slots: Array.from({ length: capacity }, (_, i) =>
      bytes.subarray(12 + i * slotBytes, 12 + (i + 1) * slotBytes),
    ),
    data: Array.from(
      { length: capacity },
      (_, i) => new DataView(bytes.buffer, bytes.byteOffset + 12 + i * slotBytes, slotBytes),
    ),
    content:
      content === null
        ? []
        : Array.from({ length: capacity }, (_, i) =>
            content.subarray(i * contentBytes, (i + 1) * contentBytes),
          ),
    capacity,
    slotBytes,
    contentBytes,
    contentOffset,
    midi,
  };
}

function copySlot(source: SabIngressRing, from: number, target: SabIngressRing, to: number): void {
  target.slots[to]!.set(source.slots[from]!);
  if (source.contentBytes === 0) return;
  target.content[to]!.set(source.content[from]!);
  if (target.midi) {
    if (target.data[to]!.getUint8(0) === 0xf0) target.data[to]!.setUint16(1, to, true);
  } else {
    target.data[to]!.setUint32(target.contentOffset, to * target.contentBytes, true);
  }
}

export interface SabIngressWriter {
  enqueue(encode: (slot: DataView, content: Uint8Array | null) => void): void;
  flush(): void;
  pending(): boolean;
}

export function createSabIngressWriter(
  access: Int32Array,
  index: number,
  shared: SabIngressRing,
): SabIngressWriter {
  const staging = bindSabIngress(
    new Uint8Array(12 + shared.capacity * shared.slotBytes),
    shared.contentBytes === 0 ? null : new Uint8Array(shared.capacity * shared.contentBytes),
    shared.capacity,
    shared.contentOffset,
    shared.midi,
  );
  let count = 0;
  let read = 0;
  const flush = (): void => {
    if (count === 0 || Atomics.compareExchange(access, index, 0, 1) !== 0) return;
    try {
      let head = Atomics.load(shared.header, 0);
      let tail = Atomics.load(shared.header, 1);
      let dropped = 0;
      for (let i = 0; i < count; i++) {
        if (ringCount(head, tail) >= shared.capacity) {
          tail = (tail + 1) | 0;
          dropped++;
        }
        copySlot(
          staging,
          (read + i) % shared.capacity,
          shared,
          ringSlotIndex(head, shared.capacity),
        );
        head = (head + 1) | 0;
      }
      Atomics.store(shared.header, 1, tail);
      if (dropped > 0) Atomics.add(shared.header, 2, dropped);
      Atomics.store(shared.header, 0, head);
      read = (read + count) % shared.capacity;
      count = 0;
    } finally {
      Atomics.store(access, index, 0);
    }
  };
  return {
    enqueue(encode): void {
      const bytes = new Uint8Array(shared.slotBytes);
      const content = shared.contentBytes === 0 ? null : new Uint8Array(shared.contentBytes);
      encode(new DataView(bytes.buffer), content);
      flush();
      if (count === shared.capacity) {
        read = (read + 1) % shared.capacity;
        count--;
        Atomics.add(shared.header, 2, 1);
      }
      const slot = (read + count) % shared.capacity;
      staging.slots[slot]!.set(bytes);
      if (content !== null) staging.content[slot]!.set(content);
      count++;
      flush();
    },
    flush,
    pending: () => count > 0,
  };
}

export function consumeSabIngress(
  access: Int32Array,
  index: number,
  shared: SabIngressRing,
  wasm: SabIngressRing,
): void {
  if (Atomics.compareExchange(access, index, 0, 1) !== 0) return;
  try {
    const head = Atomics.load(shared.header, 0);
    const tail = Atomics.load(shared.header, 1);
    let wasmHead = wasm.header[0]!;
    let wasmTail = wasm.header[1]!;
    let dropped = 0;
    const count = ringCount(head, tail);
    for (let i = 0; i < count; i++) {
      if (ringCount(wasmHead, wasmTail) >= wasm.capacity) {
        wasmTail = (wasmTail + 1) | 0;
        dropped++;
      }
      copySlot(
        shared,
        ringSlotIndex(tail + i, shared.capacity),
        wasm,
        ringSlotIndex(wasmHead, wasm.capacity),
      );
      wasmHead = (wasmHead + 1) | 0;
    }
    wasm.header[0] = wasmHead;
    wasm.header[1] = wasmTail;
    if (dropped > 0) Atomics.add(shared.header, 2, dropped);
    wasm.header[2] = Atomics.load(shared.header, 2);
    // Copying transfers ownership; handler execution must not hold the producer's slots.
    Atomics.store(shared.header, 1, head);
  } finally {
    Atomics.store(access, index, 0);
  }
}
