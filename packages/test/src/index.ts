/**
 * `@unworklet/test` — Vitest matchers + audio test utility for `@unworklet/core`
 * processors (`docs/06-testing.md` §2-§6)。
 *
 * Plain function form (= `expectAudioMatches(result, ...)`) で 失 敗 時 = `Error`
 * を throw、 vitest が catch し て test fail。 chain form (= `expect(result).
 * toMatchAudio(...)`) は subpath `@unworklet/test/extend` の side-effect import
 * で 別 登 録 (= §6、 plain と 並 立)。
 *
 * v1.0.0 ship surface = matcher 20 件 + signal utility 7 件 + midi utility 10
 * 件 + sample/time utility 6 件 + chain form。 Phase 4 skeleton stage = 既
 * fill 済 み 7 件 (= `expectAudioMatches` / `expectAudioMatchesGolden` /
 * `expectNoNaN` / `expectPeakUnder` / `expectRmsUnder` / `expectEventsEqual` /
 * `expectStateMatches`) 維 持、 残 36 件 + chain form は `not implemented`
 * stub、 fill は impl phase incremental。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { MidiEvent } from "@unworklet/core";
import { decodeWav, encodeWav } from "@unworklet/offline";
import type { OfflineEmittedEvent, OfflineEvent, RenderOfflineResult } from "@unworklet/offline";
import { expect } from "vite-plus/test";

const notImplemented = (): never => {
  throw new Error("not implemented");
};

export type AudioMatchOptions = {
  /**
   * Sample-absolute-difference tolerance。 default `0` = bit-exact
   * (= `renderOffline` は 同 入 力 に 対 し 同 WASM binary を 同 host JS
   * runtime で instantiate す る 設 計、 識 別 入 力 = 識 別 出 力 が
   * 自 然 に 成 立 す る た め)。
   */
  tolerance?: number;
};

/** Single event entry expected by `expectEventsEqual`。 */
export type ExpectedEvent = {
  name: string;
  payload: unknown;
  atSample: number;
};

const compareChannels = (
  port: string,
  actual: Float32Array[],
  expected: Float32Array[],
  tolerance: number,
): void => {
  if (actual.length !== expected.length) {
    throw new Error(
      `expectAudioMatches: port '${port}' channel count mismatch — actual=${actual.length}, expected=${expected.length}`,
    );
  }
  for (let c = 0; c < actual.length; c++) {
    const a = actual[c]!;
    const e = expected[c]!;
    if (a.length !== e.length) {
      throw new Error(
        `expectAudioMatches: port '${port}' channel ${c} length mismatch — actual=${a.length}, expected=${e.length}`,
      );
    }
    for (let s = 0; s < a.length; s++) {
      const diff = Math.abs(a[s]! - e[s]!);
      if (diff > tolerance) {
        throw new Error(
          `expectAudioMatches: port '${port}' channel ${c} sample ${s} diff ${diff} > tolerance ${tolerance} (actual=${a[s]}, expected=${e[s]})`,
        );
      }
    }
  }
};

/**
 * Assert that `actual.outputs` matches `expected` channel-by-channel within
 * `opts.tolerance` (default `0`)。 `expected` は 2 shape:
 * - `RenderOfflineResult` = 多 port 比 較 (= `actual.outputs` の port set 全 件)。
 * - `Float32Array[]` = single-port 推 論 (= `actual.outputs` が 1 port な ら
 *   そ の port の channels と 比 較、 2 port 以 上 で throw + 多 port 用 form
 *   へ 誘 導)。
 *
 * chain 形 = `expect(actual).toMatchAudio(expected, opts?)` (= `@unworklet/test/extend`)。
 */
export function expectAudioMatches(
  actual: RenderOfflineResult,
  expected: RenderOfflineResult | Float32Array[],
  opts?: AudioMatchOptions,
): void {
  // NaN / ±Infinity 入 力 を 先 に 弾 く (= `Math.abs(NaN) > tolerance =
  // false` で 偽 pass す る 経 路 を 塞 ぐ、 全 numerical matcher で 統 一)。
  expectNoNaN(actual);
  const tolerance = opts?.tolerance ?? 0;
  if (Array.isArray(expected)) {
    const ports = Object.keys(actual.outputs);
    if (ports.length !== 1) {
      throw new Error(
        `expectAudioMatches: \`Float32Array[]\` expected requires single-port actual; actual has ${ports.length} ports (${ports.join(", ")}) — use the RenderOfflineResult form to specify per-port expected.`,
      );
    }
    compareChannels(ports[0]!, actual.outputs[ports[0]!]!, expected, tolerance);
    return;
  }
  const actualPorts = Object.keys(actual.outputs).sort();
  const expectedPorts = Object.keys(expected.outputs).sort();
  if (
    actualPorts.length !== expectedPorts.length ||
    actualPorts.some((p, i) => p !== expectedPorts[i])
  ) {
    throw new Error(
      `expectAudioMatches: port set mismatch — actual=[${actualPorts.join(", ")}], expected=[${expectedPorts.join(", ")}]`,
    );
  }
  for (const port of actualPorts) {
    compareChannels(port, actual.outputs[port]!, expected.outputs[port]!, tolerance);
  }
}

/**
 * Assert that `result.outputs` contains no NaN / ±Infinity samples。
 *
 * chain 形 = `expect(result).toBeFinite()` (= `@unworklet/test/extend`)。
 */
export function expectNoNaN(result: RenderOfflineResult): void {
  for (const port of Object.keys(result.outputs)) {
    const channels = result.outputs[port]!;
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c]!;
      for (let s = 0; s < ch.length; s++) {
        const v = ch[s]!;
        if (Number.isNaN(v)) {
          throw new Error(`expectNoNaN: port '${port}' channel ${c} sample ${s} is NaN`);
        }
        if (!Number.isFinite(v)) {
          const sign = v > 0 ? "+Infinity" : "-Infinity";
          throw new Error(`expectNoNaN: port '${port}' channel ${c} sample ${s} is ${sign}`);
        }
      }
    }
  }
}

