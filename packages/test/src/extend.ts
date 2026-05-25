/**
 * `@unworklet/test/extend` — side-effect import で chain form 全 20 件 を vitest
 * `expect.extend(...)` に 登 録 + `vitest` `Assertion` interface declare merge
 * (`docs/06-testing.md` §6)。
 *
 * 使 い 方 (= test ファ イ ル 上 部 1 行):
 *
 * ```ts
 * import "@unworklet/test/extend";
 *
 * expect(result).toMatchAudio(expected);
 * expect(result).toBeStable();
 * expect(result).toHavePeakUnder(-6);
 * ```
 *
 * plain 関 数 (= §2) と co-exist、 chain 名 は plain ↔ chain 1:1 機 械 派 生
 * で は な く vitest 慣 例 (= toBe / toHave / toMatch / toContain) に zip し て
 * 個 別 自 然 化 (`docs/06-testing.md` §6.1-6.2)。
 *
 * 実 装 = plain 関 数 を try / catch で wrap + vitest matcher 返 し 形
 * (= `{ pass, message }`) に 変 換 + plain 内 throw を chain test fail に zip。
 */

import type { RenderOfflineResult } from "@unworklet/offline";
import { expect } from "vite-plus/test";

import type {
  AudioMatchOptions,
  ExpectedEvent,
  ExpectedMidiEvent,
  MasterOptions,
  PartialExpectedEvent,
  PeakAtSampleOptions,
  SnapshotOptions,
} from "./index.ts";
import {
  expectAudioMatches,
  expectAudioMatchesGolden,
  expectAudioMatchesSnapshot,
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
  expectStateValue,
} from "./index.ts";

/**
 * chain method を `expect(value)` の `value` 型 が `RenderOfflineResult`
 * の 時 だ け 露 出 さ せ る TS-only guard。 `expect(1).toMatchAudio(...)`
 * 等 は `never` に 解 け て build エ ラ ー (= runtime cost 不 在)。
 */
type WhenResult<T, M> = T extends RenderOfflineResult ? M : never;

declare module "vite-plus/test" {
  // biome-ignore lint/suspicious/noExplicitAny: vitest 標 準 `Assertion<T = any>` (= `node_modules/@vitest/expect/dist/index.d.ts`) と type parameter 揃 え 必 須、 declare merge で T が unused で も 形 を 合 わ せ る。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Assertion<T = any> {
    toMatchAudio: WhenResult<
      T,
      (expected: RenderOfflineResult | Float32Array[], opts?: AudioMatchOptions) => void
    >;
    toMatchAudioFile: WhenResult<T, (wavPath: string, opts?: AudioMatchOptions) => void>;
    toMatchAudioSnapshot: WhenResult<T, (opts?: SnapshotOptions) => Promise<void>>;
    toBeFinite: WhenResult<T, () => void>;
    toHavePeakUnder: WhenResult<T, (dbfs: number) => void>;
    toHaveRmsUnder: WhenResult<T, (dbfs: number) => void>;
    toBeStable: WhenResult<T, () => void>;
    toBeMasterReady: WhenResult<T, (opts?: MasterOptions) => void>;
    toBeSilent: WhenResult<T, (opts?: { tolerance?: number }) => void>;
    toHavePeakAtSample: WhenResult<
      T,
      (expectedAtSample: number, opts?: PeakAtSampleOptions) => void
    >;
    toHaveGainAtFreq: WhenResult<
      T,
      (freqHz: number, expectedDb: number, tolerance: number) => void
    >;
    toHaveLatency: WhenResult<T, (expectedSamples: number, opts?: { tolerance?: number }) => void>;
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
    toHaveStateValue: WhenResult<T, (slotName: string, expectedValue: number | boolean) => void>;
  }
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

const wrapAsync =
  <Args extends unknown[]>(
    chainName: string,
    fn: (received: RenderOfflineResult, ...args: Args) => Promise<void>,
  ) =>
  async (received: unknown, ...args: Args): Promise<MatcherResult> => {
    try {
      await fn(received as RenderOfflineResult, ...args);
      return { pass: true, message: () => `expected NOT to satisfy ${chainName}` };
    } catch (err) {
      return {
        pass: false,
        message: () => (err instanceof Error ? err.message : String(err)),
      };
    }
  };

expect.extend({
  toMatchAudio: wrap("toMatchAudio", expectAudioMatches),
  toMatchAudioFile: wrap("toMatchAudioFile", expectAudioMatchesGolden),
  toMatchAudioSnapshot: wrapAsync("toMatchAudioSnapshot", expectAudioMatchesSnapshot),
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
  toHaveStateValue: wrap("toHaveStateValue", expectStateValue),
});
