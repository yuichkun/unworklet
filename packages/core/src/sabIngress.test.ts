import { expect, test, vi } from "vite-plus/test";
import { bindSabIngress, createSabIngressWriter, consumeSabIngress } from "./sabIngress.ts";

function fixture(capacity = 4) {
  const shared = new SharedArrayBuffer(12 + capacity * 4);
  const access = new Int32Array(new SharedArrayBuffer(4));
  const sab = bindSabIngress(new Uint8Array(shared), null, capacity, -1, false);
  const target = bindSabIngress(new Uint8Array(shared.byteLength), null, capacity, -1, false);
  const writer = createSabIngressWriter(access, 0, sab);
  const send = (n: number) => writer.enqueue((slot) => slot.setInt32(0, n, true));
  const read = () =>
    Array.from({ length: (target.header[0]! - target.header[1]!) >>> 0 }, (_, i) =>
      target.data[((target.header[1]! >>> 0) + i) % capacity]!.getInt32(0, true),
    );
  return { access, sab, target, writer, send, read };
}

test("a copied ingress batch is acknowledged before its handlers run", () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.send(i);
  consumeSabIngress(f.access, 0, f.sab, f.target);
  expect(f.read()).toEqual([0, 1, 2, 3]);
  for (let i = 4; i < 8; i++) f.send(i);
  expect(f.sab.header[2]).toBe(0);
  f.target.header[1] = f.target.header[0]!;
  consumeSabIngress(f.access, 0, f.sab, f.target);
  expect(f.read()).toEqual([4, 5, 6, 7]);
  expect(f.sab.header[2]).toBe(0);
});

test("unhandled input stays queued and its real overflow is counted exactly once", () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.send(i);
  consumeSabIngress(f.access, 0, f.sab, f.target);
  consumeSabIngress(f.access, 0, f.sab, f.target);
  expect(f.read()).toEqual([0, 1, 2, 3]);
  f.send(4);
  consumeSabIngress(f.access, 0, f.sab, f.target);
  expect(f.read()).toEqual([1, 2, 3, 4]);
  expect(f.sab.header[2]).toBe(1);
});

test("contended sends keep FIFO order with a bounded drop-oldest staging ring", () => {
  const f = fixture();
  f.access[0] = 1;
  for (let i = 0; i < 7; i++) f.send(i);
  expect(f.writer.pending()).toBe(true);
  expect(f.sab.header[0]).toBe(0);
  expect(f.sab.header[2]).toBe(3);
  f.access[0] = 0;
  f.writer.flush();
  expect(f.writer.pending()).toBe(false);
  consumeSabIngress(f.access, 0, f.sab, f.target);
  expect(f.read()).toEqual([3, 4, 5, 6]);
  expect(f.sab.header[2]).toBe(3);
});

test("audio intake makes only one ownership attempt and leaves pending input intact", () => {
  const f = fixture();
  f.send(1);
  f.access[0] = 1;
  const compare = vi.spyOn(Atomics, "compareExchange");
  try {
    consumeSabIngress(f.access, 0, f.sab, f.target);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(f.read()).toEqual([]);
    expect(f.sab.header[1]).toBe(0);
  } finally {
    compare.mockRestore();
  }
  f.access[0] = 0;
  consumeSabIngress(f.access, 0, f.sab, f.target);
  expect(f.read()).toEqual([1]);
});

for (const cursor of [0x7ffffffe, 0xfffffffe]) {
  test(`independent SAB and WASM cursors preserve order across ${cursor}`, () => {
    const f = fixture();
    f.sab.header[0] = cursor;
    f.sab.header[1] = cursor;
    f.target.header[0] = cursor - 1;
    f.target.header[1] = cursor - 1;
    for (let i = 0; i < 4; i++) f.send(i);
    consumeSabIngress(f.access, 0, f.sab, f.target);
    expect(f.read()).toEqual([0, 1, 2, 3]);
    expect(f.sab.header[2]).toBe(0);
  });
}

