/**
 * A small, auditable **relaxed-memory operational model** of the `SharedArrayBuffer`
 * ring transport (`worklet.ts` ↔ `client.ts`).
 *
 * Why this exists: the SAB ring is concurrent. A race surfaces once in a million
 * runs, by the luck of timing — a passing browser run proves nothing about the
 * next interleaving. Code coverage cannot see "did the bad interleaving happen?".
 * The only honest answer is to **enumerate every interleaving and prove the bad
 * one is absent** (or witness it, for a buggy protocol). This file is that
 * enumerator.
 *
 * ## The modeled fragment (and its honest limits)
 *
 * This models the C/JS release-acquire fragment that the ring protocol actually
 * uses, and nothing more:
 *
 *   - `store` with mode `release` (a JS `Atomics.store`) / `plain` / `relaxed`
 *     (a non-atomic `TypedArray` write, e.g. the bulk `.set()` copy).
 *   - `load` with mode `acquire` (a JS `Atomics.load`) / `plain` / `relaxed`.
 *   - `rmw` — an atomic read-modify-write (`Atomics.add` / `Atomics.compareExchange`),
 *     modeled as a single indivisible step (this is exactly the property a CAS
 *     loop buys: no lost update).
 *
 * Memory is **multi-copy-atomic** (a store becomes visible to all threads at
 * once); the model does NOT capture store-buffering / IRIW / fence reasoning —
 * the ring protocol contains no such patterns (it is pure message-passing over
 * release/acquire plus atomic RMW counters), so that fragment is unnecessary
 * here. The model's soundness on the fragment it DOES claim is validated against
 * textbook litmus tests in `ring-model.test.ts` (a checker that mis-classifies a
 * known litmus outcome cannot be trusted — so we prove it does not).
 *
 * ## Semantics in one paragraph
 *
 * Each thread carries a `known` set of store ids it *happens-after*. A thread
 * happens-after its own writes; an **acquire** load that reads-from a **release**
 * store absorbs that store's published `known` snapshot (synchronizes-with). A
 * load of location X may read any store to X in the coherence (= execution)
 * order from `lo` up to the latest, where `lo` is pinned by (a) coherence with
 * this thread's prior accesses to X and (b) any store to X this thread already
 * happens-after. Reading "stale" within that window is the relaxed effect;
 * reading older than `lo` is forbidden (coherence). A torn read is a delivery
 * that read a slot the thread does not happens-after — i.e. an unsynchronized
 * read — which this enumerator finds by trying every reads-from choice.
 */

export type StoreMode = "plain" | "relaxed" | "release";
export type LoadMode = "plain" | "relaxed" | "acquire";

/** A single write event in a location's coherence (= execution) order. */
export interface StoreEvent {
  readonly id: number;
  readonly loc: string;
  readonly value: number;
  /** A release store (or an atomic RMW) publishes the writer's `known` set. */
  readonly isRelease: boolean;
  /** The writer's `known` snapshot at store time — absorbed by an acquire reader. */
  readonly published: ReadonlySet<number>;
}

/** A thread's local registers (named scalar locals). */
export type Regs = Record<string, number>;

export type Op =
  | {
      readonly kind: "store";
      readonly loc: string;
      readonly value: (r: Regs) => number;
      readonly mode: StoreMode;
    }
  | { readonly kind: "load"; readonly loc: string; readonly into: string; readonly mode: LoadMode }
  | {
      readonly kind: "rmw";
      readonly loc: string;
      readonly update: (cur: number, r: Regs) => number;
      readonly into?: string;
    };

export interface ThreadSpec {
  readonly name: string;
  readonly ops: readonly Op[];
}

export interface ModelSpec {
  /** Initial value of every shared location. */
  readonly locations: Readonly<Record<string, number>>;
  readonly threads: readonly ThreadSpec[];
}

export interface FinalState {
  /** Final registers, keyed by thread name. */
  readonly regs: Readonly<Record<string, Regs>>;
  /** The coherence-ordered store list per location (index = coherence index). */
  readonly memory: ReadonlyMap<string, readonly StoreEvent[]>;
}

/** Returns a violation message, or `null` if the final state is safe. */
export type Invariant = (s: FinalState) => string | null;

export interface Violation {
  readonly message: string;
  readonly regs: Record<string, Regs>;
}

export interface ExploreResult {
  /** Number of complete interleavings × reads-from choices explored. */
  readonly terminals: number;
  readonly violations: readonly Violation[];
}

// ── internal mutable exploration state ──────────────────────────────────────

interface IThread {
  pc: number;
  regs: Regs;
  /** Highest coherence index this thread has accessed, per location. */
  seenCo: Record<string, number>;
  /** Store ids this thread happens-after. */
  known: Set<number>;
}

interface IState {
  threads: IThread[];
  memory: Map<string, StoreEvent[]>;
  nextId: number;
}

const cloneState = (s: IState): IState => ({
  threads: s.threads.map((t) => ({
    pc: t.pc,
    regs: { ...t.regs },
    seenCo: { ...t.seenCo },
    known: new Set(t.known),
  })),
  memory: new Map([...s.memory].map(([k, v]) => [k, [...v]])),
  nextId: s.nextId,
});

