/**
 * Layer B — step 1: validate the relaxed-memory checker itself against textbook
 * litmus tests with KNOWN outcomes.
 *
 * A model checker that mis-classifies a known litmus result cannot be trusted on
 * the real protocol — its "proof" would be theater. So before the checker is
 * pointed at the ring transport, it must reproduce the canonical results:
 *
 *   - message passing over release/acquire is SAFE;
 *   - the same with a plain flag, or with a non-acquire load, is UNSAFE;
 *   - reads respect per-location coherence;
 *   - two non-atomic increments lose an update; two atomic RMWs do not.
 *
 * If all of these hold, the checker is sound on the release/acquire + RMW
 * fragment the ring uses (see `ring-model.ts` for the modeled fragment + limits).
 */

import { expect, test } from "vite-plus/test";

import {
  type FinalState,
  type ModelSpec,
  RING_SLOT_MARKER,
  explore,
  freshDelivery,
  monotoneLocation,
  outRingPublishSpec,
} from "./ring-model.ts";

const MARKER = 7;

/** Value of the last store to `loc` in coherence order. */
const lastValue = (s: FinalState, loc: string): number => {
  const arr = s.memory.get(loc)!;
  return arr[arr.length - 1]!.value;
};

// ── message passing ─────────────────────────────────────────────────────────

// Producer writes the data slot, then the flag. Consumer reads the flag, then
// the slot. The safety property: if the consumer saw the flag set, the slot it
// read must be the producer's fresh marker (never the stale 0).
const messagePassing = (
  flagMode: "release" | "plain",
  loadMode: "acquire" | "plain",
): ModelSpec => ({
  locations: { head: 0, slot: 0 },
  threads: [
    {
      name: "P",
      ops: [
        { kind: "store", loc: "slot", value: () => MARKER, mode: "plain" },
        { kind: "store", loc: "head", value: () => 1, mode: flagMode },
      ],
    },
    {
      name: "C",
      ops: [
        { kind: "load", loc: "head", into: "h", mode: loadMode },
        { kind: "load", loc: "slot", into: "s", mode: "plain" },
      ],
    },
  ],
});

const fresh = (s: FinalState): string | null =>
  (s.regs.C!.h ?? 0) >= 1 && s.regs.C!.s !== MARKER
    ? `torn read: head=${s.regs.C!.h} slot=${s.regs.C!.s}`
    : null;

test("litmus: message passing over release/acquire is SAFE", () => {
  const result = explore(messagePassing("release", "acquire"), [fresh]);
  expect(result.terminals).toBeGreaterThan(0);
  expect(result.violations).toEqual([]);
});

test("litmus: message passing with a PLAIN flag is UNSAFE (acquire absorbs nothing)", () => {
  const result = explore(messagePassing("plain", "acquire"), [fresh]);
  // The consumer can observe head=1 with no release on it → no happens-before →
  // the slot read is unsynchronized → it may read the stale 0.
  expect(result.violations.length).toBeGreaterThan(0);
});

test("litmus: message passing with a NON-ACQUIRE load is UNSAFE", () => {
  const result = explore(messagePassing("release", "plain"), [fresh]);
  // A plain load of a release store does not synchronize-with it.
  expect(result.violations.length).toBeGreaterThan(0);
});

// ── coherence ───────────────────────────────────────────────────────────────

test("litmus: reads respect per-location coherence (no read-backwards)", () => {
  const spec: ModelSpec = {
    locations: { x: 0 },
    threads: [
      {
        name: "P",
        ops: [
          { kind: "store", loc: "x", value: () => 1, mode: "relaxed" },
          { kind: "store", loc: "x", value: () => 2, mode: "relaxed" },
        ],
      },
      {
        name: "C",
        ops: [
          { kind: "load", loc: "x", into: "a", mode: "relaxed" },
          { kind: "load", loc: "x", into: "b", mode: "relaxed" },
        ],
      },
    ],
  };
  // Once the consumer has seen x=2 it must not later read the older x=1.
  const coherent = (s: FinalState): string | null =>
    s.regs.C!.a === 2 && s.regs.C!.b === 1 ? `coherence violated: a=2 then b=1` : null;
  const result = explore(spec, [coherent]);
  expect(result.terminals).toBeGreaterThan(0);
  expect(result.violations).toEqual([]);
});

// ── lost update vs atomic RMW ───────────────────────────────────────────────