const linearToDb = (linear: number): number => 20 * Math.log10(linear);

/**
 * Assert peak amplitude below the given dBFS threshold。
 *
 * chain 形 = `expect(result).toHavePeakUnder(dbfs)` (= `@unworklet/test/extend`)。
 */
export function expectPeakUnder(result: RenderOfflineResult, dbfs: number): void {
  // `Math.abs(NaN) > peak = false` で peak が 0 の ま ま 留 ま り、 db =
  // -Infinity が threshold を 下 回 っ て 偽 pass す る 経 路 を 塞 ぐ。
  expectNoNaN(result);
  let peak = 0;
  for (const port of Object.keys(result.outputs)) {
    for (const ch of result.outputs[port]!) {
      for (let s = 0; s < ch.length; s++) {
        const abs = Math.abs(ch[s]!);
        if (abs > peak) peak = abs;
      }
    }
  }
  const peakDb = linearToDb(peak);
  if (peakDb >= dbfs) {
    throw new Error(
      `expectPeakUnder: peak ${peak} (= ${peakDb.toFixed(3)} dBFS) is at or above threshold ${dbfs} dBFS`,
    );
  }
}

/**
 * Assert RMS amplitude below the given dBFS threshold (= 全 channel 平 方 和 平 均 の 平 方 根)。
 *
 * chain 形 = `expect(result).toHaveRmsUnder(dbfs)` (= `@unworklet/test/extend`)。
 */
export function expectRmsUnder(result: RenderOfflineResult, dbfs: number): void {
  // NaN を sumSq に 混 ぜ る と rms = NaN、 `NaN >= dbfs = false` で 偽 pass。
  expectNoNaN(result);
  let sumSq = 0;
  let count = 0;
  for (const port of Object.keys(result.outputs)) {
    for (const ch of result.outputs[port]!) {
      for (let s = 0; s < ch.length; s++) {
        const v = ch[s]!;
        sumSq += v * v;
        count++;
      }
    }
  }
  const rms = count === 0 ? 0 : Math.sqrt(sumSq / count);
  const rmsDb = linearToDb(rms);
  if (rmsDb >= dbfs) {
    throw new Error(
      `expectRmsUnder: RMS ${rms} (= ${rmsDb.toFixed(3)} dBFS) is at or above threshold ${dbfs} dBFS`,
    );
  }
}

/**
 * Assert emitted events (= name + payload + atSample) match the expected sequence。
 *
 * chain 形 = `expect(result).toMatchEvents(expectedEvents)` (= `@unworklet/test/extend`)。
 */
export function expectEventsEqual(
  result: RenderOfflineResult,
  expectedEvents: ExpectedEvent[],
): void {
  const actual: OfflineEmittedEvent[] = result.events;
  if (actual.length !== expectedEvents.length) {
    throw new Error(
      `expectEventsEqual: length mismatch — actual=${actual.length}, expected=${expectedEvents.length}`,
    );
  }
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i]!;
    const e = expectedEvents[i]!;
    if (a.name !== e.name) {
      throw new Error(
        `expectEventsEqual: event ${i} name mismatch — actual='${a.name}', expected='${e.name}'`,
      );
    }
    if (a.atSample !== e.atSample) {
      throw new Error(
        `expectEventsEqual: event ${i} atSample mismatch — actual=${a.atSample}, expected=${e.atSample}`,
      );
    }
    if (!isDeepStrictEqual(a.payload, e.payload)) {
      throw new Error(
        `expectEventsEqual: event ${i} payload mismatch — actual=${JSON.stringify(a.payload)}, expected=${JSON.stringify(e.payload)}`,
      );
    }
  }
}

/**
 * Assert that the end-of-render snapshot blob matches `expectedSnapshot`
 * (= `'persistent'` slot 限 定、 Q5 format)。 transient slot は audio 出 力
 * 経 由 で `expectAudioMatches` で 検 出。
 *
 * chain 形 = `expect(result).toMatchState(expectedSnapshot)` (= `@unworklet/test/extend`)。
 */
export function expectStateMatches(
  result: RenderOfflineResult,
  expectedSnapshot: Uint8Array,
): void {
  const actual = result.state;
  if (actual.length !== expectedSnapshot.length) {
    throw new Error(
      `expectStateMatches: length mismatch — actual=${actual.length}, expected=${expectedSnapshot.length}`,
    );
  }
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expectedSnapshot[i]) {
      throw new Error(
        `expectStateMatches: byte ${i} mismatch — actual=0x${actual[i]!.toString(16).padStart(2, "0")}, expected=0x${expectedSnapshot[i]!.toString(16).padStart(2, "0")}`,
      );
    }
  }
}

/**
 * Assert that `actual.outputs` matches the PCM stored in the WAV file at
 * `wavPath` (= `docs/06-testing.md` §2.1 + §7)。 単 一 port 専 用 (= 多 port
 * は `expectAudioMatches(actual, fullResult)` で 明 示)。
 *
 * chain 形 = `expect(actual).toMatchAudioFile(wavPath, opts?)` (= `@unworklet/test/extend`)。
 */
