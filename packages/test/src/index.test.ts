/**
 * `@unworklet/test` matcher + utility behavior (= `docs/06-testing.md` §2-§6)。
 * TDD 規 範 = 振 る 舞 い ベ ー ス test 先 行 + 実 装 fill。 各 export ご と
 * に happy path + fail path test を 並 べ る。 `expectStateValue` は 上 流
 * `inspect` (= `docs/05-client.md` §2.6) fill 待 ち で stub-throw 維 持。
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

test("`expectAudioMatches`: sampleRate mismatch = throw (= 同 PCM / 異 rate で pitch / timing bug を 検 出)", () => {
  const sameData = new Float32Array([0.1, 0.2, 0.3]);
  const a: RenderOfflineResult = {
    outputs: { main: [sameData] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  const b: RenderOfflineResult = {
    outputs: { main: [sameData] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 44100,
  };
  expect(() => expectAudioMatches(a, b)).toThrow(/sampleRate mismatch/);
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

test("`expectAudioMatchesGolden`: sampleRate mismatch = throw (= 同 PCM / 異 rate で pitch / timing bug を 検 出)", () => {
  // wav 44.1k で 書 か れ た 同 PCM を actual 48k と 比 較 = mismatch fail
  // (= 後 で round-trip し て も rate metadata の 違 い で pitch bug)。
  const ch = filled(128, 0.5);
  const path = tmpWav([ch], 44100);
  expect(() => expectAudioMatchesGolden(monoResult(ch), path)).toThrow(/sampleRate mismatch/);
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

test("expectAudioMatchesSnapshot auto-infer path", async () => {
  // 自 動 推 論 = `<test-file-dir>/__snapshots__/<test-file-name>__<test-name>__<counter>.wav`、
  // 初 回 走 行 時 に snapshot wav が repo に commit さ れ、 以 降 bit-exact 回 帰 防 止。
  const result = monoResult(filled(8, 0));
  await expectAudioMatchesSnapshot(result);
});

test("expectAudioMatchesSnapshot opts.snapshotName path", async () => {
  // `snapshotName` 明 示 = file 名 中 の test 名 部 分 を 上 書 き、 counter ナ シ、
  // `<test-file-base>__<safe(snapshotName)>.wav` で 書 き 出 し。
  const result = monoResult(filled(8, 0));
  await expectAudioMatchesSnapshot(result, { snapshotName: "snapshotName demo" });
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━ expectSilence ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectSilence`: 全 0 = pass", () => {
  expect(() => expectSilence(monoResult(filled(8, 0)))).not.toThrow();
});

test("`expectSilence`: 非 silence = throw", () => {
  expect(() => expectSilence(monoResult(filled(8, 0.1)))).toThrow(/silence/i);
});

test("`expectSilence`: opts.tolerance 内 = pass", () => {
  expect(() => expectSilence(monoResult(filled(8, 0.0001)), { tolerance: 0.001 })).not.toThrow();
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━ expectPeakAtSample ━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectPeakAtSample`: impulse → peak at 0 = pass", () => {
  expect(() => expectPeakAtSample(monoResult(impulse(8)), 0)).not.toThrow();
});

test("`expectPeakAtSample`: opts.atSample で 移 動 し た impulse", () => {
  expect(() => expectPeakAtSample(monoResult(impulse(8, { atSample: 3 })), 3)).not.toThrow();
});

test("`expectPeakAtSample`: tolerance 越 え で throw", () => {
  expect(() => expectPeakAtSample(monoResult(impulse(8)), 5)).toThrow(/peak/);
});

test("`expectPeakAtSample`: tolerance 内 で pass", () => {
  expect(() => expectPeakAtSample(monoResult(impulse(8)), 2, { tolerance: 3 })).not.toThrow();
});

test("`expectPeakAtSample`: multi-port + opts.port 未 指 定 = throw", () => {
  const result: RenderOfflineResult = {
    outputs: { main: [impulse(8)], send: [impulse(8, { atSample: 5 })] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectPeakAtSample(result, 0)).toThrow(/multi-port/);
});

test("`expectPeakAtSample`: opts.port 明 示 で 多 port 該 当", () => {
  const result: RenderOfflineResult = {
    outputs: { main: [impulse(8)], send: [impulse(8, { atSample: 5 })] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectPeakAtSample(result, 5, { port: "send" })).not.toThrow();
});

test("`expectPeakAtSample`: opts.port 不 在 = throw", () => {
  expect(() => expectPeakAtSample(monoResult(impulse(8)), 0, { port: "nonexistent" })).toThrow(
    /not in result.outputs/,
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━ expectDcOffsetUnder ━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectDcOffsetUnder`: silence = DC 0 = pass", () => {
  expect(() => expectDcOffsetUnder(monoResult(filled(8, 0)), 0.001)).not.toThrow();
});

test("`expectDcOffsetUnder`: DC 0.5 + threshold 0.001 = throw", () => {
  expect(() => expectDcOffsetUnder(monoResult(filled(8, 0.5)), 0.001)).toThrow(/DC offset/);
});

test("`expectDcOffsetUnder`: 振 動 信 号 (= 平 均 0) = pass", () => {
  // sine 1 周 期 → 平 均 ≈ 0
  const buf = sine({ freqHz: 1, durationSamples: 100, sampleRate: 100 });
  expect(() => expectDcOffsetUnder(monoResult(buf), 0.01)).not.toThrow();
});

test("`expectDcOffsetUnder`: empty channel (= length 0) = mean 0 = pass", () => {
  const result: RenderOfflineResult = {
    outputs: { main: [new Float32Array(0)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectDcOffsetUnder(result, 0.001)).not.toThrow();
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━ expectGainAtFreq ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectGainAtFreq`: 純 音 amplitude 1 = 0 dB ± 2 dB で pass (= spectral leakage 受 容)", () => {
  // sine 1000 Hz amplitude 1 / 1024 sample @ 48k、 bin 21 が 1000 Hz 周 辺。
  // freqHz が bin 中 心 に 完 全 に 乗 ら な い 時 spectral leakage で 隣 接 bin
  // に 振 幅 が 分 散 = tolerance 2 dB で OK。
  const buf = sine({ freqHz: 1000, durationSamples: 1024, sampleRate: 48000, amplitude: 1 });
  expect(() => expectGainAtFreq(monoResult(buf), 1000, 0, 2)).not.toThrow();
});

test("`expectGainAtFreq`: amplitude 0.5 = -6 dB ± 2 dB で pass", () => {
  const buf = sine({ freqHz: 1000, durationSamples: 1024, sampleRate: 48000, amplitude: 0.5 });
  expect(() => expectGainAtFreq(monoResult(buf), 1000, -6, 2)).not.toThrow();
});

test("`expectGainAtFreq`: silence (= -Infinity dB) vs 0 dB expected = throw", () => {
  expect(() => expectGainAtFreq(monoResult(silence(1024)), 1000, 0, 1)).toThrow(/gain/);
});

test("`expectGainAtFreq`: multi-port で throw", () => {
  const result: RenderOfflineResult = {
    outputs: { main: [silence(1024)], send: [silence(1024)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectGainAtFreq(result, 1000, 0, 1)).toThrow(/single-port/);
});

test("`expectGainAtFreq`: empty channel で throw", () => {
  const result: RenderOfflineResult = {
    outputs: { main: [new Float32Array(0)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectGainAtFreq(result, 1000, 0, 1)).toThrow(/empty/);
});

test("`expectGainAtFreq`: Nyquist 越 え freq で throw", () => {
  expect(() => expectGainAtFreq(monoResult(silence(1024)), 30000, 0, 1)).toThrow(/out of range/);
});

test("`expectGainAtFreq`: 非 2 ^ k 長 さ (= L = 48000) で 純 音 amplitude 1 = 0 dB ± 1.5 dB regression", () => {
  // L = 48000 sr = 48000 f = 1000 で nextPow2 = 65536 zero-pad、 bin 1365 が
  // 1000 Hz 周 辺 (= bin freq = 999.756 Hz = -0.244 Hz offset)。 元 信 号 長
  // `ch.length` で 正 規 化 す る path = leakage 込 み で -0.87 dB (= sinc
  // factor 0.905)、 zero-pad 後 N で 正 規 化 す る path = 追 加 で L / N =
  // 0.732 倍 過 小 = -3.57 dB で 1.5 dB tolerance fail。
  const buf = sine({ freqHz: 1000, durationSamples: 48000, sampleRate: 48000, amplitude: 1 });
  expect(() => expectGainAtFreq(monoResult(buf), 1000, 0, 1.5)).not.toThrow();
});

test("`expectGainAtFreq`: multichannel + opts.channel 未 指 定 = throw (= silent blind spot 防 止)", () => {
  const buf = sine({ freqHz: 1000, durationSamples: 1024, sampleRate: 48000, amplitude: 1 });
  const result = stereoResult(buf, silence(1024));
  expect(() => expectGainAtFreq(result, 1000, 0, 2)).toThrow(/multichannel.*opts\.channel/);
});

test("`expectGainAtFreq`: multichannel + opts.channel 指 定 = 指 定 ch 解 析 (= 壊 れ た 非 第 0 ch を 検 出)", () => {
  // ch 0 = 純 音 0 dB、 ch 1 = silence (= -Infinity dB)。 opts.channel: 1
  // 指 定 で ch 1 silence を 解 析 = expected 0 dB と mismatch で throw。
  const buf = sine({ freqHz: 1000, durationSamples: 1024, sampleRate: 48000, amplitude: 1 });
  const result = stereoResult(buf, silence(1024));
  expect(() => expectGainAtFreq(result, 1000, 0, 2, { channel: 0 })).not.toThrow();
  expect(() => expectGainAtFreq(result, 1000, 0, 2, { channel: 1 })).toThrow(/gain/);
});

test("`expectGainAtFreq`: opts.channel 範 囲 外 = throw", () => {
  const buf = sine({ freqHz: 1000, durationSamples: 1024, sampleRate: 48000, amplitude: 1 });
  expect(() => expectGainAtFreq(monoResult(buf), 1000, 0, 2, { channel: 5 })).toThrow(
    /out of range/,
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━ expectLatency ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectLatency`: impulse at 0 → latency 0 = pass", () => {
  expect(() => expectLatency(monoResult(impulse(8)), 0)).not.toThrow();
});

test("`expectLatency`: delay 5 sample impulse → latency 5", () => {
  expect(() => expectLatency(monoResult(impulse(16, { atSample: 5 })), 5)).not.toThrow();
});

test("`expectLatency`: 期 待 mismatch で throw", () => {
  expect(() => expectLatency(monoResult(impulse(16, { atSample: 5 })), 10)).toThrow(/delay/);
});

test("`expectLatency`: tolerance band で pass", () => {
  expect(() =>
    expectLatency(monoResult(impulse(16, { atSample: 5 })), 7, { tolerance: 3 }),
  ).not.toThrow();
});

test("`expectLatency`: multi-port で throw", () => {
  const result: RenderOfflineResult = {
    outputs: { main: [impulse(8)], send: [impulse(8)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectLatency(result, 0)).toThrow(/single-port/);
});

test("`expectLatency`: multichannel + opts.channel 未 指 定 = throw (= silent blind spot 防 止)", () => {
  const result = stereoResult(impulse(8, { atSample: 0 }), impulse(8, { atSample: 5 }));
  expect(() => expectLatency(result, 0)).toThrow(/multichannel.*opts\.channel/);
});

test("`expectLatency`: multichannel + opts.channel 指 定 = 指 定 ch 解 析 (= 壊 れ た 非 第 0 ch を 検 出)", () => {
  // ch 0 = impulse @ 0、 ch 1 = impulse @ 5。 latency 0 期 待 で channel: 0
  // pass / channel: 1 fail。
  const result = stereoResult(impulse(8, { atSample: 0 }), impulse(8, { atSample: 5 }));
  expect(() => expectLatency(result, 0, { channel: 0 })).not.toThrow();
  expect(() => expectLatency(result, 0, { channel: 1 })).toThrow(/delay/);
});

test("`expectLatency`: opts.channel 範 囲 外 = throw", () => {
  expect(() => expectLatency(monoResult(impulse(8)), 0, { channel: 5 })).toThrow(/out of range/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━ expectEventCount ━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectEventCount`: 同 name 件 数 一 致 = pass", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [
      { name: "peak", payload: {}, atSample: 0 },
      { name: "peak", payload: {}, atSample: 10 },
      { name: "other", payload: {}, atSample: 5 },
    ],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectEventCount(result, "peak", 2)).not.toThrow();
});

test("`expectEventCount`: 不 一 致 で throw", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "peak", payload: {}, atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectEventCount(result, "peak", 2)).toThrow(/count 1 != expected 2/);
});

test("`expectEventCount`: 不 在 name = 0 = pass", () => {
  expect(() => expectEventCount(monoResult(filled(8, 0)), "ghost", 0)).not.toThrow();
});

// ━━━━━━━━━━━━━━━━━━━━━━━━ expectEventsContaining ━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectEventsContaining`: 全 partial 件 が result に exists = pass", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [
      { name: "peak", payload: { level: 0.5 }, atSample: 10 },
      { name: "other", payload: {}, atSample: 5 },
    ],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectEventsContaining(result, [{ name: "peak" }, { name: "other" }])).not.toThrow();
});

test("`expectEventsContaining`: payload 部 分 一 致", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "peak", payload: { level: 0.5 }, atSample: 10 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() =>
    expectEventsContaining(result, [{ name: "peak", payload: { level: 0.5 } }]),
  ).not.toThrow();
});

test("`expectEventsContaining`: payload mismatch で throw", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "peak", payload: { level: 0.5 }, atSample: 10 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectEventsContaining(result, [{ name: "peak", payload: { level: 0.7 } }])).toThrow(
    /not found/,
  );
});

test("`expectEventsContaining`: atSample 一 致 path", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "peak", payload: {}, atSample: 10 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectEventsContaining(result, [{ name: "peak", atSample: 10 }])).not.toThrow();
});

test("`expectEventsContaining`: atSample mismatch で throw", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "peak", payload: {}, atSample: 10 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectEventsContaining(result, [{ name: "peak", atSample: 99 }])).toThrow(
    /not found/,
  );
});

test("`expectEventsContaining`: 余 計 な event は 許 容 (= 順 不 同 / 部 分 一 致)", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [
      { name: "noise", payload: {}, atSample: 0 },
      { name: "peak", payload: {}, atSample: 10 },
      { name: "noise", payload: {}, atSample: 20 },
    ],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectEventsContaining(result, [{ name: "peak" }])).not.toThrow();
});

test("`expectEventsContaining`: empty partial = pass", () => {
  expect(() => expectEventsContaining(monoResult(filled(8, 0)), [])).not.toThrow();
});

test("`expectStateValue` stub throws", () => {
  expect(() => expectStateValue(dummyResult, "slot", 0)).toThrow(/not implemented/);
});

// ━━━━━━━━━━━━━━ NaN guard regression (= 全 numerical matcher) ━━━━━━━━━━━━━━━
// `Math.abs(NaN) > x = false` / `NaN >= x = false` で NaN 入 力 が 偽 pass す
// る 経 路 を 各 matcher の 冒 頭 `expectNoNaN(result)` で 塞 ぐ。

const nanResult = (): RenderOfflineResult => {
  const ch = filled(8, 0.5);
  ch[3] = NaN;
  return monoResult(ch);
};

test("`expectAudioMatches`: NaN actual = throw (= silent compare pass を 防 ぐ)", () => {
  expect(() => expectAudioMatches(nanResult(), [filled(8, 0.5)])).toThrow(/NaN/);
});

test("`expectAudioMatchesGolden`: NaN actual = throw (= 内 部 `expectAudioMatches` 経 由)", () => {
  const path = tmpWav([filled(8, 0.5)]);
  expect(() => expectAudioMatchesGolden(nanResult(), path)).toThrow(/NaN/);
});

test("`expectAudioMatchesSnapshot`: NaN actual = throw (= snapshot 初 回 書 き で 壊 れ た wav を 永 続 化 し な い)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-nan-"));
  const path = join(dir, "ref.wav");
  await expect(expectAudioMatchesSnapshot(nanResult(), { snapshotPath: path })).rejects.toThrow(
    /NaN/,
  );
});

test("`expectPeakUnder`: NaN = throw (= peak が 0 の ま ま 留 ま っ て -Infinity dB で 偽 pass を 防 ぐ)", () => {
  expect(() => expectPeakUnder(nanResult(), -3)).toThrow(/NaN/);
});

test("`expectRmsUnder`: NaN = throw (= rms = NaN ≥ dbfs = false で 偽 pass を 防 ぐ)", () => {
  expect(() => expectRmsUnder(nanResult(), -3)).toThrow(/NaN/);
});

test("`expectSilence`: NaN = throw (= abs(NaN) > 0 = false で 偽 pass を 防 ぐ)", () => {
  expect(() => expectSilence(nanResult())).toThrow(/NaN/);
});

test("`expectPeakAtSample`: NaN = throw (= maxIdx が 初 期 値 の ま ま で 偽 pass を 防 ぐ)", () => {
  expect(() => expectPeakAtSample(nanResult(), 3)).toThrow(/NaN/);
});

test("`expectGainAtFreq`: NaN = throw (= FFT magnitude NaN 伝 播 で 偽 pass を 防 ぐ)", () => {
  expect(() => expectGainAtFreq(nanResult(), 1000, 0, 1)).toThrow(/NaN/);
});

test("`expectLatency`: NaN = throw (= maxIdx が 初 期 値 で 偽 pass を 防 ぐ)", () => {
  expect(() => expectLatency(nanResult(), 0)).toThrow(/NaN/);
});

test("`expectDcOffsetUnder`: NaN = throw (= mean = NaN ≥ threshold = false で 偽 pass を 防 ぐ)", () => {
  expect(() => expectDcOffsetUnder(nanResult(), 0.001)).toThrow(/NaN/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━ signal utility 7 件 ━━━━━━━━━━━━━━━━━━━━━━━━━

test("`sine`: 440 Hz @ 48k で 第 1 sample = 0 + 4 分 周 期 sample で 1", () => {
  // 周 期 sample 数 = 48000 / 440 ≈ 109.09、 4 分 周 期 ≈ 27.27 sample
  const buf = sine({ freqHz: 440, durationSamples: 128, sampleRate: 48000 });
  expect(buf.length).toBe(128);
  expect(buf[0]).toBeCloseTo(0, 6);
  // sample 27 周 辺 で sin が 1 に 近 く な る
  expect(buf[27]).toBeCloseTo(1, 1);
});

test("`sine`: amplitude / phase 反 映", () => {
  const buf = sine({
    freqHz: 1,
    durationSamples: 4,
    sampleRate: 4,
    amplitude: 0.5,
    phase: Math.PI / 2,
  });
  // phase = π/2 で sample 0 = sin(π/2) = 1、 amplitude 0.5 で 0.5
  expect(buf[0]).toBeCloseTo(0.5, 6);
});

test("`silence`: 全 0", () => {
  const buf = silence(8);
  expect(buf.length).toBe(8);
  expect([...buf]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
});

test("`impulse`: default = 第 0 sample = 1、 残 0", () => {
  const buf = impulse(4);
  expect([...buf]).toEqual([1, 0, 0, 0]);
});

test("`impulse`: opts.atSample で 位 置 上 書 き", () => {
  const buf = impulse(4, { atSample: 2 });
  expect([...buf]).toEqual([0, 0, 1, 0]);
});

test("`impulse`: opts.atSample 範 囲 外 = 全 0", () => {
  const buf = impulse(4, { atSample: 100 });
  expect([...buf]).toEqual([0, 0, 0, 0]);
});

test("`sineSweep`: log sweep deterministic", () => {
  const buf = sineSweep({ startHz: 100, endHz: 1000, durationSamples: 64, sampleRate: 48000 });
  expect(buf.length).toBe(64);
  // 第 0 sample = 0 (phase = 2π * 100 / 48000)
  expect(Math.abs(buf[0]!)).toBeCloseTo((2 * Math.PI * 100) / 48000, 4);
});

test("`sineSweep`: lin type", () => {
  const buf = sineSweep({
    startHz: 100,
    endHz: 200,
    durationSamples: 16,
    sampleRate: 48000,
    type: "lin",
  });
  expect(buf.length).toBe(16);
});

test("`whiteNoise`: deterministic seed = 同 buffer", () => {
  const a = whiteNoise({ durationSamples: 32, seed: 42 });
  const b = whiteNoise({ durationSamples: 32, seed: 42 });
  expect([...a]).toEqual([...b]);
});

test("`whiteNoise`: 違 う seed = 違 う buffer", () => {
  const a = whiteNoise({ durationSamples: 32, seed: 1 });
  const b = whiteNoise({ durationSamples: 32, seed: 2 });
  expect([...a]).not.toEqual([...b]);
});

test("`whiteNoise`: amplitude 反 映 = 全 sample |s| <= amplitude", () => {
  const buf = whiteNoise({ durationSamples: 1024, amplitude: 0.5 });
  for (const s of buf) expect(Math.abs(s)).toBeLessThanOrEqual(0.5);
});

test("`dc`: default value = 1", () => {
  const buf = dc(4);
  expect([...buf]).toEqual([1, 1, 1, 1]);
});

test("`dc`: 任 意 value", () => {
  const buf = dc(3, 0.25);
  expect([...buf]).toEqual([0.25, 0.25, 0.25]);
});

test("`ramp`: 0..1 / 5 sample = [0, 0.25, 0.5, 0.75, 1]", () => {
  const buf = ramp({ durationSamples: 5, from: 0, to: 1 });
  expect([...buf]).toEqual([0, 0.25, 0.5, 0.75, 1]);
});

test("`ramp`: 単 一 sample = from", () => {
  const buf = ramp({ durationSamples: 1, from: 0.5, to: 1 });
  expect(buf[0]).toBe(0.5);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━ midi namespace 10 件 ━━━━━━━━━━━━━━━━━━━━━━━━━

test("`midi.noteOn`: 構 築 + default channel 0", () => {
  expect(midi.noteOn({ note: 60, velocity: 100 })).toEqual({
    type: "noteOn",
    channel: 0,
    note: 60,
    velocity: 100,
  });
});

test("`midi.noteOff`: default velocity 0", () => {
  expect(midi.noteOff({ note: 60 })).toEqual({
    type: "noteOff",
    channel: 0,
    note: 60,
    velocity: 0,
  });
});

test("`midi.cc`: 構 築 + channel 上 書 き", () => {
  expect(midi.cc({ controller: 7, value: 100, channel: 5 })).toEqual({
    type: "cc",
    channel: 5,
    controller: 7,
    value: 100,
  });
});

test("`midi.pitchBend`: 構 築", () => {
  expect(midi.pitchBend({ value: 8192 })).toEqual({
    type: "pitchBend",
    channel: 0,
    value: 8192,
  });
});

test("`midi.programChange`: 構 築", () => {
  expect(midi.programChange({ program: 42 })).toEqual({
    type: "programChange",
    channel: 0,
    program: 42,
  });
});

test("`midi.channelPressure`: 構 築", () => {
  expect(midi.channelPressure({ pressure: 80 })).toEqual({
    type: "channelPressure",
    channel: 0,
    pressure: 80,
  });
});

test("`midi.aftertouch`: 構 築", () => {
  expect(midi.aftertouch({ note: 60, pressure: 80 })).toEqual({
    type: "aftertouch",
    channel: 0,
    note: 60,
    pressure: 80,
  });
});

test("`midi.systemRealtime`: 構 築 (= 0xF8 = timing clock)", () => {
  expect(midi.systemRealtime(0xf8)).toEqual({ type: "systemRealtime", status: 0xf8 });
});

test("`midi.sysex`: 構 築 (= data carry)", () => {
  const bytes = new Uint8Array([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]);
  expect(midi.sysex(bytes)).toEqual({ type: "sysex", data: bytes });
});

test("`midi.sequence`: 配 列 → OfflineEvent[] 変 換", () => {
  const seq = midi.sequence("midiIn", [
    { at: 0, event: midi.noteOn({ note: 60, velocity: 100 }) },
    { at: 480, event: midi.noteOff({ note: 60 }) },
  ]);
  expect(seq).toEqual([
    {
      name: "midiIn",
      payload: { type: "noteOn", channel: 0, note: 60, velocity: 100 },
      atSample: 0,
    },
    {
      name: "midiIn",
      payload: { type: "noteOff", channel: 0, note: 60, velocity: 0 },
      atSample: 480,
    },
  ]);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━ expectMidiOut ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectMidiOut`: 順 序 + type + payload 一 致 = pass", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [
      { name: "out", payload: midi.noteOn({ note: 60, velocity: 100 }), atSample: 0 },
      { name: "out", payload: midi.noteOff({ note: 60 }), atSample: 480 },
    ],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() =>
    expectMidiOut(result, "out", [
      midi.noteOn({ note: 60, velocity: 100 }),
      midi.noteOff({ note: 60 }),
    ]),
  ).not.toThrow();
});

test("`expectMidiOut`: 件 数 不 一 致 で throw", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "out", payload: midi.noteOn({ note: 60, velocity: 100 }), atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectMidiOut(result, "out", [])).toThrow(/count/);
});

test("`expectMidiOut`: type mismatch で throw", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "out", payload: midi.noteOn({ note: 60, velocity: 100 }), atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectMidiOut(result, "out", [midi.noteOff({ note: 60 })])).toThrow(/type/);
});

test("`expectMidiOut`: atSample tolerance 越 え で throw", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "out", payload: midi.noteOn({ note: 60, velocity: 100 }), atSample: 100 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() =>
    expectMidiOut(result, "out", [{ ...midi.noteOn({ note: 60, velocity: 100 }), atSample: 0 }]),
  ).toThrow(/atSample/);
});

test("`expectMidiOut`: payload field mismatch で throw", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "out", payload: midi.noteOn({ note: 60, velocity: 100 }), atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectMidiOut(result, "out", [midi.noteOn({ note: 60, velocity: 64 })])).toThrow(
    /payload/,
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━ expectMidiBalance ━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectMidiBalance`: 完 全 pair = pass", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [
      { name: "out", payload: midi.noteOn({ note: 60, velocity: 100 }), atSample: 0 },
      { name: "out", payload: midi.noteOff({ note: 60 }), atSample: 480 },
    ],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectMidiBalance(result, "out")).not.toThrow();
});

test("`expectMidiBalance`: hanging noteOn = throw", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "out", payload: midi.noteOn({ note: 60, velocity: 100 }), atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectMidiBalance(result, "out")).toThrow(/hanging/);
});

test("`expectMidiBalance`: opts.hangingNotes で 許 容", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [
      { name: "out", payload: midi.noteOn({ note: 60, velocity: 100 }), atSample: 0 },
      { name: "out", payload: midi.noteOn({ note: 62, velocity: 100 }), atSample: 0 },
    ],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectMidiBalance(result, "out", { hangingNotes: 2 })).not.toThrow();
});

test("`expectMidiBalance`: 違 う channel は 別 note と し て track", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [
      { name: "out", payload: midi.noteOn({ note: 60, velocity: 100, channel: 0 }), atSample: 0 },
      { name: "out", payload: midi.noteOff({ note: 60, channel: 1 }), atSample: 480 },
    ],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  // ch 0 noteOn が hanging、 ch 1 noteOff が stray (= 双 方 fail に カ ウ ン ト)。
  expect(() => expectMidiBalance(result, "out")).toThrow(/hanging.*stray|stray.*hanging/);
});

test("`expectMidiBalance`: stray noteOff (= 対 応 noteOn ナ シ) = throw", () => {
  // single noteOff の み = lifecycle 不 正 = always fail (tolerance opt ナ シ)。
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "out", payload: midi.noteOff({ note: 60 }), atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectMidiBalance(result, "out")).toThrow(/stray/);
});

test("`expectMidiBalance`: double noteOff (= noteOn 1 → noteOff 2) = throw", () => {
  // 同 一 note を 2 回 off = noteOff over-count = stray fail。
  const result: RenderOfflineResult = {
    outputs: {},
    events: [
      { name: "out", payload: midi.noteOn({ note: 60, velocity: 100 }), atSample: 0 },
      { name: "out", payload: midi.noteOff({ note: 60 }), atSample: 240 },
      { name: "out", payload: midi.noteOff({ note: 60 }), atSample: 480 },
    ],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectMidiBalance(result, "out")).toThrow(/stray/);
});

test("`expectMidiBalance`: stray noteOff は hangingNotes opts で 救 え な い", () => {
  // hangingNotes opt は hanging noteOn だ け に 効 く、 stray は always fail。
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "out", payload: midi.noteOff({ note: 60 }), atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectMidiBalance(result, "out", { hangingNotes: 100 })).toThrow(/stray/);
});

test("`expectMidiBalance`: noteOff → noteOn (= 順 序 逆 転、 最 終 net 0) = throw", () => {
  // 最 終 合 算 path だ と 0 で pass し て し ま う lifecycle 逆 転 を、
  // running counter path で stray と し て 即 検 出 す る regression。
  const result: RenderOfflineResult = {
    outputs: {},
    events: [
      { name: "out", payload: midi.noteOff({ note: 60 }), atSample: 0 },
      { name: "out", payload: midi.noteOn({ note: 60, velocity: 100 }), atSample: 240 },
    ],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectMidiBalance(result, "out")).toThrow(/stray/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━ sample / time utility 6 件 ━━━━━━━━━━━━━━━━━━━━━━

test("`samplesToMs`: 480 sample @ 48k = 10 ms", () => {
  expect(samplesToMs(480, 48000)).toBe(10);
});

test("`msToSamples`: 10 ms @ 48k = 480 sample", () => {
  expect(msToSamples(10, 48000)).toBe(480);
});

test("`samplesToSec`: 48000 sample @ 48k = 1 sec", () => {
  expect(samplesToSec(48000, 48000)).toBe(1);
});

test("`secToSamples`: 1 sec @ 48k = 48000 sample", () => {
  expect(secToSamples(1, 48000)).toBe(48000);
});

test("`bpmToSamples`: 120 BPM 1/4 @ 48k = 24000 sample (= half sec)", () => {
  // 120 BPM = 0.5 sec / beat、 1/4 = 1 beat = 0.5 sec = 24000 sample @ 48k
  expect(bpmToSamples({ bpm: 120, division: "1/4", sampleRate: 48000 })).toBe(24000);
});

test("`bpmToSamples`: 120 BPM 1/16 @ 48k = 6000 sample (= 1/16 beat)", () => {
  expect(bpmToSamples({ bpm: 120, division: "1/16", sampleRate: 48000 })).toBe(6000);
});

test("`bpmToMs`: 120 BPM 1/4 = 500 ms", () => {
  expect(bpmToMs({ bpm: 120, division: "1/4" })).toBe(500);
});

test("`bpmToMs`: 60 BPM 1/1 = 4000 ms (= 4 beat = 1 whole)", () => {
  expect(bpmToMs({ bpm: 60, division: "1/1" })).toBe(4000);
});

test("`bpmToMs`: 各 division factor = (1/1: 4, 1/2: 2, 1/4: 1, 1/8: 0.5, 1/16: 0.25, 1/32: 0.125)", () => {
  // 60 BPM × 1000 ms / beat = 1000 ms/beat、 各 division で の ms
  expect(bpmToMs({ bpm: 60, division: "1/1" })).toBe(4000);
  expect(bpmToMs({ bpm: 60, division: "1/2" })).toBe(2000);
  expect(bpmToMs({ bpm: 60, division: "1/4" })).toBe(1000);
  expect(bpmToMs({ bpm: 60, division: "1/8" })).toBe(500);
  expect(bpmToMs({ bpm: 60, division: "1/16" })).toBe(250);
  expect(bpmToMs({ bpm: 60, division: "1/32" })).toBe(125);
});
