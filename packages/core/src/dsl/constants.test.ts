/**
 * Behavioral tests for build-time constants (= `02-messaging.md` §3 +
 * `decisions-log.md` Q44).
 */

import { expect, test } from "vite-plus/test";

import {
  CAPACITY_16,
  CAPACITY_32,
  CAPACITY_64,
  CAPACITY_128,
  CAPACITY_256,
  CAPACITY_512,
  CAPACITY_1024,
  CAPACITY_2048,
  CAPACITY_4096,
  CAPACITY_8192,
  CAPACITY_16384,
  DEFAULT_RENDER_QUANTUM_SIZE,
} from "./constants.ts";

test("the default compile target quantum is the Web Audio default of 128 samples", () => {
  expect(DEFAULT_RENDER_QUANTUM_SIZE).toBe(128);
});

test("`CAPACITY_*` tokens cover every power of two between 16 and 16384", () => {
  expect([
    CAPACITY_16,
    CAPACITY_32,
    CAPACITY_64,
    CAPACITY_128,
    CAPACITY_256,
    CAPACITY_512,
    CAPACITY_1024,
    CAPACITY_2048,
    CAPACITY_4096,
    CAPACITY_8192,
    CAPACITY_16384,
  ]).toEqual([16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384]);
});

test("every `CAPACITY_*` token is a power of two (= `head & (capacity - 1)` mask invariant)", () => {
  const tokens = [
    CAPACITY_16,
    CAPACITY_32,
    CAPACITY_64,
    CAPACITY_128,
    CAPACITY_256,
    CAPACITY_512,
    CAPACITY_1024,
    CAPACITY_2048,
    CAPACITY_4096,
    CAPACITY_8192,
    CAPACITY_16384,
  ];
  for (const cap of tokens) {
    expect(cap & (cap - 1)).toBe(0);
  }
});