export function expectAudioMatchesGolden(
  actual: RenderOfflineResult,
  wavPath: string,
  opts?: AudioMatchOptions,
): void {
  const bytes = readFileSync(wavPath);
  const decoded = decodeWav(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  expectAudioMatches(actual, decoded.channels, opts);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━ stub: matcher (= 13 件) ━━━━━━━━━━━━━━━━━━━━━━━━

export type SnapshotOptions = {
  /** full path 上 書 き (= dir + file 名 を consumer が 完 全 制 御)。 省 略 + `snapshotName` 省 略 = auto-infer (= test 名 base)。 */
  snapshotPath?: string;
  /** file 名 中 の test 名 部 分 だ け 上 書 き (= `<test-file-base>__<safe(snapshotName)>.wav`、 counter ナ シ、 consumer が unique 命 名 責 任)。 test 名 自 体 は test 説 明 free に carry し つ つ file 名 を cleaner に。 `snapshotPath` 明 示 時 は そ ち ら 優 先。 */
  snapshotName?: string;
  /** `actual` = `Float32Array` / `Float32Array[]` 渡 し path で wav header に 書 く sample rate (default `48000`)。 `RenderOfflineResult` 渡 し で は ignored (= `result.sampleRate` 優 先)。 */
  sampleRate?: number;
  tolerance?: number;
  port?: string;
};

const snapshotCounters = new Map<string, number>();

/**
 * Assert that `actual` matches a vitest-style auto-managed wav snapshot
 * (`docs/06-testing.md` §2.1)。 `actual` は 3 shape:
 * - `RenderOfflineResult` = 既 path、 sample rate = `actual.sampleRate` 経 由
 * - `Float32Array` = mono 1 channel 直 接 = `opts.sampleRate` (default `48000`)
 *   で wav 化 (= signal generator 出 力 等 を wrap な し で 渡 す path)
 * - `Float32Array[]` = multi-channel 直 接 = 同 上 で wav 化
 *
 * path 解 決 優 先 順:
 * 1. `opts.snapshotPath` 明 示 = full path 上 書 き
 * 2. `opts.snapshotName` 明 示 = `<test-file-dir>/__snapshots__/<safe(snapshotName)>.wav` (= test-file-base prefix も counter も ナ シ、 consumer が unique 命 名 責 任)
 * 3. 両 省 略 = auto-infer = `<test-file-dir>/__snapshots__/<test-file-base>__<safe(test-name)>__<counter>.wav` (= test 名 自 動 推 論 = 衝 突 防 止 で prefix + counter 必 須)
 *
 * 初 回 = wav 自 動 書 き 出 し + pass、 2 回 目 以 降 = bit-exact 比 較、
 * `vitest -u` で 強 制 上 書 き、 CI mode = 不 在 で fail (= vitest snapshot
 * state 経 由 で update / CI mode 判 定)。
 *
 * 単 一 port 専 用 (= 1 port な ら 推 論、 `opts.port` で 明 示 上 書 き、 多
 * port + `opts.port` 未 指 定 で throw)。
 *
 * chain 形 = `await expect(actual).toMatchAudioSnapshot(opts?)` (= `@unworklet/test/extend`)。
 */
export async function expectAudioMatchesSnapshot(
  actual: RenderOfflineResult | Float32Array | Float32Array[],
  opts: SnapshotOptions = {},
): Promise<void> {
  // actual 正 規 化 = Float32Array / Float32Array[] 渡 し は RenderOfflineResult 形 に wrap。
  let result: RenderOfflineResult;
  if (actual instanceof Float32Array) {
    result = {
      outputs: { main: [actual] },
      events: [],
      state: new Uint8Array(0),
      sampleRate: opts.sampleRate ?? 48000,
    };
  } else if (Array.isArray(actual)) {
    result = {
      outputs: { main: actual },
      events: [],
      state: new Uint8Array(0),
      sampleRate: opts.sampleRate ?? 48000,
    };
  } else {
    result = actual;
  }

  // NaN / ±Infinity samples を 先 に 弾 く (= 初 回 書 き 出 し で 壊 れ た
  // wav を snapshot 化 し て し ま う と 以 降 bit-exact pass し 続 け て
  // catastrophic DSP failure を 見 逃 す 経 路 を 塞 ぐ)。
  expectNoNaN(result);

  const ports = Object.keys(result.outputs);
  let portName: string;
  if (opts.port !== undefined) {
    if (!(opts.port in result.outputs)) {
      throw new Error(
        `expectAudioMatchesSnapshot: opts.port '${opts.port}' not in actual.outputs (= [${ports.join(", ")}])`,
      );
    }
    portName = opts.port;
  } else if (ports.length === 1) {
    portName = ports[0]!;
  } else {
    throw new Error(
      `expectAudioMatchesSnapshot: multi-port actual requires opts.port; got ports=[${ports.join(", ")}]`,
    );
  }
  const channels = result.outputs[portName]!;
  const wavBytes = encodeWav(channels, result.sampleRate);

  const state = expect.getState();
  let snapshotPath = opts.snapshotPath;
  if (snapshotPath === undefined && opts.snapshotName !== undefined) {
    // 明 示 `snapshotName` path = `__snapshots__/<safe(snapshotName)>.wav` 直 接 計 算
    // (= test-file-base prefix も counter も ナ シ、 consumer が unique 命 名 責 任、
    // test 名 と は 独 立 = test 説 明 free path)。
    if (!state.testPath) {
      throw new Error(
        `expectAudioMatchesSnapshot: opts.snapshotName path 計 算 に は expect.getState().testPath が 必 要; pass opts.snapshotPath explicitly to override.`,
      );
    }
    const safeName = opts.snapshotName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    snapshotPath = join(dirname(state.testPath), "__snapshots__", `${safeName}.wav`);
  }
  if (snapshotPath === undefined) {
    if (!state.testPath || !state.currentTestName) {
      throw new Error(
        `expectAudioMatchesSnapshot: snapshot path auto-infer requires expect.getState().testPath + .currentTestName; pass opts.snapshotPath explicitly to override.`,
      );
    }
    const dir = dirname(state.testPath);
    const base = basename(state.testPath, extname(state.testPath));
    const safeName = state.currentTestName.replace(/[^A-Za-z0-9]+/g, "_");
    const key = `${state.testPath}::${state.currentTestName}`;
    const counter = (snapshotCounters.get(key) ?? 0) + 1;
    snapshotCounters.set(key, counter);
    snapshotPath = join(dir, "__snapshots__", `${base}__${safeName}__${counter}.wav`);
  }

  // vitest snapshot state 経 由 で update / CI mode 取 得 (= jest 互 換 path
  // `_updateSnapshot` = "all" (= `-u`) / "new" (= default、 不 在 で 書 く) /
  // "none" (= `--ci`、 不 在 で fail))。 vitest 標 準 toMatchFileSnapshot は
  // Uint8Array を text JSON で serialize し て し ま い 再 生 可 能 な wav
  // バ イ ナ リ に な ら な い た め、 こ こ は 自 力 fs API path を 取 る。
  const snapshotState = state.snapshotState as unknown as { _updateSnapshot?: string } | undefined;
  const updateMode = snapshotState?._updateSnapshot ?? "new";
  const exists = existsSync(snapshotPath);

  if (!exists) {
    if (updateMode === "none") {
      throw new Error(
        `expectAudioMatchesSnapshot: snapshot file does not exist at ${snapshotPath} (= vitest --ci mode で 新 規 snapshot 作 成 不 可)`,
      );
    }
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, wavBytes);
    return;
  }

  if (updateMode === "all") {
    writeFileSync(snapshotPath, wavBytes);
    return;
  }

  const existing = readFileSync(snapshotPath);
  if (existing.length !== wavBytes.length) {
    throw new Error(
      `expectAudioMatchesSnapshot: snapshot byte length mismatch at ${snapshotPath} — actual=${wavBytes.length}, snapshot=${existing.length}`,
    );
  }
  for (let i = 0; i < wavBytes.length; i++) {
    if (existing[i] !== wavBytes[i]) {
      throw new Error(
        `expectAudioMatchesSnapshot: snapshot byte ${i} mismatch at ${snapshotPath} — actual=0x${wavBytes[i]!.toString(16).padStart(2, "0")}, snapshot=0x${existing[i]!.toString(16).padStart(2, "0")}`,
      );
    }
  }
  // Promise<void> 返 し maintain (= API は async、 内 部 同 期 I/O は cosmetic)
  return Promise.resolve();
}

/**
 * NaN ナ シ + 全 sample finite (= 発 散 ナ シ) を 1 行 で wrap。 IIR
 * feedback / 長 時 間 render の 安 定 性 sanity check (`docs/06-testing.md`
 * §2.2)。 audio level は 問 わ ず (= clip し て て も pass)。
 *
 * chain 形 = `expect(result).toBeStable()` (= `@unworklet/test/extend`)。
 */
export function expectStable(result: RenderOfflineResult): void {
  expectNoNaN(result);
}

export type MasterOptions = {
  peakDbfs?: number;
  rmsDbfs?: number;
  noNan?: boolean;
};

/**
 * Master bus デフ ォ check = NaN ナ シ + peak < `opts.peakDbfs` (default
 * `-0.1`) + RMS < `opts.rmsDbfs` (default `-14`) を 1 行 wrap。 `expectStable`
 * ⊂ `expectMaster` (= master は stable 含 む + clip / 過 大 loudness 検 出)。
 * `opts.noNan` (default `true`) を `false` で NaN check 無 効 化 可。
 *
 * chain 形 = `expect(result).toBeMasterReady(opts?)` (= `@unworklet/test/extend`)。
 */
export function expectMaster(result: RenderOfflineResult, opts: MasterOptions = {}): void {
  const noNan = opts.noNan ?? true;
  const peakDbfs = opts.peakDbfs ?? -0.1;
  const rmsDbfs = opts.rmsDbfs ?? -14;
  if (noNan) expectNoNaN(result);
  expectPeakUnder(result, peakDbfs);
  expectRmsUnder(result, rmsDbfs);
}

/**
 * 全 sample が tolerance 内 で 0 (= default `0` = bit-exact silence)。 pure
 * MIDI processor / mute / 起 動 直 後 等。
 *
 * chain 形 = `expect(result).toBeSilent(opts?)` (= `@unworklet/test/extend`)。
 */
export function expectSilence(
  result: RenderOfflineResult,
  opts: { tolerance?: number } = {},
): void {
  // `Math.abs(NaN) > tolerance = false` で NaN sample が silence と し て
  // 偽 pass す る 経 路 を 塞 ぐ。
  expectNoNaN(result);
  const tolerance = opts.tolerance ?? 0;
  for (const port of Object.keys(result.outputs)) {
    const channels = result.outputs[port]!;
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c]!;
      for (let s = 0; s < ch.length; s++) {
        const abs = Math.abs(ch[s]!);
        if (abs > tolerance) {
          throw new Error(
            `expectSilence: port '${port}' channel ${c} sample ${s} = ${ch[s]} (abs ${abs}) > tolerance ${tolerance}`,
          );
        }
      }
    }
  }
}

