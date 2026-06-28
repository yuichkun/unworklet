/**
 * Layer F — runtime self-check primitives for the audio thread.
 *
 * A debug build calls these once per quantum to assert the SAB ring headers are
 * sane; production gates every call behind the `__UNWORKLET_SELFCHECK__` define,
 * which is `false` in a build and DCE'd away (production stays byte-identical).
 * The point is to turn every existing node + browser test, and every real run of
 * a debug build, into a continuous invariant monitor — a flight-computer-style
 * built-in test that surfaces ring corruption the instant it happens instead of
 * as a downstream glitch.
 *
 * These are PURE (no realm-forbidden globals — `Int32Array` reads + arithmetic
 * only) so they are unit-testable and safe inside `AudioWorkletGlobalScope`.
 */

import { ringCount } from "./ringIndex.ts";

/**
 * Check a SAB ring header `[head, tail, overflow]` against its invariants.
 * Returns a violation message, or `null` if sane.
 *
 * The fill `(head - tail)` computed UNSIGNED must stay in `[0, capacity]`:
 *   - `> capacity` means a producer overran un-drained slots (an overfill), OR
 *   - `tail > head` (a rewind — the split-writer lost update) shows up as a huge
 *     unsigned difference, far above `capacity`.
 * Either is ring corruption that would deliver a torn or duplicated slot.
 */
export function checkRingHeader(
  head: number,
  tail: number,
  overflow: number,
  capacity: number,
): string | null {
  if (capacity <= 0) return `ring capacity must be positive, got ${capacity}`;
  const fill = ringCount(head, tail);
  if (fill > capacity) {
    return `ring header corrupt: head=${head} tail=${tail} → fill ${fill} exceeds capacity ${capacity}`;
  }
  if (overflow < 0) return `ring overflow counter is negative: ${overflow}`;
  return null;
}