const twoIncrements = (atomic: boolean): ModelSpec => {
  const inc = (name: string) =>
    atomic
      ? { name, ops: [{ kind: "rmw" as const, loc: "c", update: (cur: number) => cur + 1 }] }
      : {
          name,
          ops: [
            { kind: "load" as const, loc: "c", into: "r", mode: "relaxed" as const },
            {
              kind: "store" as const,
              loc: "c",
              value: (r: Record<string, number>) => r.r! + 1,
              mode: "relaxed" as const,
            },
          ],
        };
  return { locations: { c: 0 }, threads: [inc("T1"), inc("T2")] };
};

const summedToTwo = (s: FinalState): string | null =>
  lastValue(s, "c") === 2 ? null : `lost update: c=${lastValue(s, "c")}`;

test("litmus: two NON-ATOMIC increments lose an update (final c can be 1)", () => {
  const result = explore(twoIncrements(false), [summedToTwo]);
  // At least one interleaving has both threads load 0 then store 1.
  expect(result.violations.length).toBeGreaterThan(0);
});

test("litmus: two ATOMIC RMW increments never lose an update (final c is always 2)", () => {
  const result = explore(twoIncrements(true), [summedToTwo]);
  expect(result.terminals).toBeGreaterThan(0);
  expect(result.violations).toEqual([]);
});

// ── reusable invariant helpers (used by the bug proofs) ─────────────────────

test("freshDelivery flags a torn read and clears a fresh one", () => {
  // Reuse the exported helper on the MP litmus (head>0 with no tail register).
  const inv = freshDelivery("C", "h", "tail", "s", MARKER);
  const unsafe = explore(messagePassing("plain", "acquire"), [inv]);
  expect(unsafe.violations.length).toBeGreaterThan(0);
  const safe = explore(messagePassing("release", "acquire"), [inv]);
  expect(safe.violations).toEqual([]);
  // Guard: a missing consumer name is simply ignored.
  expect(inv({ regs: {}, memory: new Map() })).toBeNull();
});

test("monotoneLocation witnesses a counter rewind and passes a monotone run", () => {
  // Two absolute writers of the same counter: one ordering rewinds 8 -> 6.
  const spec: ModelSpec = {
    locations: { tail: 5 },
    threads: [
      { name: "A", ops: [{ kind: "store", loc: "tail", value: () => 8, mode: "relaxed" }] },
      { name: "B", ops: [{ kind: "store", loc: "tail", value: () => 6, mode: "relaxed" }] },
    ],
  };
  const result = explore(spec, [monotoneLocation("tail")]);
  expect(result.violations.length).toBeGreaterThan(0);
  // Guard: a missing location is simply ignored.
  expect(monotoneLocation("nope")({ regs: {}, memory: new Map() })).toBeNull();
});

// ── engine mechanics (atomic RMW return value + runaway guard) ──────────────

test("rmw exposes the prior value and reads a preceding non-release store", () => {
  const spec: ModelSpec = {
    locations: { c: 0 },
    threads: [
      {
        name: "T",
        ops: [
          { kind: "store", loc: "c", value: () => 5, mode: "relaxed" },
          { kind: "rmw", loc: "c", update: (cur) => cur + 1, into: "old" },
        ],
      },
    ],
  };
  const seen: number[] = [];
  explore(spec, [
    (s: FinalState) => {
      seen.push(s.regs.T!.old!);
      return null;
    },
  ]);
  expect(seen).toEqual([5]); // fetch-add returned the prior value
});

test("explore throws rather than hanging when the state space is capped", () => {
  expect(() => explore(twoIncrements(false), [], { maxTerminals: 0 })).toThrow(/state space/);
});

// ── ring protocol proof: out-ring publish torn read (bug #1) ────────────────

test("out-ring publish: a header-touching bulk copy IS a torn read", () => {
  // The bulk copy writes `head` (plain) before the release store; the consumer
  // can acquire-load that plain head, gain no happens-before, and read a stale
  // slot. The model witnesses ≥1 such interleaving.
  const inv = freshDelivery("main", "h", "t", "s", RING_SLOT_MARKER);
  const result = explore(outRingPublishSpec({ touchesHeader: true }), [inv]);
  expect(result.terminals).toBeGreaterThan(0);
  expect(result.violations.length).toBeGreaterThan(0);
});

test("out-ring publish: a slots-only bulk copy is SAFE on every interleaving", () => {
  // With the header left untouched, the release store is the only `head` write,
  // so any consumer that observes the new head synchronizes-with it.
  const inv = freshDelivery("main", "h", "t", "s", RING_SLOT_MARKER);
  const result = explore(outRingPublishSpec({ touchesHeader: false }), [inv]);
  expect(result.terminals).toBeGreaterThan(0);
  expect(result.violations).toEqual([]);
});
