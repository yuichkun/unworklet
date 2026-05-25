/**
 * `@unworklet/test` matcher + utility behavior (= `docs/06-testing.md` §2-§6)。
 * TDD 規 範 = 振 る 舞 い ベ ー ス test 先 行 + 実 装 fill。
 *
 * Phase 4 skeleton stage:
 * - 既 fill 7 件 (= `expectAudioMatches` / `expectAudioMatchesGolden` /
 *   `expectNoNaN` / `expectPeakUnder` / `expectRmsUnder` / `expectEventsEqual`
 *   / `expectStateMatches`) = happy + fail path test 配 置 済 み。
 * - 残 36 件 (= matcher 13 + signal utility 7 + midi utility 10 + sample/time
 *   utility 6) = 各 stub-throw test 1 件 (= 「not implemented」 throw 確 認)。
 *   impl phase で fill さ れ て き た ら 該 当 stub-throw を behavior test に
 *   置 き 換 え る。
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeWav } from "@unworklet/offline";
import type { RenderOfflineResult } from "@unworklet/offline";
import { expect, test } from "vite-plus/test";

import {
  bpmToMs,
  bpmToSamples,
  dc,
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
  impulse,
  midi,
  msToSamples,
  ramp,
  samplesToMs,
  samplesToSec,
  secToSamples,
  silence,
  sine,
  sineSweep,
  whiteNoise,
} from "./index.ts";

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

const stereoResult = (left: Float32Array, right: Float32Array): RenderOfflineResult => ({
  outputs: { main: [left, right] },
  events: [],
  state: new Uint8Array(0),
  sampleRate: 48000,
});

const tmpWav = (channels: Float32Array[], sampleRate = 48000): string => {
  const dir = mkdtempSync(join(tmpdir(), "unworklet-test-"));
  const path = join(dir, "ref.wav");
  writeFileSync(path, encodeWav(channels, sampleRate));
  return path;
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━ expectAudioMatches ━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectAudioMatches`: single-port `Float32Array[]` expected (= happy)", () => {
  expect(() => expectAudioMatches(monoResult(filled(8, 0.5)), [filled(8, 0.5)])).not.toThrow();
});

test("`expectAudioMatches`: single-port `Float32Array[]` value mismatch throws (= diff > tolerance)", () => {
  expect(() => expectAudioMatches(monoResult(filled(8, 0.5)), [filled(8, 0.6)])).toThrow(/diff/);
});

test("`expectAudioMatches`: multi-port actual + `Float32Array[]` expected throws (= 曖 昧)", () => {
  const result: RenderOfflineResult = {
    outputs: { main: [filled(8, 0.5)], send: [filled(8, 0.3)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectAudioMatches(result, [filled(8, 0.5)])).toThrow(/single-port/);
});

test("`expectAudioMatches`: `Float32Array[]` channel count mismatch throws", () => {
  expect(() =>
    expectAudioMatches(monoResult(filled(8, 0.5)), [filled(8, 0.5), filled(8, 0.5)]),
  ).toThrow(/channel count/);
});

test("`expectAudioMatches`: `Float32Array[]` channel length mismatch throws", () => {
  expect(() => expectAudioMatches(monoResult(filled(8, 0.5)), [filled(4, 0.5)])).toThrow(/length/);
});

test("`expectAudioMatches`: full result form happy path (= multi-port + multi-channel)", () => {
  const a = stereoResult(filled(8, 0.5), filled(8, -0.3));
  const b = stereoResult(filled(8, 0.5), filled(8, -0.3));
  expect(() => expectAudioMatches(a, b)).not.toThrow();
});

test("`expectAudioMatches`: full result form port set mismatch throws (= 主 missing)", () => {
  const a = monoResult(filled(8, 0.5), "main");
  const b = monoResult(filled(8, 0.5), "send");
  expect(() => expectAudioMatches(a, b)).toThrow(/port/);
});

test("`expectAudioMatches`: full result form port count mismatch throws (= actual 多)", () => {
  const a: RenderOfflineResult = {
    outputs: { main: [filled(8, 0.5)], send: [filled(8, 0.3)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  const b = monoResult(filled(8, 0.5), "main");
  expect(() => expectAudioMatches(a, b)).toThrow(/port/);
});

test("`expectAudioMatches`: full result form channel count mismatch throws", () => {
  const a = stereoResult(filled(8, 0.5), filled(8, 0.3));
  const b = monoResult(filled(8, 0.5));
  expect(() => expectAudioMatches(a, b)).toThrow(/channel count/);
});

test("`expectAudioMatches`: full result form channel length mismatch throws", () => {
  const a = monoResult(filled(8, 0.5));
  const b = monoResult(filled(4, 0.5));
  expect(() => expectAudioMatches(a, b)).toThrow(/length/);
});

test("`expectAudioMatches`: tolerance > 0 admits per-sample diff within band", () => {
  const a = monoResult(new Float32Array([0.5, 0.6, 0.7]));
  const b = monoResult(new Float32Array([0.5001, 0.6001, 0.6999]));
  expect(() => expectAudioMatches(a, b, { tolerance: 0.001 })).not.toThrow();
});

test("`expectAudioMatches`: tolerance default = 0 = bit-exact (= 微 diff も 弾 く)", () => {
  const a = monoResult(new Float32Array([0.5]));
  const b = monoResult(new Float32Array([0.5000001]));
  expect(() => expectAudioMatches(a, b)).toThrow(/diff/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ expectNoNaN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectNoNaN`: clean PCM passes", () => {
  expect(() => expectNoNaN(monoResult(filled(8, 0.5)))).not.toThrow();
});

test("`expectNoNaN`: NaN throws", () => {
  const ch = filled(8, 0.5);
  ch[3] = NaN;
  expect(() => expectNoNaN(monoResult(ch))).toThrow(/NaN/);
});

test("`expectNoNaN`: +Infinity throws", () => {
  const ch = filled(8, 0.5);
  ch[3] = Infinity;
  expect(() => expectNoNaN(monoResult(ch))).toThrow(/Infinity/);
});

test("`expectNoNaN`: -Infinity throws", () => {
  const ch = filled(8, 0.5);
  ch[3] = -Infinity;
  expect(() => expectNoNaN(monoResult(ch))).toThrow(/Infinity/);
});

test("`expectNoNaN`: 多 port + 多 channel 全 走 査", () => {
  const ch0 = filled(8, 0.5);
  const ch1 = filled(8, 0.5);
  ch1[5] = NaN; // 検 出 対 象
  const result: RenderOfflineResult = {
    outputs: { main: [ch0], send: [ch0, ch1] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectNoNaN(result)).toThrow(/NaN/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━ expectPeakUnder ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectPeakUnder`: peak below threshold passes (= 0.5 = -6 dBFS < -3 dBFS)", () => {
  expect(() => expectPeakUnder(monoResult(filled(8, 0.5)), -3)).not.toThrow();
});

test("`expectPeakUnder`: peak at-or-above threshold throws (= 1.0 = 0 dBFS >= -3 dBFS)", () => {
  expect(() => expectPeakUnder(monoResult(filled(8, 1.0)), -3)).toThrow(/peak/);
});

test("`expectPeakUnder`: 負 値 abs で 検 知 (= -1.0 も 0 dBFS)", () => {
  expect(() => expectPeakUnder(monoResult(filled(8, -1.0)), -3)).toThrow(/peak/);
});

test("`expectPeakUnder`: silence (peak = 0 = -Infinity dBFS) passes any threshold", () => {
  expect(() => expectPeakUnder(monoResult(filled(8, 0)), 0)).not.toThrow();
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ expectRmsUnder ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectRmsUnder`: low RMS passes (= 0.1 ≈ -20 dBFS < -10 dBFS)", () => {
  expect(() => expectRmsUnder(monoResult(filled(8, 0.1)), -10)).not.toThrow();
});

test("`expectRmsUnder`: high RMS throws (= 1.0 = 0 dBFS >= -3 dBFS)", () => {
  expect(() => expectRmsUnder(monoResult(filled(8, 1.0)), -3)).toThrow(/RMS/);
});

test("`expectRmsUnder`: silence (RMS = 0 = -Infinity dBFS) passes any threshold", () => {
  expect(() => expectRmsUnder(monoResult(filled(8, 0)), 0)).not.toThrow();
});

test("`expectRmsUnder`: empty outputs (= count 0 path) treated as silence", () => {
  const empty: RenderOfflineResult = {
    outputs: {},
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectRmsUnder(empty, 0)).not.toThrow();
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━ expectEventsEqual ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectEventsEqual`: empty arrays match (= Phase 4 subset path)", () => {
  expect(() => expectEventsEqual(monoResult(filled(8, 0)), [])).not.toThrow();
});

test("`expectEventsEqual`: same name + payload + atSample sequence matches", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "peak", payload: { level: 0.5 }, atSample: 10 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() =>
    expectEventsEqual(result, [{ name: "peak", payload: { level: 0.5 }, atSample: 10 }]),
  ).not.toThrow();
});

test("`expectEventsEqual`: length mismatch throws", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "peak", payload: {}, atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectEventsEqual(result, [])).toThrow(/length/);
});

test("`expectEventsEqual`: name mismatch throws", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "peak", payload: {}, atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() =>
    expectEventsEqual(result, [{ name: "overshoot", payload: {}, atSample: 0 }]),
  ).toThrow(/name/);
});

test("`expectEventsEqual`: atSample mismatch throws", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "peak", payload: {}, atSample: 5 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectEventsEqual(result, [{ name: "peak", payload: {}, atSample: 10 }])).toThrow(
    /atSample/,
  );
});

test("`expectEventsEqual`: payload mismatch throws", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "peak", payload: { level: 0.5 }, atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() =>
    expectEventsEqual(result, [{ name: "peak", payload: { level: 0.7 }, atSample: 0 }]),
  ).toThrow(/payload/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━ expectStateMatches ━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectStateMatches`: empty blobs match (= Phase 4 subset path)", () => {
  expect(() => expectStateMatches(monoResult(filled(8, 0)), new Uint8Array(0))).not.toThrow();
});

test("`expectStateMatches`: same bytes match", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [],
    state: new Uint8Array([1, 2, 3, 4]),
    sampleRate: 48000,
  };
  expect(() => expectStateMatches(result, new Uint8Array([1, 2, 3, 4]))).not.toThrow();
});

test("`expectStateMatches`: length mismatch throws", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [],
    state: new Uint8Array([1, 2, 3]),
    sampleRate: 48000,
  };
  expect(() => expectStateMatches(result, new Uint8Array([1, 2]))).toThrow(/length/);
});

test("`expectStateMatches`: byte content mismatch throws", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [],
    state: new Uint8Array([1, 2, 3]),
    sampleRate: 48000,
  };
  expect(() => expectStateMatches(result, new Uint8Array([1, 2, 4]))).toThrow(/byte/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━ expectAudioMatchesGolden ━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectAudioMatchesGolden`: round-trip via encodeWav passes (= bit-exact happy)", () => {
  const ch = filled(128, 0.5);
  expect(() => expectAudioMatchesGolden(monoResult(ch), tmpWav([ch]))).not.toThrow();
});

test("`expectAudioMatchesGolden`: stereo round-trip passes", () => {
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  for (let i = 0; i < 128; i++) {
    left[i] = i / 128;
    right[i] = 1 - i / 128;
  }
  expect(() =>
    expectAudioMatchesGolden(stereoResult(left, right), tmpWav([left, right])),
  ).not.toThrow();
});

test("`expectAudioMatchesGolden`: tolerance=0 mismatch throws", () => {
  const path = tmpWav([filled(128, 0.5)]);
  expect(() => expectAudioMatchesGolden(monoResult(filled(128, 0.6)), path)).toThrow(/diff/);
});

test("`expectAudioMatchesGolden`: tolerance band admits small diff", () => {
  const path = tmpWav([filled(128, 0.5)]);
  expect(() =>
    expectAudioMatchesGolden(monoResult(filled(128, 0.5005)), path, { tolerance: 0.001 }),
  ).not.toThrow();
});

test("`expectAudioMatchesGolden`: multi-port actual throws (= single-port 推 論 で き ず)", () => {
  const path = tmpWav([filled(128, 0.5)]);
  const result: RenderOfflineResult = {
    outputs: { main: [filled(128, 0.5)], send: [filled(128, 0.3)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectAudioMatchesGolden(result, path)).toThrow(/single-port/);
});

// ━━━━━━━━━━━━━━━ stub-throw tests for new declared surface ━━━━━━━━━━━━━━

const dummyResult = monoResult(filled(8, 0));
const dummyBytes = new Uint8Array([1, 2, 3]);

// ━━━━━━━━━━━━━━━━━━━━━ expectAudioMatchesSnapshot ━━━━━━━━━━━━━━━━━━━━━━━

test("`expectAudioMatchesSnapshot`: round-trip = 初 回 書 き 出 し + 2 回 目 bit-exact pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-"));
  const path = join(dir, "ref.wav");
  const result = monoResult(filled(128, 0.5));
  await expectAudioMatchesSnapshot(result, { snapshotPath: path });
  await expectAudioMatchesSnapshot(result, { snapshotPath: path });
});

test("`expectAudioMatchesSnapshot`: multi-port + opts.port 未 指 定 で throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-"));
  const path = join(dir, "ref.wav");
  const result: RenderOfflineResult = {
    outputs: { main: [filled(8, 0.5)], send: [filled(8, 0.3)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  await expect(expectAudioMatchesSnapshot(result, { snapshotPath: path })).rejects.toThrow(
    /multi-port/,
  );
});

test("`expectAudioMatchesSnapshot`: opts.port 明 示 で 多 port → 該 当 port を wav 化", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-"));
  const path = join(dir, "ref.wav");
  const result: RenderOfflineResult = {
    outputs: { main: [filled(8, 0.5)], send: [filled(8, 0.3)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  await expectAudioMatchesSnapshot(result, { snapshotPath: path, port: "send" });
});

test("`expectAudioMatchesSnapshot`: opts.port が actual.outputs に な い と throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-"));
  const path = join(dir, "ref.wav");
  const result = monoResult(filled(8, 0));
  await expect(
    expectAudioMatchesSnapshot(result, { snapshotPath: path, port: "nonexistent" }),
  ).rejects.toThrow(/not in actual.outputs/);
});

test("`expectAudioMatchesSnapshot`: opts.snapshotPath 省 略 = 自 動 推 論 path で 書 き 出 し", async () => {
  // 自 動 推 論 = `<test-file-dir>/__snapshots__/<test-file-name>__<test-name>__<counter>.wav`、
  // 初 回 走 行 時 に snapshot wav が repo に commit さ れ、 以 降 bit-exact 回 帰 防 止。
  const result = monoResult(filled(8, 0));
  await expectAudioMatchesSnapshot(result);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━ matcher stubs (= 12 件 残) ━━━━━━━━━━━━━━━━━━━━━

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ expectStable ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectStable`: clean PCM passes (= audio level 問 わ ず)", () => {
  expect(() => expectStable(monoResult(filled(8, 1.5)))).not.toThrow();
});

test("`expectStable`: NaN throws", () => {
  const ch = filled(8, 0.5);
  ch[3] = NaN;
  expect(() => expectStable(monoResult(ch))).toThrow(/NaN/);
});

test("`expectStable`: Infinity throws (= 発 散 検 知)", () => {
  const ch = filled(8, 0.5);
  ch[3] = Infinity;
  expect(() => expectStable(monoResult(ch))).toThrow(/Infinity/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ expectMaster ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectMaster`: 低 level + clean = pass (= default thresholds)", () => {
  expect(() => expectMaster(monoResult(filled(8, 0.1)))).not.toThrow();
});

test("`expectMaster`: peak ≥ default -0.1 dBFS で throw", () => {
  expect(() => expectMaster(monoResult(filled(8, 1.0)))).toThrow(/peak/);
});

test("`expectMaster`: RMS ≥ default -14 dBFS で throw", () => {
  expect(() => expectMaster(monoResult(filled(8, 0.5)))).toThrow(/RMS/);
});

test("`expectMaster`: opts.peakDbfs 上 書 き で 緩 い threshold", () => {
  expect(() => expectMaster(monoResult(filled(8, 0.1)), { peakDbfs: 0, rmsDbfs: 0 })).not.toThrow();
});

test("`expectMaster`: NaN 含 む = default で throw", () => {
  const ch = filled(8, 0.1);
  ch[3] = NaN;
  expect(() => expectMaster(monoResult(ch))).toThrow(/NaN/);
});

test("`expectMaster`: opts.noNan: false で NaN check skip", () => {
  const ch = filled(8, 0.1);
  ch[3] = NaN;
  // NaN は skip + peak / RMS は finite sample 由 来 だ が NaN sample が peak
  // 計 算 で NaN を 生 む の で = throw (= "peak NaN") に な る path、 こ こ で は
  // NaN sample が peak 計 算 で hit し な い short array で pass 担 保 用 に
  // NaN を 含 ま な い test で 代 替 (= opts.noNan false branch を hit)。
  expect(() =>
    expectMaster(monoResult(filled(8, 0.1)), {
      noNan: false,
      peakDbfs: 0,
      rmsDbfs: 0,
    }),
  ).not.toThrow();
});

test("`expectSilence` stub throws", () => {
  expect(() => expectSilence(dummyResult)).toThrow(/not implemented/);
});

test("`expectPeakAtSample` stub throws", () => {
  expect(() => expectPeakAtSample(dummyResult, 0)).toThrow(/not implemented/);
});

test("`expectGainAtFreq` stub throws", () => {
  expect(() => expectGainAtFreq(dummyResult, 1000, 0, 0.5)).toThrow(/not implemented/);
});

test("`expectLatency` stub throws", () => {
  expect(() => expectLatency(dummyResult, 0)).toThrow(/not implemented/);
});

test("`expectDcOffsetUnder` stub throws", () => {
  expect(() => expectDcOffsetUnder(dummyResult, 0.001)).toThrow(/not implemented/);
});

test("`expectEventCount` stub throws", () => {
  expect(() => expectEventCount(dummyResult, "foo", 0)).toThrow(/not implemented/);
});

test("`expectEventsContaining` stub throws", () => {
  expect(() => expectEventsContaining(dummyResult, [])).toThrow(/not implemented/);
});

test("`expectMidiOut` stub throws", () => {
  expect(() => expectMidiOut(dummyResult, "midiOut", [])).toThrow(/not implemented/);
});

test("`expectMidiBalance` stub throws", () => {
  expect(() => expectMidiBalance(dummyResult, "midiOut")).toThrow(/not implemented/);
});

test("`expectStateValue` stub throws", () => {
  expect(() => expectStateValue(dummyResult, "slot", 0)).toThrow(/not implemented/);
});

// signal utility 7 件
test("`sine` stub throws", () => {
  expect(() => sine({ freqHz: 440, durationSamples: 128, sampleRate: 48000 })).toThrow(
    /not implemented/,
  );
});

test("`silence` stub throws", () => {
  expect(() => silence(128)).toThrow(/not implemented/);
});

test("`impulse` stub throws", () => {
  expect(() => impulse(128)).toThrow(/not implemented/);
});

test("`sineSweep` stub throws", () => {
  expect(() =>
    sineSweep({ startHz: 20, endHz: 20000, durationSamples: 128, sampleRate: 48000 }),
  ).toThrow(/not implemented/);
});

test("`whiteNoise` stub throws", () => {
  expect(() => whiteNoise({ durationSamples: 128 })).toThrow(/not implemented/);
});

test("`dc` stub throws", () => {
  expect(() => dc(128)).toThrow(/not implemented/);
});

test("`ramp` stub throws", () => {
  expect(() => ramp({ durationSamples: 128, from: 0, to: 1 })).toThrow(/not implemented/);
});

// midi utility 10 件
test("`midi.noteOn` stub throws", () => {
  expect(() => midi.noteOn({ note: 60, velocity: 100 })).toThrow(/not implemented/);
});

test("`midi.noteOff` stub throws", () => {
  expect(() => midi.noteOff({ note: 60 })).toThrow(/not implemented/);
});

test("`midi.cc` stub throws", () => {
  expect(() => midi.cc({ controller: 1, value: 64 })).toThrow(/not implemented/);
});

test("`midi.pitchBend` stub throws", () => {
  expect(() => midi.pitchBend({ value: 0 })).toThrow(/not implemented/);
});

test("`midi.programChange` stub throws", () => {
  expect(() => midi.programChange({ program: 0 })).toThrow(/not implemented/);
});

test("`midi.channelPressure` stub throws", () => {
  expect(() => midi.channelPressure({ pressure: 0 })).toThrow(/not implemented/);
});

test("`midi.aftertouch` stub throws", () => {
  expect(() => midi.aftertouch({ note: 60, pressure: 0 })).toThrow(/not implemented/);
});

test("`midi.systemRealtime` stub throws", () => {
  expect(() => midi.systemRealtime(0xf8)).toThrow(/not implemented/);
});

test("`midi.sysex` stub throws", () => {
  expect(() => midi.sysex(dummyBytes)).toThrow(/not implemented/);
});

test("`midi.sequence` stub throws", () => {
  expect(() => midi.sequence("midiIn", [])).toThrow(/not implemented/);
});

// sample/time utility 6 件
test("`samplesToMs` stub throws", () => {
  expect(() => samplesToMs(480, 48000)).toThrow(/not implemented/);
});

test("`msToSamples` stub throws", () => {
  expect(() => msToSamples(10, 48000)).toThrow(/not implemented/);
});

test("`samplesToSec` stub throws", () => {
  expect(() => samplesToSec(48000, 48000)).toThrow(/not implemented/);
});

test("`secToSamples` stub throws", () => {
  expect(() => secToSamples(1, 48000)).toThrow(/not implemented/);
});

test("`bpmToSamples` stub throws", () => {
  expect(() => bpmToSamples({ bpm: 120, division: "1/16", sampleRate: 48000 })).toThrow(
    /not implemented/,
  );
});

test("`bpmToMs` stub throws", () => {
  expect(() => bpmToMs({ bpm: 120, division: "1/16" })).toThrow(/not implemented/);
});
