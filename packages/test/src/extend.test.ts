/**
 * `@unworklet/test/extend` chain form 経 路 test (= `docs/06-testing.md` §6)。
 * side-effect import で `expect.extend(...)` を 走 ら せ た 後、 chain method
 * 全 20 件 が 認 識 + plain 関 数 と 同 等 動 作 す る こ と を 担 保。 末 尾 =
 * `WhenResult<T, M>` TS guard が `RenderOfflineResult` 以 外 で chain method
 * を `never` 化 す る regression test。 `toHaveStateValue` chain は 上 流
 * `inspect` (= `docs/05-client.md` §2.6) fill 待 ち で stub-throw 維 持。
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

test("toMatchAudioSnapshot (chain) auto-infer path", async () => {
  const result = monoResult(filled(8, 0));
  await expect(result).toMatchAudioSnapshot();
});

test("toMatchAudioSnapshot (chain) opts.snapshotName path", async () => {
  const result = monoResult(filled(8, 0));
  await expect(result).toMatchAudioSnapshot({ snapshotName: "chain snapshotName demo" });
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

test("`toBeSilent` (chain) happy + fail", () => {
  expect(monoResult(filled(8, 0))).toBeSilent();
  expect(() => expect(monoResult(filled(8, 0.1))).toBeSilent()).toThrow(/silence/i);
});

test("`toHavePeakAtSample` (chain) happy + fail", () => {
  const impulseBuf = new Float32Array(8);
  impulseBuf[3] = 1;
  expect(monoResult(impulseBuf)).toHavePeakAtSample(3);
  expect(() => expect(monoResult(impulseBuf)).toHavePeakAtSample(0)).toThrow(/peak/);
});

test("`toHaveGainAtFreq` (chain) happy + fail (= tolerance 2 dB で leakage 受 容)", () => {
  const fullScale = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) fullScale[i] = Math.sin((2 * Math.PI * 1000 * i) / 48000);
  expect(monoResult(fullScale)).toHaveGainAtFreq(1000, 0, 2);
  const half = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) half[i] = Math.sin((2 * Math.PI * 1000 * i) / 48000) * 0.5;
  expect(() => expect(monoResult(half)).toHaveGainAtFreq(1000, 0, 2)).toThrow(/gain/);
});

test("`toHaveLatency` (chain) happy + fail", () => {
  const impulseBuf = new Float32Array(8);
  impulseBuf[3] = 1;
  expect(monoResult(impulseBuf)).toHaveLatency(3);
  expect(() => expect(monoResult(impulseBuf)).toHaveLatency(0)).toThrow(/delay/);
});

test("`toHaveDcOffsetUnder` (chain) happy + fail", () => {
  expect(monoResult(filled(8, 0))).toHaveDcOffsetUnder(0.001);
  expect(() => expect(monoResult(filled(8, 0.5))).toHaveDcOffsetUnder(0.001)).toThrow(/DC offset/);
});

test("`toHaveEventCount` (chain) happy + fail", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "peak", payload: {}, atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(result).toHaveEventCount("peak", 1);
  expect(() => expect(result).toHaveEventCount("peak", 2)).toThrow(/count/);
});

test("`toContainEvents` (chain) happy + fail", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [{ name: "peak", payload: {}, atSample: 10 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(result).toContainEvents([{ name: "peak" }]);
  expect(() => expect(result).toContainEvents([{ name: "missing" }])).toThrow(/not found/);
});

test("`toEmitMidi` (chain) happy + fail", () => {
  const result: RenderOfflineResult = {
    outputs: {},
    events: [
      {
        name: "out",
        payload: { type: "noteOn", channel: 0, note: 60, velocity: 100 },
        atSample: 0,
      },
    ],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(result).toEmitMidi("out", [{ type: "noteOn", channel: 0, note: 60, velocity: 100 }]);
  expect(() => expect(result).toEmitMidi("out", [])).toThrow(/count/);
});

test("`toHaveBalancedMidi` (chain) happy + fail", () => {
  const balanced: RenderOfflineResult = {
    outputs: {},
    events: [
      {
        name: "out",
        payload: { type: "noteOn", channel: 0, note: 60, velocity: 100 },
        atSample: 0,
      },
      {
        name: "out",
        payload: { type: "noteOff", channel: 0, note: 60, velocity: 0 },
        atSample: 480,
      },
    ],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(balanced).toHaveBalancedMidi("out");
  const hanging: RenderOfflineResult = {
    outputs: {},
    events: [
      {
        name: "out",
        payload: { type: "noteOn", channel: 0, note: 60, velocity: 100 },
        atSample: 0,
      },
    ],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expect(hanging).toHaveBalancedMidi("out")).toThrow(/hanging/);
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
