import { expect, test, vi } from "vite-plus/test";

import { captureOutRing, createOutRingSnapshot } from "./outRingSnapshot.ts";

const fixture = (withContent = true) => {
  const buffer = new SharedArrayBuffer(12 + 16 * 8);
  const content = withContent ? new Uint8Array(new SharedArrayBuffer(32)) : null;
  const access = new Int32Array(new SharedArrayBuffer(4));
  const snapshot = createOutRingSnapshot(buffer, 0, 16 * 8, content, access, 0);
  const header = new Int32Array(buffer, 0, 3);
  const slots = new Uint8Array(buffer, 12);
  return { snapshot, header, slots, content, access };
};

for (const withContent of [false, true]) {
  test(`a captured ring owns its bytes and acknowledges its head (content=${withContent})`, () => {
    const { snapshot, header, slots, content, access } = fixture(withContent);
    header.set([5, 2, 1]);
    slots.fill(42);
    content?.fill(77);
    expect(captureOutRing(snapshot, 1)).toBe(true);
    expect([snapshot.from, snapshot.head]).toEqual([2, 5]);
    expect(header[1]).toBe(5);
    expect(access[0]).toBe(0);
    slots.fill(0);
    content?.fill(0);
    expect(Array.from(snapshot.slots)).toEqual(Array(128).fill(42));
    expect(snapshot.content === null ? null : Array.from(snapshot.content)).toEqual(
      withContent ? Array(32).fill(77) : null,
    );
    expect(captureOutRing(snapshot, snapshot.head)).toBe(false);
    expect(access[0]).toBe(0);
  });
}

test("a busy publisher is attempted once without copying or acknowledging", () => {
  const { snapshot, header, slots, access } = fixture();
  header.set([4, 0, 0]);
  slots.fill(42);
  access[0] = 1;
  const compare = vi.spyOn(Atomics, "compareExchange");
  try {
    expect(captureOutRing(snapshot, 0)).toBe(false);
    expect(compare).toHaveBeenCalledOnce();
    expect(header[1]).toBe(0);
    expect(snapshot.slots.every((value) => value === 0)).toBe(true);
    expect(access[0]).toBe(1);
  } finally {
    compare.mockRestore();
  }
});

for (const start of [0x7ffffffe, 0xfffffffe]) {
  test(`snapshot cursors cross ring-counter wrap from ${start}`, () => {
    const { snapshot, header } = fixture(false);
    header.set([(start + 3) | 0, start | 0, 0]);
    expect(captureOutRing(snapshot, (start + 1) | 0)).toBe(true);
    expect(snapshot.from).toBe((start + 1) | 0);
    expect(snapshot.head).toBe((start + 3) | 0);
    expect(header[1]).toBe((start + 3) | 0);
  });
}

test("copy failure releases access without acknowledging uncopied slots", () => {
  const { snapshot, header, access } = fixture();
  header.set([4, 0, 0]);
  const copy = vi.spyOn(snapshot.slots, "set").mockImplementation(() => {
    throw new Error("copy failed");
  });
  try {
    expect(() => captureOutRing(snapshot, 0)).toThrow("copy failed");
    expect(header[1]).toBe(0);
    expect(access[0]).toBe(0);
  } finally {
    copy.mockRestore();
  }
});

test("the snapshot owns access until both copies and the tail acknowledgement finish", () => {
  const { snapshot, header, access } = fixture();
  header.set([4, 0, 0]);
  const order: string[] = [];
  const realSlotsSet = snapshot.slots.set.bind(snapshot.slots);
  const realContentSet = snapshot.content!.set.bind(snapshot.content);
  const slots = vi.spyOn(snapshot.slots, "set").mockImplementation((source, offset) => {
    expect(access[0]).toBe(1);
    expect(header[1]).toBe(0);
    order.push("slots");
    realSlotsSet(source, offset);
  });
  const content = vi.spyOn(snapshot.content!, "set").mockImplementation((source, offset) => {
    expect(access[0]).toBe(1);
    expect(header[1]).toBe(0);
    order.push("content");
    realContentSet(source, offset);
  });
  const compare = Atomics.compareExchange.bind(Atomics);
  const acknowledgement = vi.spyOn(Atomics, "compareExchange").mockImplementation(((
    view: Int32Array,
    index: number,
    expected: number,
    replacement: number,
  ) => {
    if (view.buffer === header.buffer) {
      expect(access[0]).toBe(1);
      order.push("ack");
    }
    return compare(view, index, expected, replacement);
  }) as typeof Atomics.compareExchange);
  try {
    expect(captureOutRing(snapshot, 0)).toBe(true);
    expect(order).toEqual(["slots", "content", "ack"]);
    expect(access[0]).toBe(0);
  } finally {
    slots.mockRestore();
    content.mockRestore();
    acknowledgement.mockRestore();
  }
});