export type PeakAtSampleOptions = {
  tolerance?: number;
  port?: string;
};

/**
 * Time domain = 最 大 abs index が `expectedAtSample` ± `opts.tolerance`
 * (= sample 単 位)。 envelope attack peak / impulse response peak 位 置 等。
 * port = `opts.port` 明 示 or 単 一 port 推 論 (= 多 port + 未 指 定 で throw)。
 *
 * chain 形 = `expect(result).toHavePeakAtSample(expectedAtSample, opts?)` (= `@unworklet/test/extend`)。
 */
export function expectPeakAtSample(
  result: RenderOfflineResult,
  expectedAtSample: number,
  opts: PeakAtSampleOptions = {},
): void {
  // NaN を 含 む と max abs 比 較 が 全 て false に な り maxIdx が 初 期
  // 値 (= -1 / 0) の ま ま で 偽 pass す る 経 路 を 塞 ぐ。
  expectNoNaN(result);
  const tolerance = opts.tolerance ?? 0;
  const ports = Object.keys(result.outputs);
  let portName: string;
  if (opts.port !== undefined) {
    if (!(opts.port in result.outputs)) {
      throw new Error(
        `expectPeakAtSample: opts.port '${opts.port}' not in result.outputs (= [${ports.join(", ")}])`,
      );
    }
    portName = opts.port;
  } else if (ports.length === 1) {
    portName = ports[0]!;
  } else {
    throw new Error(
      `expectPeakAtSample: multi-port result requires opts.port; got ports=[${ports.join(", ")}]`,
    );
  }
  const channels = result.outputs[portName]!;
  let maxAbs = -1;
  let maxIdx = -1;
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c]!;
    for (let s = 0; s < ch.length; s++) {
      const abs = Math.abs(ch[s]!);
      if (abs > maxAbs) {
        maxAbs = abs;
        maxIdx = s;
      }
    }
  }
  if (Math.abs(maxIdx - expectedAtSample) > tolerance) {
    throw new Error(
      `expectPeakAtSample: port '${portName}' peak index ${maxIdx} (= max abs ${maxAbs}) not within ±${tolerance} of expected ${expectedAtSample}`,
    );
  }
}

