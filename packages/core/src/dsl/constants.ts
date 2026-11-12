/**
 * Build-time constants.
 *
 * - `CAPACITY_*` (exported from `@unworklet/core`) — power-of-two ringbuffer
 *   capacity tokens for `event<T>` / `message<T>` / `midiInput` / `midiOutput`.
 *   See `02-messaging.md` §3 and `decisions-log.md` Q44.
 * - The rest are internal.
 */

/**
 * Render quantum a compile targets when none is given — the Web Audio default.
 * Internal: an AudioContext may render in any quantum (`renderSizeHint`), so the
 * quantum is part of each compile target (`ctx.renderQuantumSize`), not a
 * library-wide constant.
 */
export const DEFAULT_RENDER_QUANTUM_SIZE = 128;

/**
 * Elements one `f32x4` lane window covers — the span a `loadVec` / `storeVec`
 * touches from its offset. Internal (not re-exported from the package index):
 * it is the shared definition behind the SIMD buffer-size rule in the buffer
 * factories and its analyzer backstop.
 */
export const SIMD_LANE_COUNT = 4 as const;

/**
 * Largest `forIndex` count: the loop counter is an i32 that must reach `count`.
 * Internal (not re-exported): the shared bound behind `illegal-forindex-count`.
 */
export const FOR_INDEX_MAX_COUNT = 2 ** 31 - 1;

export const CAPACITY_16 = 16 as const;
export const CAPACITY_32 = 32 as const;
export const CAPACITY_64 = 64 as const;
export const CAPACITY_128 = 128 as const;
export const CAPACITY_256 = 256 as const;
export const CAPACITY_512 = 512 as const;
export const CAPACITY_1024 = 1024 as const;
export const CAPACITY_2048 = 2048 as const;
export const CAPACITY_4096 = 4096 as const;
export const CAPACITY_8192 = 8192 as const;
export const CAPACITY_16384 = 16384 as const;
