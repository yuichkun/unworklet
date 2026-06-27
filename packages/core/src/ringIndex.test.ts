/**
 * Contract of `ringSlotIndex` — the shared ring-index helper that keeps slot
 * indexing correct after the i32 ring counters wrap past 2^31. Black-box: drive
 * it with counters spanning the wrap and assert it matches the unsigned modulo
 * the WASM side computes (`rem_u`), always landing in `[0, mod)`.
 */

import { expect, test } from "vite-plus/test";

import { ringCount, ringSlotIndex } from "./ringIndex.ts";

// What `rem_u` computes: the counter taken as a uint32, then `% mod`. Derived
// from first principles (BigInt), not from the implementation under test.
const unsignedRef = (counter: number, mod: number): number =>
  Number(BigInt(counter >>> 0) % BigInt(mod));

test("ringSlotIndex matches the unsigned reference for every counter across the i32 wrap", () => {
  // Counters at and around the wrap. A signed `Int32Array` read yields the
  // negative values once a push count passes 2^31, so they are part of the
  // domain the helper must handle.
  const counters = [
    0,
    1,
    99,
    100,
    255,
    256,
    0x7fffffff - 1,
    0x7fffffff, // last positive i32
    -0x80000000, // 2^31 read back as a signed i32
    -0x7fffffff,
    -256,
    -100,
    -1, // 2^32 - 1 read back as a signed i32
  ];
  // pow2 and non-pow2 moduli — the non-pow2 case is where a bare signed `%`
  // diverges most sharply from `rem_u`.
  for (const mod of [7, 100, 256, 1024]) {
    for (const c of counters) {
      const got = ringSlotIndex(c, mod);
      expect(got).toBe(unsignedRef(c, mod));
      expect(got).toBeGreaterThanOrEqual(0);
      expect(got).toBeLessThan(mod);
    }
  }
});

test("a counter that wraps past 2^31 indexes out of bounds with a bare %, but stays in range via ringSlotIndex", () => {
  // Reproduce the exact failure mode: an i32 header word advanced past 2^31.
  const header = new Int32Array(1);
  header[0] = 0x7ffffffe;
  header[0] = header[0]! + 4; // push count crosses 2^31
  expect(header[0]).toBeLessThan(0); // the wrap: now a negative signed i32

  const cap = 100; // non-pow2: a bare % and rem_u diverge sharply here
  // The bug the helper exists to remove: a bare `head % cap` is negative, so
  // `base + (head % cap) * slotSize` points before the ring.
  expect(header[0]! % cap).toBeLessThan(0);

  const idx = ringSlotIndex(header[0]!, cap);
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(idx).toBeLessThan(cap);
  expect(idx).toBe(unsignedRef(header[0]!, cap));
});

test("ringCount returns the true unsigned fill across the i32 wrap, including the head-wrapped-tail-not window", () => {
  const cases = [
    { head: 5, tail: 0, fill: 5 },
    { head: 256, tail: 250, fill: 6 },
    // The dangerous window: head has wrapped past 2^31, tail has not.
    { head: -0x80000000, tail: 0x7fffffff, fill: 1 }, // 2^31 vs 2^31 - 1
    { head: -0x80000000 + 255, tail: 0x7fffffff, fill: 256 }, // a full ring straddling the wrap
    { head: -1, tail: -256, fill: 255 }, // both wrapped (2^32 - 1 vs 2^32 - 256)
    { head: 0, tail: -1, fill: 1 }, // tail = 2^32 - 1, head wrapped back to 0
  ];
  for (const { head, tail, fill } of cases) {
    expect(ringCount(head, tail)).toBe(fill);
  }
  // The bug it removes: in the straddling case a bare signed subtraction is a
  // huge negative, so `head - tail >= capacity` reports "not full" when the ring
  // is actually full.
  const straddleHead = -0x80000000 + 255;
  const straddleTail = 0x7fffffff;
  expect(straddleHead - straddleTail).toBeLessThan(0);
  expect(ringCount(straddleHead, straddleTail)).toBe(256);
});
