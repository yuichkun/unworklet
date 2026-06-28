/**
 * Layer F — validate the runtime self-check primitive.
 *
 * The checker is only worth gating a debug build on if it actually catches
 * corruption, so prove it: a sane header passes; an overfill, a tail-rewind
 * (the split-writer lost update), a negative overflow, and a zero capacity each
 * fail.
 */

import { expect, test } from "vite-plus/test";

import { checkRingHeader } from "./selfcheck.ts";

test("checkRingHeader passes a sane ring header", () => {
  expect(
    checkRingHeader(/* head */ 7, /* tail */ 3, /* overflow */ 0, /* capacity */ 16),
  ).toBeNull();
  // A full ring (fill === capacity) is still sane.
  expect(checkRingHeader(16, 0, 2, 16)).toBeNull();
  // Wrap-safe: both counters past 2^31, fill still in range.
  expect(checkRingHeader(-0x80000000 + 5, 0x7fffffff, 0, 16)).toBeNull();
});

test("checkRingHeader catches an overfill (producer overran un-drained slots)", () => {
  expect(checkRingHeader(20, 0, 0, 16)).toMatch(/exceeds capacity/);
});

test("checkRingHeader catches a tail rewind (the split-writer lost update)", () => {
  // tail ahead of head reads back as a huge unsigned fill — the corruption a
  // non-monotone tail produces.
  expect(checkRingHeader(5, 8, 0, 16)).toMatch(/exceeds capacity/);
});

test("checkRingHeader catches a negative overflow counter and a non-positive capacity", () => {
  expect(checkRingHeader(1, 0, -1, 16)).toMatch(/overflow counter is negative/);
  expect(checkRingHeader(1, 0, 0, 0)).toMatch(/capacity must be positive/);
});
