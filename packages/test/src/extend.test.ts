/**
 * `@unworklet/test/extend` chain form 経 路 test (= `docs/06-testing.md` §6)。
 * side-effect import で `expect.extend(...)` を 走 ら せ た 後、 chain method
 * 全 20 件 が 認 識 + plain 関 数 と 同 等 動 作 す る こ と を 担 保。
 *
 * Phase 4 skeleton stage:
 * - 既 fill 7 件 chain (= toMatchAudio / toMatchAudioFile / toBeFinite /
 *   toHavePeakUnder / toHaveRmsUnder / toMatchEvents / toMatchState) =
 *   happy path + fail path test 各 1 件。
 * - 残 13 件 chain (= toMatchAudioSnapshot / toBeStable / toBeMasterReady /
 *   toBeSilent / toHavePeakAtSample / toHaveGainAtFreq / toHaveLatency /
 *   toHaveDcOffsetUnder / toHaveEventCount / toContainEvents / toEmitMidi /
 *   toHaveBalancedMidi / toHaveStateValue) = stub-throw 経 路 = chain wrap
 *   が plain throw を vitest fail に 変 換 す る path 担 保。
 */

import "./extend.ts";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeWav } from "@unworklet/offline";
import type { RenderOfflineResult } from "@unworklet/offline";
import { expect, test } from "vite-plus/test";

const filled = (length: number, value: number): Float32Array => {
  const a = new Float32Array(length);
  a.fill(value);
  return a;
};

const monoResult = (channel: Float32Array, portName = "main"): RenderOfflineResult => ({
  outputs: { [portName]: [channel] },
  events: [],
  state: new Uint8Array(0),
  sampleRate: 48000,
});

const tmpWav = (channels: Float32Array[], sampleRate = 48000): string => {
  const dir = mkdtempSync(join(tmpdir(), "unworklet-test-extend-"));
  const path = join(dir, "ref.wav");
  writeFileSync(path, encodeWav(channels, sampleRate));
  return path;
};

const dummyResult = monoResult(filled(8, 0));

// ━━━━━━━━━━━━━━━━━━━━ 既 fill 7 件 chain happy + fail ━━━━━━━━━━━━━━━━━━━━

test("`toMatchAudio` (chain) happy = single-port bit-exact", () => {
  expect(monoResult(filled(8, 0.5))).toMatchAudio([filled(8, 0.5)]);
});

test("`toMatchAudio` (chain) fail = diff > tolerance を vitest fail に 変 換", () => {
  expect(() => expect(monoResult(filled(8, 0.5))).toMatchAudio([filled(8, 0.6)])).toThrow(/diff/);
});

test("`toMatchAudioFile` (chain) happy = round-trip bit-exact", () => {
  const ch = filled(128, 0.5);
  expect(monoResult(ch)).toMatchAudioFile(tmpWav([ch]));
});

test("`toMatchAudioFile` (chain) fail = mismatch", () => {
  const path = tmpWav([filled(128, 0.5)]);
  expect(() => expect(monoResult(filled(128, 0.6))).toMatchAudioFile(path)).toThrow(/diff/);
});

test("`toBeFinite` (chain) happy = NaN ナ シ", () => {
  expect(monoResult(filled(8, 0.5))).toBeFinite();
});

test("`toBeFinite` (chain) fail = NaN 含 む", () => {
  const ch = filled(8, 0.5);
  ch[3] = NaN;
  expect(() => expect(monoResult(ch)).toBeFinite()).toThrow(/NaN/);
});

test("`toHavePeakUnder` (chain) happy = peak < threshold", () => {
  expect(monoResult(filled(8, 0.5))).toHavePeakUnder(-3);
});

test("`toHavePeakUnder` (chain) fail = peak ≥ threshold", () => {
  expect(() => expect(monoResult(filled(8, 1.0))).toHavePeakUnder(-3)).toThrow(/peak/);
});

test("`toHaveRmsUnder` (chain) happy = RMS < threshold", () => {
  expect(monoResult(filled(8, 0.1))).toHaveRmsUnder(-10);
});

test("`toHaveRmsUnder` (chain) fail = RMS ≥ threshold", () => {
  expect(() => expect(monoResult(filled(8, 1.0))).toHaveRmsUnder(-3)).toThrow(/RMS/);
});

test("`toMatchEvents` (chain) happy = empty arrays match (= Phase 4 subset)", () => {
  expect(monoResult(filled(8, 0))).toMatchEvents([]);
});

test("`toMatchEvents` (chain) fail = length mismatch", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "peak", payload: {}, atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expect(result).toMatchEvents([])).toThrow(/length/);
});

test("`toMatchState` (chain) happy = empty blobs match (= Phase 4 subset)", () => {
  expect(monoResult(filled(8, 0))).toMatchState(new Uint8Array(0));
});

