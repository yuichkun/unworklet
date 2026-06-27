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