/** Next power of 2 (= FFT 入 力 サ イ ズ 用)。 */
const nextPow2 = (n: number): number => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

/**
 * In-place radix-2 Cooley-Tukey FFT (= `expectGainAtFreq` 用 内 部 FFT)。
 * 入 力 = `real` / `imag` (= 同 長 さ + length が 2 ^ k)、 出 力 = 上 書 き。
 */
const fftInPlace = (real: Float32Array, imag: Float32Array): void => {
  const n = real.length;
  // bit-reverse permutation
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i]!;
      real[i] = real[j]!;
      real[j] = tr;
      const ti = imag[i]!;
      imag[i] = imag[j]!;
      imag[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const evenRe = real[i + k]!;
        const evenIm = imag[i + k]!;
        const oddRe = real[i + k + half]! * curRe - imag[i + k + half]! * curIm;
        const oddIm = real[i + k + half]! * curIm + imag[i + k + half]! * curRe;
        real[i + k] = evenRe + oddRe;
        imag[i + k] = evenIm + oddIm;
        real[i + k + half] = evenRe - oddRe;
        imag[i + k + half] = evenIm - oddIm;
        const tmpRe = curRe * wRe - curIm * wIm;
        const tmpIm = curRe * wIm + curIm * wRe;
        curRe = tmpRe;
        curIm = tmpIm;
      }
    }
  }
};

/**
 * Freq domain = 内 部 FFT 経 由 で `freqHz` 周 辺 の dB ゲ イ ン が
 * `expectedDb` ± `tolerance`。 EQ test の core (`docs/06-testing.md` §2.2)。
 * 単 一 port 推 論 (= 多 port で throw)、 第 0 channel を 使 う。 FFT サ イ ズ
 * = 入 力 を 次 の 2 ^ k へ zero-pad、 freqHz → bin = round(freqHz × N /
 * sampleRate)、 magnitude = 2 × sqrt(re² + im²) / L (= 元 信 号 長
 * `ch.length` で 正 規 化、 zero-pad 部 分 は DFT 和 に 0 寄 与 = 振 幅 は L
 * に だ け 比 例)、 dB = 20 × log10(magnitude)。
 *
 * chain 形 = `expect(result).toHaveGainAtFreq(freqHz, expectedDb, tolerance)` (= `@unworklet/test/extend`)。
 */
export function expectGainAtFreq(
  result: RenderOfflineResult,
  freqHz: number,
  expectedDb: number,
  tolerance: number,
): void {
  // NaN を FFT に 通 す と magnitude / db = NaN、 `Math.abs(NaN - expectedDb)
  // > tolerance = false` で 偽 pass す る 経 路 を 塞 ぐ。
  expectNoNaN(result);
  const ports = Object.keys(result.outputs);
  if (ports.length !== 1) {
    throw new Error(
      `expectGainAtFreq: single-port result expected; got ports=[${ports.join(", ")}]`,
    );
  }
  const portName = ports[0]!;
  const ch = result.outputs[portName]![0];
  if (!ch || ch.length === 0) {
    throw new Error(`expectGainAtFreq: port '${portName}' channel 0 is empty`);
  }
  const n = nextPow2(ch.length);
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 0; i < ch.length; i++) real[i] = ch[i]!;
  fftInPlace(real, imag);
  const bin = Math.round((freqHz * n) / result.sampleRate);
  if (bin < 0 || bin >= n / 2) {
    throw new Error(
      `expectGainAtFreq: freqHz ${freqHz} out of range for sampleRate ${result.sampleRate} (= Nyquist ${result.sampleRate / 2})`,
    );
  }
  // spectral leakage 緩 和 = bin ± 1 周 辺 で max magnitude (= freqHz が bin
  // 中 心 に exact に 乗 ら な い 時 の 振 幅 過 小 評 価 を 隣 接 bin で 救 う)。
  let mag = 0;
  const startK = Math.max(0, bin - 1);
  const endK = Math.min(n / 2 - 1, bin + 1);
  for (let k = startK; k <= endK; k++) {
    const reK = real[k]!;
    const imK = imag[k]!;
    const m = (2 * Math.sqrt(reK * reK + imK * imK)) / ch.length;
    if (m > mag) mag = m;
  }
  const db = mag > 0 ? 20 * Math.log10(mag) : Number.NEGATIVE_INFINITY;
  if (Math.abs(db - expectedDb) > tolerance) {
    throw new Error(
      `expectGainAtFreq: port '${portName}' bin ${bin} (= ${freqHz} Hz) gain ${db.toFixed(3)} dB not within ±${tolerance} of expected ${expectedDb} dB`,
    );
  }
}

/**
 * 入 力 impulse → 出 力 max abs index の delay sample 数 計 測 + assert。
 * lookahead processor の 設 計 latency 担 保。 単 一 port 推 論 + 第 0
 * channel 使 用。 consumer は impulse 入 力 で renderOffline 走 ら せ た 結 果
 * を 渡 す。
 *
 * chain 形 = `expect(result).toHaveLatency(expectedSamples, opts?)` (= `@unworklet/test/extend`)。
 */
