/**
 * Build-time constants exported from `@unworklet/core`.
 *
 * - `SAMPLES_PER_BLOCK` — render quantum length fixed by the Web Audio spec.
 *   See `01-dsl.md` §1.7 and `decisions-log.md` Q35.
 * - `CAPACITY_*` — power-of-two ringbuffer capacity tokens for
 *   `event<T>` / `message<T>` / `midiInput` / `midiOutput`.
 *   See `02-messaging.md` §3 and `decisions-log.md` Q44.
 */

export const SAMPLES_PER_BLOCK = 128 as const;

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
