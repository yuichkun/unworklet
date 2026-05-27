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

test("toMatchAudioSnapshot (chain) Float32Array 直 接 = polymorphic actual zip", async () => {
  // plain `expectAudioMatchesSnapshot` が `Float32Array` 直 接 受 け る path
  // を chain で も 通 す regression。 chain typing が `WhenResult` (=
  // `RenderOfflineResult` 限 定) の ま ま だ と TS error で typecheck fail。
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-chain-mono-"));
  const path = join(dir, "ref.wav");
  await expect(filled(8, 0)).toMatchAudioSnapshot({ snapshotPath: path });
  await expect(filled(8, 0)).toMatchAudioSnapshot({ snapshotPath: path });
});

test("toMatchAudioSnapshot (chain) Float32Array[] 直 接 = multi-ch polymorphic actual zip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-chain-multi-"));
  const path = join(dir, "ref.wav");
  const channels = [filled(8, 0.1), filled(8, 0.2)];
  await expect(channels).toMatchAudioSnapshot({ snapshotPath: path });
  await expect(channels).toMatchAudioSnapshot({ snapshotPath: path });
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
  // stray noteOff = always fail (chain path 同 様)。
  const stray: RenderOfflineResult = {
    outputs: {},
    events: [
      {
        name: "out",
        payload: { type: "noteOff", channel: 0, note: 60, velocity: 0 },
        atSample: 0,
      },
    ],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expect(stray).toHaveBalancedMidi("out")).toThrow(/stray/);
});

// ━━━━━━━━ chain `.not.toXyz()` (= 成 功 case で の pass=true message thunk) ━━━━━━━━

test("`.not.toBeStable()` (chain) = pass=true message thunk が `expected NOT to satisfy ${chainName}` を 返 す", () => {
  // chain matcher が pass=true を 返 す 経 路 で `.not` を 当 て る と vitest
  // が `pass: true` 側 の message thunk を 評 価 す る = `wrap()` の
  // `expected NOT to satisfy ${chainName}` 分 岐 を hit。
  expect(() => expect(monoResult(filled(8, 0.5))).not.toBeStable()).toThrow(
    /expected NOT to satisfy toBeStable/,
  );
});

test("`.not.toMatchAudioSnapshot()` (chain) = pass=true message thunk hit (= snapshot 一 致 で .not fail)", async () => {
  // chain snapshot matcher が pass=true を 返 す 経 路 で `.not` を 当 て る
  // path = `toMatchAudioSnapshotChain` 内 の `expected NOT to satisfy
  // toMatchAudioSnapshot` 分 岐 を hit。 初 回 書 き 込 み + 2 回 目 一 致 の
  // 第 二 invocation で `.not` を 評 価。
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-chain-not-"));
  const path = join(dir, "ref.wav");
  const result = monoResult(filled(8, 0.5));
  await expect(result).toMatchAudioSnapshot({ snapshotPath: path });
  await expect(expect(result).not.toMatchAudioSnapshot({ snapshotPath: path })).rejects.toThrow(
    /expected NOT to satisfy toMatchAudioSnapshot/,
  );
});

// ━━━━━━━━━━━ chain snapshot catch path (= 一 致 fail で pass=false 経 路) ━━━━━━━━━━━

test("`toMatchAudioSnapshot` (chain) 同 test 内 2 連 続 invoke で `_unworkletCounters` 再 利 用 (= else 分 岐 hit)", async () => {
  // `this` (= per-test-invocation MatcherState) は vitest 内 で test 間 で
  // shared = 同 test 内 で 連 続 invoke す る と 2 回 目 は `_unworkletCounters`
  // 既 attach 済 み の 経 路 を 通 る (= `toMatchAudioSnapshotChain` L169-171
  // の if 不 取 り = else 分 岐)。 auto-infer path で 走 ら せ て counter Map
  // 再 利 用 経 路 を hit。
  const result = monoResult(filled(8, 0));
  await expect(result).toMatchAudioSnapshot();
  await expect(result).toMatchAudioSnapshot();
});

test("`toMatchAudioSnapshot` (chain) byte content mismatch = vitest fail に zip", async () => {
  // 一 致 fail (= snapshot 既 存 + bytes 異 な る) で chain matcher が catch
  // 経 由 で `pass: false` を 返 す path を hit = `toMatchAudioSnapshotChain`
  // 末 尾 catch block 全 体 を 覆 う。 `String(err)` 分 岐 は plain function
  // が `new Error(...)` の み を throw す る 仕 様 で defensive dead branch。
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-chain-mismatch-"));
  const path = join(dir, "ref.wav");
  await expect(monoResult(filled(8, 0.5))).toMatchAudioSnapshot({ snapshotPath: path });
  await expect(
    expect(monoResult(filled(8, 0.6))).toMatchAudioSnapshot({ snapshotPath: path }),
  ).rejects.toThrow(/snapshot byte/);
});

test("`toMatchAudioSnapshot` (chain) byte length mismatch = vitest fail に zip", async () => {
  // 一 致 fail (= snapshot 既 存 + 長 さ 異 な る) で chain matcher が catch
  // 経 由 で `pass: false` を 返 す path を hit + `expectAudioMatchesSnapshotWithState`
  // L526-529 (= byte length mismatch throw) を 覆 う。
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-chain-length-"));
  const path = join(dir, "ref.wav");
  await expect(monoResult(filled(8, 0.5))).toMatchAudioSnapshot({ snapshotPath: path });
  await expect(
    expect(monoResult(filled(16, 0.5))).toMatchAudioSnapshot({ snapshotPath: path }),
  ).rejects.toThrow(/snapshot byte length mismatch/);
});