/** Lower bound (coherence index) a load of `loc` by thread `t` may read from. */
const readFloor = (t: IThread, loc: string, arr: readonly StoreEvent[]): number => {
  // `seenCo` is seeded for every declared location, and a load only ever targets
  // a declared location, so this is always present.
  let lo = t.seenCo[loc]!;
  for (let j = lo + 1; j < arr.length; j++) {
    // A store this thread already happens-after pins coherence forward.
    if (t.known.has(arr[j]!.id)) lo = j;
  }
  return lo;
};

/** Expand one operation of thread `ti` into all of its possible next states. */
const stepOptions = (s: IState, ti: number, op: Op): IState[] => {
  if (op.kind === "store") {
    const ns = cloneState(s);
    const t = ns.threads[ti]!;
    const v = op.value(t.regs);
    const id = ns.nextId++;
    t.known.add(id);
    const isRelease = op.mode === "release";
    const ev: StoreEvent = {
      id,
      loc: op.loc,
      value: v,
      isRelease,
      published: isRelease ? new Set(t.known) : new Set<number>(),
    };
    const arr = ns.memory.get(op.loc)!;
    arr.push(ev);
    t.seenCo[op.loc] = arr.length - 1;
    t.pc++;
    return [ns];
  }

  if (op.kind === "load") {
    const arr = s.memory.get(op.loc)!;
    const floor = readFloor(s.threads[ti]!, op.loc, arr);
    const options: IState[] = [];
    for (let j = floor; j < arr.length; j++) {
      const ns = cloneState(s);
      const t = ns.threads[ti]!;
      const chosen = arr[j]!;
      t.regs[op.into] = chosen.value;
      t.seenCo[op.loc] = j;
      if (op.mode === "acquire" && chosen.isRelease) {
        for (const id of chosen.published) t.known.add(id);
      }
      t.pc++;
      options.push(ns);
    }
    return options;
  }

  // rmw — atomic read-modify-write: one indivisible step (no lost update).
  const ns = cloneState(s);
  const t = ns.threads[ti]!;
  const arr = ns.memory.get(op.loc)!;
  const last = arr[arr.length - 1]!;
  // Atomic read of the latest value, with acquire on it.
  t.seenCo[op.loc] = arr.length - 1;
  if (last.isRelease) for (const id of last.published) t.known.add(id);
  const cur = last.value;
  if (op.into !== undefined) t.regs[op.into] = cur;
  const newVal = op.update(cur, t.regs);
  const id = ns.nextId++;
  t.known.add(id);
  arr.push({ id, loc: op.loc, value: newVal, isRelease: true, published: new Set(t.known) });
  t.seenCo[op.loc] = arr.length - 1;
  t.pc++;
  return [ns];
};

const toFinal = (s: IState, spec: ModelSpec): FinalState => {
  const regs: Record<string, Regs> = {};
  s.threads.forEach((t, i) => {
    regs[spec.threads[i]!.name] = { ...t.regs };
  });
  return { regs, memory: s.memory };
};

/**
 * Exhaustively enumerate every interleaving × reads-from choice of `spec`, and
 * collect every `invariants` violation witnessed at a terminal state.
 *
 * `maxTerminals` is a runaway guard (the protocols here explore a few thousand
 * states); exceeding it throws rather than hanging.
 */
export function explore(
  spec: ModelSpec,
  invariants: readonly Invariant[],
  opts?: { readonly maxTerminals?: number },
): ExploreResult {
  const maxTerminals = opts?.maxTerminals ?? 500_000;

  const memory = new Map<string, StoreEvent[]>();
  let nextId = 0;
  const initialIds: number[] = [];
  for (const [loc, val] of Object.entries(spec.locations)) {
    const ev: StoreEvent = { id: nextId++, loc, value: val, isRelease: true, published: new Set() };
    memory.set(loc, [ev]);
    initialIds.push(ev.id);
  }
  const seen0 = Object.fromEntries(Object.keys(spec.locations).map((l) => [l, 0]));
  const threads: IThread[] = spec.threads.map(() => ({
    pc: 0,
    regs: {},
    seenCo: { ...seen0 },
    known: new Set(initialIds),
  }));

  const violations: Violation[] = [];
  let terminals = 0;

  const atEnd = (s: IState): boolean =>
    s.threads.every((t, i) => t.pc >= spec.threads[i]!.ops.length);

  const recurse = (s: IState): void => {
    if (atEnd(s)) {
      terminals++;
      if (terminals > maxTerminals) {
        throw new Error(`ring-model: state space exceeded ${maxTerminals} terminals`);
      }
      const fs = toFinal(s, spec);
      for (const inv of invariants) {
        const msg = inv(fs);
        if (msg !== null) violations.push({ message: msg, regs: fs.regs as Record<string, Regs> });
      }
      return;
    }
    for (let ti = 0; ti < s.threads.length; ti++) {
      const t = s.threads[ti]!;
      if (t.pc >= spec.threads[ti]!.ops.length) continue;
      const op = spec.threads[ti]!.ops[t.pc]!;
      for (const next of stepOptions(s, ti, op)) recurse(next);
    }
  };

  recurse({ threads, memory, nextId });
  return { terminals, violations };
}