export function expectLatency(
  result: RenderOfflineResult,
  expectedSamples: number,
  opts: { tolerance?: number } = {},
): void {
  // NaN を 含 む と max abs 比 較 が 全 て false に な り maxIdx が 初 期
  // 値 (= -1) の ま ま で 偽 pass す る 経 路 を 塞 ぐ。
  expectNoNaN(result);
  const tolerance = opts.tolerance ?? 0;
  const ports = Object.keys(result.outputs);
  if (ports.length !== 1) {
    throw new Error(`expectLatency: single-port result expected; got ports=[${ports.join(", ")}]`);
  }
  const portName = ports[0]!;
  const ch = result.outputs[portName]![0];
  if (!ch) {
    throw new Error(`expectLatency: port '${portName}' channel 0 missing`);
  }
  let maxAbs = -1;
  let maxIdx = -1;
  for (let s = 0; s < ch.length; s++) {
    const abs = Math.abs(ch[s]!);
    if (abs > maxAbs) {
      maxAbs = abs;
      maxIdx = s;
    }
  }
  if (Math.abs(maxIdx - expectedSamples) > tolerance) {
    throw new Error(
      `expectLatency: detected delay ${maxIdx} sample (= max abs ${maxAbs}) not within ±${tolerance} of expected ${expectedSamples}`,
    );
  }
}

/**
 * 全 sample 平 均 値 (= DC bias) 絶 対 値 が `threshold` 未 満。 filter /
 * EQ の DC 振 る 舞 い 確 認。 channel ご と に 平 均 を 計 算、 ど の channel
 * の DC 絶 対 値 が threshold 以 上 で も throw。
 *
 * chain 形 = `expect(result).toHaveDcOffsetUnder(threshold)` (= `@unworklet/test/extend`)。
 */
export function expectDcOffsetUnder(result: RenderOfflineResult, threshold: number): void {
  // NaN を sum に 混 ぜ る と mean = NaN、 `NaN >= threshold = false` で 偽 pass。
  expectNoNaN(result);
  for (const port of Object.keys(result.outputs)) {
    const channels = result.outputs[port]!;
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c]!;
      let sum = 0;
      for (let s = 0; s < ch.length; s++) sum += ch[s]!;
      const mean = ch.length === 0 ? 0 : sum / ch.length;
      const abs = Math.abs(mean);
      if (abs >= threshold) {
        throw new Error(
          `expectDcOffsetUnder: port '${port}' channel ${c} DC offset ${mean} (abs ${abs}) >= threshold ${threshold}`,
        );
      }
    }
  }
}

/**
 * 特 定 name の event 件 数 一 致 (= 順 序 / payload は 問 わ ず)。
 *
 * chain 形 = `expect(result).toHaveEventCount(name, expectedCount)` (= `@unworklet/test/extend`)。
 */
export function expectEventCount(
  result: RenderOfflineResult,
  name: string,
  expectedCount: number,
): void {
  let count = 0;
  for (const e of result.events) if (e.name === name) count++;
  if (count !== expectedCount) {
    throw new Error(
      `expectEventCount: event '${name}' count ${count} != expected ${expectedCount}`,
    );
  }
}

/** `expectEventsContaining` の partial event shape。 */
export type PartialExpectedEvent = {
  name: string;
  payload?: unknown;
  atSample?: number;
};

/**
 * 部 分 一 致 (= `partial[i]` が `result.events` の ど こ か に exists)。 順
 * 不 同 + 余 計 な event 許 容。 `payload` / `atSample` 省 略 = そ の field
 * を 比 較 し な い (= name だ け hit で OK)。
 *
 * chain 形 = `expect(result).toContainEvents(partial)` (= `@unworklet/test/extend`)。
 */
export function expectEventsContaining(
  result: RenderOfflineResult,
  partial: PartialExpectedEvent[],
): void {
  for (let i = 0; i < partial.length; i++) {
    const p = partial[i]!;
    const found = result.events.some((e) => {
      if (e.name !== p.name) return false;
      if (p.atSample !== undefined && e.atSample !== p.atSample) return false;
      if (p.payload !== undefined && !isDeepStrictEqual(e.payload, p.payload)) return false;
      return true;
    });
    if (!found) {
      const details: string[] = [`name='${p.name}'`];
      if (p.atSample !== undefined) details.push(`atSample=${p.atSample}`);
      if (p.payload !== undefined) details.push(`payload=${JSON.stringify(p.payload)}`);
      throw new Error(
        `expectEventsContaining: partial [${i}] (${details.join(", ")}) not found in result.events`,
      );
    }
  }
}

/** `expectMidiOut` で 渡 す MIDI event + 任 意 atSample。 */
export type ExpectedMidiEvent = MidiEvent & { atSample?: number };

/**
 * 特 定 `midiOutput({ name })` port 経 由 emit さ れ た MIDI event 列 を
 * `MidiEvent` 形 で 一 致 比 較。 `result.events` か ら `name === portName`
 * を filter、 payload を `MidiEvent` と み な し て 順 序 + type + 全 field
 * deep compare、 atSample は `expected.atSample` 省 略 = actual に zip、 明 示
 * の 時 は ± `opts.tolerance` (default 0) で 比 較。
 *
 * chain 形 = `expect(result).toEmitMidi(portName, expectedMidiEvents, opts?)` (= `@unworklet/test/extend`)。
 */
export function expectMidiOut(
  result: RenderOfflineResult,
  portName: string,
  expectedMidiEvents: ExpectedMidiEvent[],
  opts: { tolerance?: number } = {},
): void {
  const tolerance = opts.tolerance ?? 0;
  const actual = result.events.filter((e) => e.name === portName);
  if (actual.length !== expectedMidiEvents.length) {
    throw new Error(
      `expectMidiOut: port '${portName}' MIDI event count ${actual.length} != expected ${expectedMidiEvents.length}`,
    );
  }
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i]!;
    const e = expectedMidiEvents[i]!;
    const aPayload = a.payload as MidiEvent;
    if (aPayload.type !== e.type) {
      throw new Error(
        `expectMidiOut: port '${portName}' event ${i} type mismatch — actual='${aPayload.type}', expected='${e.type}'`,
      );
    }
    const expAtSample = e.atSample;
    if (expAtSample !== undefined && Math.abs(a.atSample - expAtSample) > tolerance) {
      throw new Error(
        `expectMidiOut: port '${portName}' event ${i} atSample ${a.atSample} not within ±${tolerance} of expected ${expAtSample}`,
      );
    }
    // payload deep compare (= atSample を 除 い た MidiEvent 全 field)
    const { atSample: _atSampleStripped, ...expWithoutAt } = e;
    void _atSampleStripped;
    if (!isDeepStrictEqual(aPayload, expWithoutAt)) {
      throw new Error(
        `expectMidiOut: port '${portName}' event ${i} payload mismatch — actual=${JSON.stringify(aPayload)}, expected=${JSON.stringify(expWithoutAt)}`,
      );
    }
  }
}

