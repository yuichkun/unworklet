/**
 * `@unworklet/test` — Vitest matchers for `@unworklet/core` processors
 * (`06-testing.md` §2).
 *
 * Wraps `@unworklet/offline`'s `renderOffline` with audio-domain
 * assertions. Stub stage: matcher functions are declared with their
 * signatures; runtime behavior is impl-phase fill.
 */

import type { RenderOfflineResult } from "@unworklet/offline";

const notImplemented = (): never => {
  throw new Error("not implemented");
};

export type AudioMatchOptions = {
  /**
   * Sample-absolute-difference tolerance. Default `0` = bit-exact
   * (= `renderOffline` instantiates the same WASM binary every run,
   * so identical inputs yield identical PCM by construction; see
   * `13-offline-render.md` §3).
   */
  tolerance?: number;
};

/**
 * Assert that `actual.outputs` matches `expected` channel-by-channel
 * within `opts.tolerance` (default `0`). `expected` accepts either a
 * full `RenderOfflineResult` or just the `outputs` record.
 */
export function expectAudioMatches(
  _actual: RenderOfflineResult,
  _expected: RenderOfflineResult | Record<string, Float32Array[]>,
  _opts?: AudioMatchOptions,
): void {
  notImplemented();
}

/** Assert that `result.outputs` contains no NaN / ±Infinity samples. */
export function expectNoNaN(_result: RenderOfflineResult): void {
  notImplemented();
}

/** Assert peak amplitude below the given dBFS threshold. */
export function expectPeakUnder(_result: RenderOfflineResult, _dbfs: number): void {
  notImplemented();
}

/** Assert RMS amplitude below the given dBFS threshold. */
export function expectRmsUnder(_result: RenderOfflineResult, _dbfs: number): void {
  notImplemented();
}

/** Single event entry expected by `expectEventsEqual`. */
export type ExpectedEvent = {
  name: string;
  payload: unknown;
  atSample: number;
};

/** Assert that emitted events (name + payload + atSample) match the expected sequence. */
export function expectEventsEqual(
  _result: RenderOfflineResult,
  _expectedEvents: ExpectedEvent[],
): void {
  notImplemented();
}

/**
 * Assert that the end-of-render snapshot blob matches `expectedSnapshot`
 * (= `'persistent'` slot 限 定、 Q5 format). Transient slots round-trip
 * through `expectAudioMatches` instead.
 */
export function expectStateMatches(
  _result: RenderOfflineResult,
  _expectedSnapshot: Uint8Array,
): void {
  notImplemented();
}