test("a serialization exception preserves the staged batch and drop count", () => {
  const f = fixture();
  f.access[0] = 1;
  for (let i = 0; i < 4; i++) f.send(i);
  expect(() =>
    f.writer.enqueue((slot) => {
      slot.setInt32(0, 99, true);
      throw new Error("getter");
    }),
  ).toThrow("getter");
  expect(f.sab.header[2]).toBe(0);
  f.access[0] = 0;
  f.writer.flush();
  consumeSabIngress(f.access, 0, f.sab, f.target);
  expect(f.read()).toEqual([0, 1, 2, 3]);
});

test("reentrant encoding retains both independently serialized values in call-completion order", () => {
  const f = fixture();
  f.access[0] = 1;
  f.writer.enqueue((slot) => {
    slot.setInt32(0, 7, true);
    f.send(2);
  });
  f.access[0] = 0;
  f.writer.flush();
  consumeSabIngress(f.access, 0, f.sab, f.target);
  expect(f.read()).toEqual([2, 7]);
});

for (const midi of [false, true]) {
  test(`payload ownership relocates into the independent WASM slot (MIDI=${midi})`, () => {
    const capacity = 512;
    const slotBytes = midi ? 8 : 12;
    const contentBytes = 16;
    const shared = bindSabIngress(
      new Uint8Array(new SharedArrayBuffer(12 + capacity * slotBytes)),
      new Uint8Array(new SharedArrayBuffer(capacity * contentBytes)),
      capacity,
      8,
      midi,
    );
    const wasm = bindSabIngress(
      new Uint8Array(12 + capacity * slotBytes),
      new Uint8Array(capacity * contentBytes),
      capacity,
      8,
      midi,
    );
    const access = new Int32Array(new SharedArrayBuffer(4));
    const writer = createSabIngressWriter(access, 0, shared);
    shared.header[0] = 500;
    shared.header[1] = 500;
    wasm.header[0] = 257;
    wasm.header[1] = 257;
    writer.enqueue((slot, content) => {
      if (midi) {
        slot.setUint8(0, 0xf0);
        slot.setUint32(4, 12, true);
      } else {
        slot.setInt32(0, 42, true);
        slot.setUint32(4, 7, true);
      }
      content!.set([3, 4, 5]);
    });
    consumeSabIngress(access, 0, shared, wasm);
    expect(Array.from(wasm.content[257]!.subarray(0, 3))).toEqual([3, 4, 5]);
    if (midi) {
      expect(wasm.data[257]!.getUint16(1, true)).toBe(257);
      expect(wasm.data[257]!.getUint32(4, true)).toBe(12);
    } else {
      expect(wasm.data[257]!.getUint32(8, true)).toBe(257 * contentBytes);
      expect(wasm.data[257]!.getUint32(4, true)).toBe(7);
      expect(wasm.data[257]!.getInt32(0, true)).toBe(42);
    }
  });
}

test("short MIDI messages keep their data bytes on a port with sysex storage", () => {
  const capacity = 4;
  const shared = bindSabIngress(
    new Uint8Array(new SharedArrayBuffer(44)),
    new Uint8Array(new SharedArrayBuffer(64)),
    capacity,
    -1,
    true,
  );
  const wasm = bindSabIngress(new Uint8Array(44), new Uint8Array(64), capacity, -1, true);
  const access = new Int32Array(new SharedArrayBuffer(4));
  const writer = createSabIngressWriter(access, 0, shared);
  writer.enqueue((slot) => {
    slot.setUint8(0, 0x90);
    slot.setUint8(1, 60);
    slot.setUint8(2, 127);
  });
  consumeSabIngress(access, 0, shared, wasm);
  expect(Array.from(wasm.slots[0]!.subarray(0, 3))).toEqual([0x90, 60, 127]);
});

test("a full shared ring drops only its unconsumed oldest slots", () => {
  const f = fixture();
  for (let i = 0; i < 7; i++) f.send(i);
  expect(f.sab.header[2]).toBe(3);
  consumeSabIngress(f.access, 0, f.sab, f.target);
  expect(f.read()).toEqual([3, 4, 5, 6]);
  expect(f.sab.header[2]).toBe(3);
});
