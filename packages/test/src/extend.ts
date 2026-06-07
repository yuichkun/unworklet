/**
 * `@unworklet/test/extend` — a side-effect import that registers all 20 chain-form
 * matchers with vitest's `expect.extend(...)` and declares a merge into vitest's
 * `Assertion` interface (`docs/06-testing.md` §6).
 *
 * Usage (a single line at the top of a test file):
 *
 * ```ts
 * import "@unworklet/test/extend";
 *
 * expect(result).toMatchAudio(expected);
 * expect(result).toBeStable();
 * expect(result).toHavePeakUnder(-6);
 * ```
 *
 * Coexists with the plain functions (§2). The chain names are not mechanically
 * derived 1:1 from the plain names; they are mapped onto vitest's conventions
 * (toBe / toHave / toMatch / toContain) and named naturally one by one
 * (`docs/06-testing.md` §6.1-6.2).
 *
 * Implementation: wrap each plain function in try / catch and convert it into
 * vitest's matcher return shape (`{ pass, message }`), mapping a throw inside the
 * plain function to a chain-test failure.
 */

import type { RenderOfflineResult } from "@unworklet/offline";
import { expect } from "vitest";

import type {
  AudioMatchOptions,
  ExpectedEvent,
  ExpectedMidiEvent,
  GainAtFreqOptions,
  MasterOptions,
  PartialExpectedEvent,
  PeakAtSampleOptions,
  SnapshotOptions,
  SnapshotResolutionState,
} from "./index.ts";
import {
  expectAudioMatches,
  expectAudioMatchesGolden,
  expectAudioMatchesSnapshotWithState,
  expectDcOffsetUnder,
  expectEventCount,
  expectEventsContaining,
  expectEventsEqual,
  expectGainAtFreq,
  expectLatency,
  expectMaster,
  expectMidiBalance,
  expectMidiOut,
  expectNoNaN,
  expectPeakAtSample,
  expectPeakUnder,
  expectRmsUnder,
  expectSilence,
  expectStable,
  expectStateMatches,
} from "./index.ts";

/**
 * A TS-only guard that exposes the chain methods only when the `value` type in
 * `expect(value)` is `RenderOfflineResult`. Calls like
 * `expect(1).toMatchAudio(...)` resolve to `never` and become a build error
 * (no runtime cost).
 */
type WhenResult<T, M> = T extends RenderOfflineResult ? M : never;

/**
 * A widened guard specific to `toMatchAudioSnapshot`. Mirroring the plain
 * `expectAudioMatchesSnapshot`, which accepts `actual` in all three shapes
 * (`RenderOfflineResult | Float32Array | Float32Array[]`), the chain form also
 * accepts `expect(sine(...)).toMatchAudioSnapshot()` (a `Float32Array`
 * directly) and `expect([ch0, ch1]).toMatchAudioSnapshot()` (a `Float32Array[]`
 * multi-channel value). Non-audio actuals (`number`, `string`, etc.) resolve to
 * `never` and become a build error, just as with `WhenResult`.
 */
type WhenAudioActual<T, M> = T extends RenderOfflineResult | Float32Array | Float32Array[]
  ? M
  : never;

/**
 * The chain matchers `@unworklet/test/extend` adds to `expect(...)`. Declared
 * once here and merged into the assertion type by the augmentation below. The
 * shipped augmentation target is `vitest` — the module a stock-vitest consumer's
 * `expect` resolves to. (This repo's own runner is the vite-plus-test fork,
 * where `expect` comes through `vite-plus/test`; `fork-assertion.d.ts` bridges
 * these same matchers onto that module for in-repo type-checking only, and is
 * never shipped.)
 */
export interface UnworkletAudioMatchers<T> {
  toMatchAudio: WhenResult<
    T,
    (expected: RenderOfflineResult | Float32Array[], opts?: AudioMatchOptions) => void
  >;
  toMatchAudioFile: WhenResult<T, (wavPath: string, opts?: AudioMatchOptions) => void>;
  toMatchAudioSnapshot: WhenAudioActual<T, (opts?: SnapshotOptions) => Promise<void>>;
  toBeFinite: WhenResult<T, () => void>;
  toHavePeakUnder: WhenResult<T, (dbfs: number) => void>;
  toHaveRmsUnder: WhenResult<T, (dbfs: number) => void>;
  toBeStable: WhenResult<T, () => void>;
  toBeMasterReady: WhenResult<T, (opts?: MasterOptions) => void>;
  toBeSilent: WhenResult<T, (opts?: { tolerance?: number }) => void>;
  toHavePeakAtSample: WhenResult<T, (expectedAtSample: number, opts?: PeakAtSampleOptions) => void>;
  toHaveGainAtFreq: WhenResult<
    T,
    (freqHz: number, expectedDb: number, tolerance: number, opts?: GainAtFreqOptions) => void
  >;
  toHaveLatency: WhenResult<
    T,
    (expectedSamples: number, opts?: { tolerance?: number; channel?: number }) => void
  >;
  toHaveDcOffsetUnder: WhenResult<T, (threshold: number) => void>;
  toMatchEvents: WhenResult<T, (expectedEvents: ExpectedEvent[]) => void>;
  toHaveEventCount: WhenResult<T, (name: string, expectedCount: number) => void>;
  toContainEvents: WhenResult<T, (partial: PartialExpectedEvent[]) => void>;
  toEmitMidi: WhenResult<
    T,
    (
      portName: string,
      expectedMidiEvents: ExpectedMidiEvent[],
      opts?: { tolerance?: number },
    ) => void
  >;
  toHaveBalancedMidi: WhenResult<T, (portName: string, opts?: { hangingNotes?: number }) => void>;
  toMatchState: WhenResult<T, (expectedSnapshot: Uint8Array) => void>;
}

declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- match vitest's own `Assertion<T = any>` signature so the declarations merge.
  interface Assertion<T = any> extends UnworkletAudioMatchers<T> {}
}

type MatcherResult = { pass: boolean; message: () => string };

const wrap =
  <Args extends unknown[]>(
    chainName: string,
    fn: (received: RenderOfflineResult, ...args: Args) => void,
  ) =>
  (received: unknown, ...args: Args): MatcherResult => {
    try {
      fn(received as RenderOfflineResult, ...args);
      return { pass: true, message: () => `expected NOT to satisfy ${chainName}` };
    } catch (err) {
      return {
        pass: false,
        message: () => (err instanceof Error ? err.message : String(err)),
      };
    }
  };

/**
 * The chain matcher specific to `toMatchAudioSnapshot`. Inside vitest's
 * `expect.extend(...)`, `this` carries a per-test bound `MatcherState` (whose
 * `this.testPath` / `this.currentTestName` / `this.snapshotState` belong to the
 * current test). The plain form's path through the global `expect.getState()`
 * has a race under `test.concurrent` where it reads another test's state, but
 * the chain form avoids that race by going through the bound `this`, making it
 * concurrent-safe.
 *
 * Written as `function () {}` (not an arrow) so it receives the `this` binding;
 * `wrapAsync`'s generic wrapper calls the plain function via the global state
 * path and so cannot be used here. To fit vitest's `RawMatcherFn` shape, `this`
 * is left undeclared and cast internally.
 */
async function toMatchAudioSnapshotChain(
  this: unknown,
  received: unknown,
  opts?: SnapshotOptions,
): Promise<MatcherResult> {
  try {
    // Attach a counter Map onto `this` (the per-test-invocation `MatcherState`)
    // and carry it. A fresh Map per chain-form call (per test invocation) means
    // no counter drift across retries or watch reruns (the R6-1 fix). On the
    // plain-form path this field is absent from the state, so it falls back to a
    // module-global Map (the same sequential-only limitation as standard vitest).
    const thisHost = this as { _unworkletCounters?: Map<string, number> };
    if (!thisHost._unworkletCounters) {
      thisHost._unworkletCounters = new Map();
    }
    const state: SnapshotResolutionState = {
      ...(this as SnapshotResolutionState),
      _unworkletCounters: thisHost._unworkletCounters,
    };
    await expectAudioMatchesSnapshotWithState(
      received as RenderOfflineResult | Float32Array | Float32Array[],
      opts ?? {},
      state,
    );
    return { pass: true, message: () => `expected NOT to satisfy toMatchAudioSnapshot` };
  } catch (err) {
    return {
      pass: false,
      message: () => (err instanceof Error ? err.message : String(err)),
    };
  }
}

expect.extend({
  toMatchAudio: wrap("toMatchAudio", expectAudioMatches),
  toMatchAudioFile: wrap("toMatchAudioFile", expectAudioMatchesGolden),
  toMatchAudioSnapshot: toMatchAudioSnapshotChain,
  toBeFinite: wrap("toBeFinite", expectNoNaN),
  toHavePeakUnder: wrap("toHavePeakUnder", expectPeakUnder),
  toHaveRmsUnder: wrap("toHaveRmsUnder", expectRmsUnder),
  toBeStable: wrap("toBeStable", expectStable),
  toBeMasterReady: wrap("toBeMasterReady", expectMaster),
  toBeSilent: wrap("toBeSilent", expectSilence),
  toHavePeakAtSample: wrap("toHavePeakAtSample", expectPeakAtSample),
  toHaveGainAtFreq: wrap("toHaveGainAtFreq", expectGainAtFreq),
  toHaveLatency: wrap("toHaveLatency", expectLatency),
  toHaveDcOffsetUnder: wrap("toHaveDcOffsetUnder", expectDcOffsetUnder),
  toMatchEvents: wrap("toMatchEvents", expectEventsEqual),
  toHaveEventCount: wrap("toHaveEventCount", expectEventCount),
  toContainEvents: wrap("toContainEvents", expectEventsContaining),
  toEmitMidi: wrap("toEmitMidi", expectMidiOut),
  toHaveBalancedMidi: wrap("toHaveBalancedMidi", expectMidiBalance),
  toMatchState: wrap("toMatchState", expectStateMatches),
});