/**
 * noteOn / noteOff pair が balance、 hanging note (= noteOn 後 noteOff
 * な し) が `opts.hangingNotes` (default `0`) 件 ま で 許 容。 stray
 * noteOff (= 出 現 時 点 で 対 応 (channel, note) の noteOn 在 庫 が ゼ
 * ロ の noteOff = lifecycle 逆 転 / noteOn 1 に 対 し て noteOff 2 以 上)
 * は always fail (= MIDI lifecycle で stray は 常 に bug = tolerance opt
 * ナ シ)。 events を 時 系 列 走 査 し て (channel, note) ご と の running
 * counter を track、 noteOff 到 着 時 cur ≤ 0 = 即 stray 計 上 = 「noteOff
 * → noteOn (= net 0)」 や 「noteOn 1 → noteOff 2」 を 順 序 sensitive に
 * 検 出 (= 最 終 合 算 path で は 拾 え な い 偽 pass を 塞 ぐ)。
 *
 * chain 形 = `expect(result).toHaveBalancedMidi(portName, opts?)` (= `@unworklet/test/extend`)。
 */
export function expectMidiBalance(
  result: RenderOfflineResult,
  portName: string,
  opts: { hangingNotes?: number } = {},
): void {
  const allowed = opts.hangingNotes ?? 0;
  const actual = result.events.filter((e) => e.name === portName);
  const running = new Map<string, number>();
  const strayList: string[] = [];
  let strayCount = 0;
  for (const e of actual) {
    const m = e.payload as MidiEvent;
    if (m.type === "noteOn") {
      const k = `${m.channel}/${m.note}`;
      running.set(k, (running.get(k) ?? 0) + 1);
    } else if (m.type === "noteOff") {
      const k = `${m.channel}/${m.note}`;
      const cur = running.get(k) ?? 0;
      if (cur <= 0) {
        strayCount += 1;
        strayList.push(`${k} @ atSample ${e.atSample}`);
      } else {
        running.set(k, cur - 1);
      }
    }
  }
  let hangingCount = 0;
  const hangingList: string[] = [];
  for (const [k, c] of running) {
    if (c > 0) {
      hangingCount += c;
      hangingList.push(`${k} × ${c}`);
    }
  }
  const failures: string[] = [];
  if (hangingCount > allowed) {
    failures.push(
      `${hangingCount} hanging noteOn (= no matching noteOff) > allowed ${allowed} [${hangingList.join(", ")}]`,
    );
  }
  if (strayCount > 0) {
    failures.push(
      `${strayCount} stray noteOff (= no in-flight noteOn at event time) [${strayList.join(", ")}]`,
    );
  }
  if (failures.length > 0) {
    throw new Error(`expectMidiBalance: port '${portName}' ${failures.join("; ")}`);
  }
}

/**
 * snapshot blob を 内 部 で `inspect` (= `docs/05-client.md` §2.6) し て 1
 * slot 値 取 得 + assert。
 *
 * chain 形 = `expect(result).toHaveStateValue(slotName, expectedValue)` (= `@unworklet/test/extend`)。
 */