test("`toMatchState` (chain) fail = byte mismatch", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [],
    state: new Uint8Array([1, 2, 3]),
    sampleRate: 48000,
  };
  expect(() => expect(result).toMatchState(new Uint8Array([1, 2, 4]))).toThrow(/byte/);
});

// ━━━━━━━━━━━━━━━━━━━━ 残 13 件 chain stub-throw 経 路 ━━━━━━━━━━━━━━━━━━━━━

test("`toMatchAudioSnapshot` (chain) round-trip = 初 回 書 き + 2 回 目 bit-exact pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-chain-"));
  const path = join(dir, "ref.wav");
  const result = monoResult(filled(128, 0.5));
  await expect(result).toMatchAudioSnapshot({ snapshotPath: path });
  await expect(result).toMatchAudioSnapshot({ snapshotPath: path });
});

test("`toMatchAudioSnapshot` (chain) opts.snapshotPath 省 略 = 自 動 推 論 path", async () => {
  const result = monoResult(filled(8, 0));
  await expect(result).toMatchAudioSnapshot();
});

test("`toBeStable` (chain) happy = clean PCM", () => {
  expect(monoResult(filled(8, 1.5))).toBeStable();
});

test("`toBeStable` (chain) fail = NaN", () => {
  const ch = filled(8, 0.5);
  ch[3] = NaN;
  expect(() => expect(monoResult(ch)).toBeStable()).toThrow(/NaN/);
});

test("`toBeMasterReady` (chain) happy = 低 level + clean", () => {
  expect(monoResult(filled(8, 0.1))).toBeMasterReady();
});

test("`toBeMasterReady` (chain) fail = peak 上 限 超 え", () => {
  expect(() => expect(monoResult(filled(8, 1.0))).toBeMasterReady()).toThrow(/peak/);
});

test("`toBeSilent` (chain) stub fails with not implemented", () => {
  expect(() => expect(dummyResult).toBeSilent()).toThrow(/not implemented/);
});

test("`toHavePeakAtSample` (chain) stub fails with not implemented", () => {
  expect(() => expect(dummyResult).toHavePeakAtSample(0)).toThrow(/not implemented/);
});

test("`toHaveGainAtFreq` (chain) stub fails with not implemented", () => {
  expect(() => expect(dummyResult).toHaveGainAtFreq(1000, 0, 0.5)).toThrow(/not implemented/);
});

test("`toHaveLatency` (chain) stub fails with not implemented", () => {
  expect(() => expect(dummyResult).toHaveLatency(0)).toThrow(/not implemented/);
});

test("`toHaveDcOffsetUnder` (chain) stub fails with not implemented", () => {
  expect(() => expect(dummyResult).toHaveDcOffsetUnder(0.001)).toThrow(/not implemented/);
});

test("`toHaveEventCount` (chain) stub fails with not implemented", () => {
  expect(() => expect(dummyResult).toHaveEventCount("foo", 0)).toThrow(/not implemented/);
});

test("`toContainEvents` (chain) stub fails with not implemented", () => {
  expect(() => expect(dummyResult).toContainEvents([])).toThrow(/not implemented/);
});

test("`toEmitMidi` (chain) stub fails with not implemented", () => {
  expect(() => expect(dummyResult).toEmitMidi("midiOut", [])).toThrow(/not implemented/);
});

test("`toHaveBalancedMidi` (chain) stub fails with not implemented", () => {
  expect(() => expect(dummyResult).toHaveBalancedMidi("midiOut")).toThrow(/not implemented/);
});

test("`toHaveStateValue` (chain) stub fails with not implemented", () => {
  expect(() => expect(dummyResult).toHaveStateValue("slot", 0)).toThrow(/not implemented/);
});

// ━━━━━━━━━━━━━━━ TS-only chain guard (= 型 で 弾 け る か regression) ━━━━━━━━━━━━━━━

test("chain method TS guard refuses non-RenderOfflineResult types", () => {
  // 型 guard regression を build 時 に catch (= `WhenResult<T, M>` で chain
  // method が `never` に 解 け る か)、 runtime は 走 ら せ な い (= `if (false)`
  // 内 = TS check だ け 走 る)。 `@ts-expect-error` が 効 か な か っ た 場 合
  // (= guard 退 化) は build エ ラ ー で 検 出 さ れ る。
  if (false as boolean) {
    // @ts-expect-error `expect(1)` の T = number、 chain method は never に 解 け る。
    expect(1).toMatchAudio([new Float32Array(8)]);
    // @ts-expect-error `expect("foo")` の T = string、 chain method は never。
    expect("foo").toBeStable();
    // @ts-expect-error `expect(null)` の T = null、 chain method は never。
    expect(null).toHavePeakUnder(-6);
  }
});
