/**
 * Map a monotonically-increasing ring counter to a slot index in `[0, mod)`.
 *
 * The SAB ring head/tail counters live in `i32` header words, so once a counter
 * passes 2^31 it reads back NEGATIVE through a signed `Int32Array`. A bare
 * `counter % mod` then returns a negative index, sending the byte-offset
 * computation out of bounds (a `RangeError`, or a read/write into an adjacent
 * memory region). Reading the counter as unsigned first keeps the index correct
 * across the wrap and matches the WASM side, which uses `rem_u`.
 *
 * This is the single source of truth for ring indexing on the JS side — the
 * worklet SAB copy, the main-thread drain, and the offline renderer all route
 * through it so the 2^31 wrap is provably handled in exactly one place.
 */
export function ringSlotIndex(counter: number, mod: number): number {
  return (counter >>> 0) % mod;
}

/**
 * The number of un-drained slots in a ring (`head - tail`), computed unsigned so
 * it stays correct when only one of the two i32 counters has wrapped past 2^31.
 *
 * A bare signed `head - tail` reads roughly -2^32 in the window where `head` has
 * wrapped but `tail` has not, so a `head - tail >= capacity` full-check wrongly
 * reports "not full" and the producer silently overfills the ring (overwriting
 * un-drained slots without the drop-oldest accounting). `(head - tail) >>> 0`
 * recovers the true count — always in `[0, capacity]` for a monotone producer
 * where `head` leads `tail`.
 */
export function ringCount(head: number, tail: number): number {
  return (head - tail) >>> 0;
}

/**
 * Whether ring counter `a` is strictly ahead of `b` in serial-number order.
 *
 * Ring counters are monotone i32 words, so "ahead" cannot be a plain signed
 * `a > b`: in the window where one counter has wrapped past 2^31 and the other
 * has not, the signed comparison inverts and a legitimate lead reads as a lag
 * (rebasing a drain cursor onto a drop-oldest tail would then be skipped,
 * re-delivering overwritten slots). The distance between two live cursors is
 * bounded by the ring capacity — far below 2^31 — so the signed 32-bit
 * difference `(a - b) | 0` is positive exactly when `a` leads `b`, across the
 * wrap included (same argument as `atomicMonotoneMax`).
 */
export function ringLeads(a: number, b: number): boolean {
  return ((a - b) | 0) > 0;
}

/**
 * Atomically advance the i32 ring counter `view[index]` to `target` if `target`
 * is AHEAD of the current value, and return the resulting value. A behind-or-
 * equal target leaves the word unchanged (never a rewind).
 *
 * The in-ring `tail` has two writers — the main `send` drop-oldest and the
 * worklet drain-commit — and a plain `Atomics.store` from either can clobber the
 * other's advance (a lost update), rewinding `tail` so a slot is delivered
 * twice. Composing both writers through this monotone-max keeps `tail` moving
 * only forward. It is lock-free: both writers only ever increase the word, so a
 * displaced compare-exchange retries against a strictly newer value and the loop
 * converges.
 *
 * "Ahead" is wrap-safe. A single advance is bounded (at most the ring capacity),
 * so the signed 32-bit difference `(target - cur) | 0` is positive exactly when
 * `target` leads `cur` — even across the 2^31 counter wrap, where `target` reads
 * back negative through the `Int32Array`. A signed `target > cur` would instead
 * reject the legitimate advance at the wrap and latch the ring (see `ringCount`).
 */
/**
 * Producer-side drop-oldest on a full ring: free exactly one slot by advancing
 * `tail`, and report whether THIS producer is the one that freed it.
 *
 * The return value is what the overflow counter must be gated on. `tail` has a
 * second writer — the consumer's drain-commit — so between reading the
 * occupancy and writing the tail, the consumer can drain the ring. Advancing
 * through a monotone-max there correctly declines the stale proposal, but the
 * producer cannot tell "declined because the consumer already freed room" from
 * "advanced, a slot was overwritten" — counting both as overflow reports losses
 * that never happened, and overflow counts are what a user sizes a ring by.
 * The compare-exchange answers it: winning from the observed `tail` means this
 * producer dropped the slot; losing means the consumer moved, so occupancy is
 * re-evaluated against its value, which may leave no slot to drop at all.
 *
 * Terminating: a losing exchange returns a strictly-leading `tail` (both writers
 * only ever advance it), so each retry strictly lowers the occupancy against the
 * fixed `head` and the loop ends by winning or by finding room. Main-thread
 * only — the audio thread's producers are the WASM ring writers.
 */
export function dropOldestIfFull(
  view: Int32Array,
  tailIndex: number,
  head: number,
  capacity: number,
): boolean {
  let tail = Atomics.load(view, tailIndex);
  while (ringCount(head, tail) >= capacity) {
    const prev = Atomics.compareExchange(view, tailIndex, tail, (tail + 1) | 0);
    if (prev === tail) return true;
    tail = prev;
  }
  return false;
}

export function atomicMonotoneMax(view: Int32Array, index: number, target: number): number {
  let cur = Atomics.load(view, index);
  while (((target - cur) | 0) > 0) {
    const prev = Atomics.compareExchange(view, index, cur, target);
    if (prev === cur) return target;
    cur = prev;
  }
  return cur;
}
