import { expect, test } from "vite-plus/test";

import { createSequence, observeSequence, validateReceipt } from "./integrity.mjs";

test("sequence accounting distinguishes gaps, duplicates, reversed and torn payloads", () => {
  const sequence = createSequence();
  observeSequence(sequence, 1, true);
  observeSequence(sequence, 3, true);
  observeSequence(sequence, 3, true);
  observeSequence(sequence, 2, true);
  observeSequence(sequence, 4, false);
  expect(sequence).toMatchObject({
    received: 5,
    last: 4,
    gaps: 1,
    duplicates: 1,
    reversed: 1,
    corrupt: 1,
  });
});

test("MIDI sequence numbers unwrap without treating a wrap as reversed delivery", () => {
  const sequence = createSequence();
  for (const value of [2046, 2047, 0, 1]) observeSequence(sequence, value, true, 2048);
  expect(sequence).toMatchObject({ received: 4, last: 1, gaps: 0, duplicates: 0, reversed: 0 });
});

test("a receipt needs real audio progress, both visibility states, and intact streams", () => {
  const receipt = {
    transport: "sab",
    sampleRate: 48000,
    elapsedSeconds: 10,
    audioSeconds: 10,
    quanta: 3750,
    hiddenSeconds: 4,
    visibleSeconds: 6,
    transitions: { hidden: 1, visible: 1 },
    errors: { total: 0 },
    streams: { scalar: { ...createSequence(), received: 200, last: 200 } },
    overflow: { scalar: 0 },
    published: { count: 4, last: 3600, reversed: 0 },
    stalledIntervals: 0,
  };
  expect(validateReceipt(receipt, "sab", 10)).toEqual([]);
  expect(validateReceipt({ ...receipt, audioSeconds: 0 }, "sab", 10)).toContain(
    "audio clock did not cover the requested duration",
  );
  expect(validateReceipt({ ...receipt, hiddenSeconds: 0 }, "sab", 10)).toContain(
    "document did not run in both visibility states",
  );
  expect(validateReceipt({ ...receipt, overflow: { scalar: 1 } }, "sab", 10)).toContain(
    "scalar overflowed during the normal-rate stream",
  );
  expect(
    validateReceipt(
      { ...receipt, streams: { scalar: { ...receipt.streams.scalar, corrupt: 1 } } },
      "sab",
      10,
    ),
  ).toContain("scalar delivered duplicate, reversed, or corrupt packets");
  expect(
    validateReceipt(
      { ...receipt, streams: { scalar: { ...receipt.streams.scalar, received: 1 } } },
      "sab",
      10,
    ),
  ).toContain("scalar delivery did not keep pace with processor progress");
});
