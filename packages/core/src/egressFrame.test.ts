/**
 * Contract of `egressPoolBufferBytes` — the worst-case frame size both sides
 * compute from the same ring descriptors. If the two ever disagreed, the
 * encoder could overrun a pool buffer main allocated; pinning the arithmetic
 * here keeps the wire spec in `egressFrame.ts` honest.
 */

import { expect, test } from "vite-plus/test";

import {
  EGRESS_HEADER_BYTES,
  EGRESS_SECTION_HEADER_BYTES,
  alignUp4,
  egressPoolBufferBytes,
} from "./egressFrame.ts";

test("alignUp4 rounds byte counts up to the next 4-byte boundary", () => {
  expect(alignUp4(0)).toBe(0);
  expect(alignUp4(1)).toBe(4);
  expect(alignUp4(4)).toBe(4);
  expect(alignUp4(1021)).toBe(1024);
});

test("no rings = just the frame header", () => {
  expect(egressPoolBufferBytes([], [])).toBe(EGRESS_HEADER_BYTES);
});

test("an event ring reserves header + full slot window + aligned content region", () => {
  const plain = egressPoolBufferBytes([{ capacity: 16, slotSize: 8 }], []);
  expect(plain).toBe(EGRESS_HEADER_BYTES + EGRESS_SECTION_HEADER_BYTES + 16 * 8);

  const withContent = egressPoolBufferBytes(
    [{ capacity: 16, slotSize: 8, payloadContent: { capacity: 1022 } }],
    [],
  );
  expect(withContent).toBe(
    EGRESS_HEADER_BYTES + EGRESS_SECTION_HEADER_BYTES + 16 * 8 + alignUp4(1022),
  );
});

test("MIDI rings: only out ports reserve space; sysex adds its aligned region", () => {
  const inOnly = egressPoolBufferBytes([], [{ direction: "in", capacity: 16 }]);
  expect(inOnly).toBe(EGRESS_HEADER_BYTES);

  const out = egressPoolBufferBytes([], [{ direction: "out", capacity: 16 }]);
  expect(out).toBe(EGRESS_HEADER_BYTES + EGRESS_SECTION_HEADER_BYTES + 16 * 8);

  const outSysex = egressPoolBufferBytes(
    [],
    [{ direction: "out", capacity: 16, sysex: { perChunk: 1024, chunks: 2 } }],
  );
  expect(outSysex).toBe(EGRESS_HEADER_BYTES + EGRESS_SECTION_HEADER_BYTES + 16 * 8 + 2048);
});