// ━━━━━━━ `expectAudioMatchesSnapshot` updateMode 分 岐 (= chain + plain 共 用 path) ━━━━━━━

test("`toMatchAudioSnapshot` (chain) updateMode='all' = 不 一 致 で も 上 書 き + pass", async () => {
  // chain matcher は `this.snapshotState._updateSnapshot` (= per-test bound
  // MatcherState) 経 由 で update mode を 読 む。 `vitest -u` 相 当 path
  // (= `updateMode === "all"`) で snapshot を 強 制 上 書 き す る 分 岐
  // (= `expectAudioMatchesSnapshotWithState` L520-523) を hit。 chain form
  // で は `this` mock を 直 に 注 入 す る path が な い の で、 ま ず chain
  // で snapshot を 一 つ 書 き 出 し、 plain form (= `expectAudioMatchesSnapshot`)
  // 経 由 で update mode を 切 替 え て path を 覆 う 形 で zip。
  const { expectAudioMatchesSnapshot } = await import("./index.ts");
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-update-all-"));
  const path = join(dir, "ref.wav");
  await expect(monoResult(filled(8, 0.5))).toMatchAudioSnapshot({ snapshotPath: path });
  const prev = expect.getState().snapshotState as unknown as
    | { _updateSnapshot?: string }
    | undefined;
  const prevMode = prev?._updateSnapshot;
  if (prev) prev._updateSnapshot = "all";
  try {
    // 不 一 致 actual で も updateMode='all' で 上 書 き + pass。
    await expectAudioMatchesSnapshot(monoResult(filled(8, 0.6)), { snapshotPath: path });
  } finally {
    if (prev) prev._updateSnapshot = prevMode;
  }
});

test("`expectAudioMatchesSnapshot` (plain) updateMode='none' + 新 規 path = throw (= --ci mode 相 当)", async () => {
  // `updateMode === "none"` + snapshot 不 在 = vitest `--ci` 相 当 path で
  // 新 規 snapshot 作 成 不 可 = throw (= `expectAudioMatchesSnapshotWithState`
  // L510-514)。
  const { expectAudioMatchesSnapshot } = await import("./index.ts");
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-update-none-"));
  const path = join(dir, "missing.wav");
  const prev = expect.getState().snapshotState as unknown as
    | { _updateSnapshot?: string }
    | undefined;
  const prevMode = prev?._updateSnapshot;
  if (prev) prev._updateSnapshot = "none";
  try {
    await expect(
      expectAudioMatchesSnapshot(monoResult(filled(8, 0.5)), { snapshotPath: path }),
    ).rejects.toThrow(/--ci mode/);
  } finally {
    if (prev) prev._updateSnapshot = prevMode;
  }
});

test("`expectAudioMatchesSnapshot` (plain) byte content mismatch = throw", async () => {
  // plain path の byte content mismatch throw (= L531-536) を 覆 う。
  const { expectAudioMatchesSnapshot } = await import("./index.ts");
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-plain-mismatch-"));
  const path = join(dir, "ref.wav");
  await expectAudioMatchesSnapshot(monoResult(filled(8, 0.5)), { snapshotPath: path });
  await expect(
    expectAudioMatchesSnapshot(monoResult(filled(8, 0.6)), { snapshotPath: path }),
  ).rejects.toThrow(/snapshot byte/);
});

test("`expectAudioMatchesSnapshot` (plain) byte length mismatch = throw", async () => {
  // plain path の byte length mismatch throw (= L526-529) を 覆 う。
  const { expectAudioMatchesSnapshot } = await import("./index.ts");
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-plain-length-"));
  const path = join(dir, "ref.wav");
  await expectAudioMatchesSnapshot(monoResult(filled(8, 0.5)), { snapshotPath: path });
  await expect(
    expectAudioMatchesSnapshot(monoResult(filled(16, 0.5)), { snapshotPath: path }),
  ).rejects.toThrow(/snapshot byte length mismatch/);
});

// ━━━━━━━━━━━━━━━ TS-only chain guard (= 型 で 弾 け る か regression) ━━━━━━━━━━━━━━━

test("chain method TS guard refuses non-RenderOfflineResult types", () => {
  // 型 guard regression を build 時 に catch (= `WhenResult<T, M>` /
  // `WhenAudioActual<T, M>` で chain method が `never` に 解 け る か)、
  // runtime は 走 ら せ な い (= `if (false)` 内 = TS check だ け 走 る)。
  // `@ts-expect-error` が 効 か な か っ た 場 合 (= guard 退 化) は build
  // エ ラ ー で 検 出 さ れ る。
  if (false as boolean) {
    // @ts-expect-error `expect(1)` の T = number、 chain method は never に 解 け る。
    expect(1).toMatchAudio([new Float32Array(8)]);
    // @ts-expect-error `expect("foo")` の T = string、 chain method は never。
    expect("foo").toBeStable();
    // @ts-expect-error `expect(null)` の T = null、 chain method は never。
    expect(null).toHavePeakUnder(-6);
    // @ts-expect-error `toMatchAudioSnapshot` は `Float32Array` を 通 す が、
    // 非 audio actual (= number) は `WhenAudioActual` で never に 解 け る。
    expect(1).toMatchAudioSnapshot();
    // `toMatchAudioSnapshot` の polymorphic actual = `Float32Array` 直 接 は
    // typecheck OK (= `WhenAudioActual` 経 由)、 ts-expect-error ナ シ で 通 る。
    void expect(new Float32Array(8)).toMatchAudioSnapshot();
    // 同 上、 `Float32Array[]` 直 接 も typecheck OK。
    void expect([new Float32Array(8)]).toMatchAudioSnapshot();
  }
});
