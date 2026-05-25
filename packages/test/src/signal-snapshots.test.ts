/**
 * `@unworklet/test` の signal generator (= sine / silence / impulse /
 * sineSweep / whiteNoise / dc / ramp) の 出 力 を wav snapshot に 取 る
 * (= 耳 / 目 で DSP 動 作 確 認 path、 `docs/06-testing.md` §3)。
 *
 * 既 数 値 assertion test (= `index.test.ts` 内) と は 別 軸:
 * - 既 = `[...buf]` 等 で 個 別 sample 値 を 機 械 的 check (= unit)
 * - 本 file = 1 sec @ 48k wav を `__snapshots__/` に auto-write + commit、
 *   余 湖 さん が 耳 / waveform viewer で DSP 振 る 舞 い を ジ ャ ッ ジ する
 *   path。 impl 変 更 で wav 変 化 = bit-exact 比 較 で test fail = 余 湖
 *   さん 再 判 断 path に carry。
 *
 * 注 意 = sine / sineSweep / whiteNoise = amplitude 1 = peak 0 dBFS = 大
 * 音 量 = volume 調 整 し て か ら 再 生 推 奨。 silence / dc / ramp = 耳 で
 * は ほ ぼ 無 音 = waveform viewer で 形 を 確 認 す る path。
 *
 * 各 件 で `opts.snapshotName` 明 示 = file 名 cleaner (= test 名 = test 何 を
 * 担 保 す る か の 自 由 説 明、 snapshotName = file 名 識 別 子 と し て 短 い
 * 形 で carry)。
 */

import { test } from "vite-plus/test";

import {
  dc,
  expectAudioMatchesSnapshot,
  impulse,
  ramp,
  silence,
  sine,
  sineSweep,
  whiteNoise,
} from "./index.ts";

const sampleRate = 48000;
const durationSamples = sampleRate; // 1 sec

test("sine generator output (= A4 純 音 / 1s)", async () => {
  await expectAudioMatchesSnapshot(sine({ freqHz: 440, durationSamples, sampleRate }), {
    snapshotName: "sine",
  });
});

test("silence generator output (= 全 0 / 1s)", async () => {
  await expectAudioMatchesSnapshot(silence(durationSamples), { snapshotName: "silence" });
});

test("impulse generator output (= atSample 0 / 1s)", async () => {
  await expectAudioMatchesSnapshot(impulse(durationSamples), { snapshotName: "impulse" });
});

test("sineSweep generator output (= 20 Hz → 20 kHz log / 1s)", async () => {
  await expectAudioMatchesSnapshot(
    sineSweep({ startHz: 20, endHz: 20000, durationSamples, sampleRate }),
    { snapshotName: "sineSweep" },
  );
});

test("whiteNoise generator output (= seed-based deterministic / seed 1 / 1s)", async () => {
  await expectAudioMatchesSnapshot(whiteNoise({ durationSamples, seed: 1 }), {
    snapshotName: "whiteNoise",
  });
});

test("dc generator output (= value 1.0 / 1s)", async () => {
  await expectAudioMatchesSnapshot(dc(durationSamples, 1.0), { snapshotName: "dc" });
});

test("ramp generator output (= 0 → 1 線 形 / 1s)", async () => {
  await expectAudioMatchesSnapshot(ramp({ durationSamples, from: 0, to: 1 }), {
    snapshotName: "ramp",
  });
});