export function expectStateValue(
  _result: RenderOfflineResult,
  _slotName: string,
  _expectedValue: number | boolean,
): void {
  notImplemented();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━ signal utility (= 7 件) ━━━━━━━━━━━━━━━━━━━━━━━

export type SineOpts = {
  freqHz: number;
  durationSamples: number;
  sampleRate: number;
  amplitude?: number;
  phase?: number;
};

/** 純 音 (= `amplitude` default `1`、 `phase` default `0` rad)。 */
export function sine(opts: SineOpts): Float32Array {
  const amplitude = opts.amplitude ?? 1;
  const phase = opts.phase ?? 0;
  const omega = (2 * Math.PI * opts.freqHz) / opts.sampleRate;
  const data = new Float32Array(opts.durationSamples);
  for (let i = 0; i < opts.durationSamples; i++) {
    data[i] = amplitude * Math.sin(omega * i + phase);
  }
  return data;
}

/** 全 0 の `Float32Array`。 */
export function silence(durationSamples: number): Float32Array {
  return new Float32Array(durationSamples);
}

/** 単 一 sample 1.0、 残 り 0 (= impulse response 入 力)。 `atSample` default `0`。 */
export function impulse(durationSamples: number, opts: { atSample?: number } = {}): Float32Array {
  const data = new Float32Array(durationSamples);
  const atSample = opts.atSample ?? 0;
  if (atSample >= 0 && atSample < durationSamples) data[atSample] = 1;
  return data;
}

export type SineSweepOpts = {
  startHz: number;
  endHz: number;
  durationSamples: number;
  sampleRate: number;
  type?: "lin" | "log";
  amplitude?: number;
};

/** 周 波 数 sweep (= EQ test 入 力)。 `type` default `'log'`。 */
export function sineSweep(opts: SineSweepOpts): Float32Array {
  const amplitude = opts.amplitude ?? 1;
  const type = opts.type ?? "log";
  const dt = 1 / opts.sampleRate;
  const data = new Float32Array(opts.durationSamples);
  let phase = 0;
  for (let i = 0; i < opts.durationSamples; i++) {
    const t = opts.durationSamples > 1 ? i / (opts.durationSamples - 1) : 0;
    const freq =
      type === "lin"
        ? opts.startHz + (opts.endHz - opts.startHz) * t
        : opts.startHz * (opts.endHz / opts.startHz) ** t;
    phase += 2 * Math.PI * freq * dt;
    data[i] = amplitude * Math.sin(phase);
  }
  return data;
}

export type WhiteNoiseOpts = {
  durationSamples: number;
  amplitude?: number;
  seed?: number;
};

/** 決 定 的 seed 経 由 white noise = test 再 現 性 担 保 (= xorshift32)。 */
export function whiteNoise(opts: WhiteNoiseOpts): Float32Array {
  const amplitude = opts.amplitude ?? 1;
  let s = (opts.seed ?? 1) | 0;
  if (s === 0) s = 1;
  const data = new Float32Array(opts.durationSamples);
  for (let i = 0; i < opts.durationSamples; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    data[i] = amplitude * (((s >>> 0) / 0xffffffff) * 2 - 1);
  }
  return data;
}

/** 定 数 信 号 (= DC gain test 等)。 `value` default `1`。 */
export function dc(durationSamples: number, value = 1): Float32Array {
  const data = new Float32Array(durationSamples);
  data.fill(value);
  return data;
}

export type RampOpts = {
  durationSamples: number;
  from: number;
  to: number;
};

/** 線 形 ramp (= gain ramp / param automation 模 倣)。 */
export function ramp(opts: RampOpts): Float32Array {
  const data = new Float32Array(opts.durationSamples);
  const denom = Math.max(1, opts.durationSamples - 1);
  const step = (opts.to - opts.from) / denom;
  for (let i = 0; i < opts.durationSamples; i++) {
    data[i] = opts.from + step * i;
  }
  return data;
}

// ━━━━━━━━━━━━━━━━━━━━━ stub: midi utility (= 10 件) ━━━━━━━━━━━━━━━━━━━━━━

export type MidiNoteOnOpts = { note: number; velocity: number; channel?: number };
export type MidiNoteOffOpts = { note: number; velocity?: number; channel?: number };
export type MidiCcOpts = { controller: number; value: number; channel?: number };
export type MidiPitchBendOpts = { value: number; channel?: number };
export type MidiProgramChangeOpts = { program: number; channel?: number };
export type MidiChannelPressureOpts = { pressure: number; channel?: number };
export type MidiAftertouchOpts = { note: number; pressure: number; channel?: number };
export type MidiSequenceEntry = { at: number; event: MidiEvent };

/**
 * MIDI event 構 築 namespace。 `MidiEvent` (= main-side、 `docs/11-midi.md`
 * §2.2) を 構 築 し て `renderOffline({ events })` の `payload` field に 渡
 * す path。 9 variants + `sequence` (= 配 列 一 括 構 築 で `OfflineEvent[]`
 * 返 し)。 `channel` default `0`、 `noteOff` の `velocity` default `0`。
 */
export const midi = {
  noteOn(opts: MidiNoteOnOpts): MidiEvent {
    return {
      type: "noteOn",
      channel: opts.channel ?? 0,
      note: opts.note,
      velocity: opts.velocity,
    };
  },
  noteOff(opts: MidiNoteOffOpts): MidiEvent {
    return {
      type: "noteOff",
      channel: opts.channel ?? 0,
      note: opts.note,
      velocity: opts.velocity ?? 0,
    };
  },
  cc(opts: MidiCcOpts): MidiEvent {
    return {
      type: "cc",
      channel: opts.channel ?? 0,
      controller: opts.controller,
      value: opts.value,
    };
  },
  pitchBend(opts: MidiPitchBendOpts): MidiEvent {
    return { type: "pitchBend", channel: opts.channel ?? 0, value: opts.value };
  },
  programChange(opts: MidiProgramChangeOpts): MidiEvent {
    return { type: "programChange", channel: opts.channel ?? 0, program: opts.program };
  },
  channelPressure(opts: MidiChannelPressureOpts): MidiEvent {
    return { type: "channelPressure", channel: opts.channel ?? 0, pressure: opts.pressure };
  },
  aftertouch(opts: MidiAftertouchOpts): MidiEvent {
    return {
      type: "aftertouch",
      channel: opts.channel ?? 0,
      note: opts.note,
      pressure: opts.pressure,
    };
  },
  systemRealtime(status: number): MidiEvent {
    return { type: "systemRealtime", status };
  },
  sysex(bytes: Uint8Array): MidiEvent {
    return { type: "sysex", data: bytes };
  },
  sequence(portName: string, events: MidiSequenceEntry[]): OfflineEvent[] {
    return events.map(({ at, event }) => ({ name: portName, payload: event, atSample: at }));
  },
};

// ━━━━━━━━━━━━━━━━━━━━━━ sample / time utility (= 6 件) ━━━━━━━━━━━━━━━━━━━━

/** `Division` literal union (= v1.0.0 core 6 件)。 */
export type Division = "1/1" | "1/2" | "1/4" | "1/8" | "1/16" | "1/32";

const DIVISION_FACTOR: Record<Division, number> = {
  "1/1": 4,
  "1/2": 2,
  "1/4": 1,
  "1/8": 0.5,
  "1/16": 0.25,
  "1/32": 0.125,
};

/** sample 数 → ms。 */
export function samplesToMs(samples: number, sampleRate: number): number {
  return (samples / sampleRate) * 1000;
}

/** ms → sample 数。 */
export function msToSamples(ms: number, sampleRate: number): number {
  return (ms * sampleRate) / 1000;
}

/** sample 数 → sec。 */
export function samplesToSec(samples: number, sampleRate: number): number {
  return samples / sampleRate;
}

/** sec → sample 数。 */
export function secToSamples(sec: number, sampleRate: number): number {
  return sec * sampleRate;
}

/** 拍 → sample 数 (= `(60 / bpm) * factor(division) * sampleRate`、 factor: 1/4 = 1 = 1 beat at given BPM)。 */
export function bpmToSamples(opts: {
  bpm: number;
  division: Division;
  sampleRate: number;
}): number {
  return (60 / opts.bpm) * DIVISION_FACTOR[opts.division] * opts.sampleRate;
}

/** 拍 → ms (= `(60 / bpm) * factor(division) * 1000`)。 */
export function bpmToMs(opts: { bpm: number; division: Division }): number {
  return (60 / opts.bpm) * DIVISION_FACTOR[opts.division] * 1000;
}