// ── reusable invariants ─────────────────────────────────────────────────────

/**
 * The values stored to `loc`, in coherence order, must be non-decreasing — i.e.
 * the counter never rewinds. A rewind means a lost update (a split-writer race),
 * which re-delivers or skips a slot.
 */
export const monotoneLocation =
  (loc: string, label?: string): Invariant =>
  (s) => {
    const arr = s.memory.get(loc);
    if (arr === undefined) return null;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i]!.value < arr[i - 1]!.value) {
        return `${label ?? loc} rewound: ${arr[i - 1]!.value} -> ${arr[i]!.value}`;
      }
    }
    return null;
  };

/**
 * Message-passing freshness: if the consumer observed a non-empty window
 * (`head > tail` via its registers) it must have read the producer's fresh slot
 * marker, never a stale/empty value. A failure is a torn read.
 */
export const freshDelivery =
  (
    consumer: string,
    headReg: string,
    tailReg: string,
    slotReg: string,
    marker: number,
  ): Invariant =>
  (s) => {
    const r = s.regs[consumer];
    if (r === undefined) return null;
    if ((r[headReg] ?? 0) > (r[tailReg] ?? 0) && r[slotReg] !== marker) {
      return `torn read: ${consumer} saw head=${r[headReg]} tail=${r[tailReg]} but slot=${r[slotReg]} (expected ${marker})`;
    }
    return null;
  };

// ── the real ring transport protocol (worklet.ts ↔ client.ts) ───────────────

/** A non-zero value the producer writes into a slot; 0 is the empty/stale slot. */
export const RING_SLOT_MARKER = 1;

/** A header word index in the 12-byte `[head, tail, overflow]` SAB ring header. */
export type HeaderWord = "head" | "tail" | "overflow";

/**
 * One operation of the ring transport, in the vocabulary the conformance test
 * captures from the REAL `worklet.ts` (via spies on `Atomics` + `.set()`). The
 * model translates this same sequence into relaxed-memory ops; binding the two
 * to one descriptor is what stops the model drifting into a false green.
 */
export type AbstractRingOp =
  | { readonly op: "bulk-copy"; readonly touchesHeader: boolean }
  | { readonly op: "atomic-store"; readonly word: HeaderWord };

/**
 * The op-sequence the **fixed** out-ring publish must emit: a slot-region-only
 * bulk copy (never the header), then the three release stores with `head` last.
 * `ring-protocol.conformance.test.ts` deep-equals the real worklet's captured
 * sequence to this.
 */
export const OUT_RING_PUBLISH_OPS: readonly AbstractRingOp[] = [
  { op: "bulk-copy", touchesHeader: false },
  { op: "atomic-store", word: "tail" },
  { op: "atomic-store", word: "overflow" },
  { op: "atomic-store", word: "head" },
];

/**
 * Model of the **out-ring publish** (worklet → main), e.g. an event/MIDI-out
 * ring. The worklet copies its WASM ring into the SAB and then release-stores
 * tail, overflow, head (head last, the release point). The consumer (main rAF
 * poll, `client.ts` `pollEventRings`) acquire-loads head and tail, then
 * plain-reads the slot.
 *
 * `touchesHeader: true` reproduces the bug — the bulk `.set()` spans the whole
 * ring including the 12-byte header, so it writes `head` with a plain store
 * BEFORE the release store. A consumer's acquire-load of head can read-from that
 * plain write (its value coincides with the release store's), gaining no
 * happens-before, and then read a stale slot. `touchesHeader: false` (slot
 * region only) leaves the release store as the sole `head` write.
 */
export const outRingPublishSpec = (opts: { readonly touchesHeader: boolean }): ModelSpec => {
  const m = RING_SLOT_MARKER;
  const worklet: Op[] = [];
  if (opts.touchesHeader) {
    // The bulk `.set()` copies the header words (plain) before the slot region.
    worklet.push({ kind: "store", loc: "head", value: () => 1, mode: "plain" });
    worklet.push({ kind: "store", loc: "tail", value: () => 0, mode: "plain" });
  }
  worklet.push({ kind: "store", loc: "slot", value: () => m, mode: "plain" }); // .set() slot region
  worklet.push({ kind: "store", loc: "tail", value: () => 0, mode: "release" }); // Atomics.store(tail)
  worklet.push({ kind: "store", loc: "head", value: () => 1, mode: "release" }); // Atomics.store(head) — last
  return {
    locations: { head: 0, tail: 0, slot: 0 },
    threads: [
      { name: "worklet", ops: worklet },
      {
        name: "main",
        ops: [
          { kind: "load", loc: "head", into: "h", mode: "acquire" },
          { kind: "load", loc: "tail", into: "t", mode: "acquire" },
          { kind: "load", loc: "slot", into: "s", mode: "plain" },
        ],
      },
    ],
  };
};
