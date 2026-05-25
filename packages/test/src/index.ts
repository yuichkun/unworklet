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

import { readFileSync } from "node:fs";
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
  snapshotPath?: string;
  tolerance?: number;
  port?: string;
};

const snapshotCounters = new Map<string, number>();

/**
 * Assert that `actual.outputs` matches a vitest-style auto-managed wav
 * snapshot (`docs/06-testing.md` §2.1)。 `opts.snapshotPath` 省 略 = 自 動
 * 推 論 (= `<test-file-dir>/__snapshots__/<test-file-name>__<test-name>__
 * <counter>.wav`)。 初 回 = wav 自 動 書 き 出 し + pass、 2 回 目 以 降 =
 * bit-exact 比 較、 `vitest -u` で 強 制 上 書 き、 CI mode = 不 在 で fail
 * (= vitest 標 準 `toMatchFileSnapshot` に 委 譲)。
 *
 * 単 一 port 専 用 (= 1 port な ら 推 論、 `opts.port` で 明 示 上 書 き、 多
 * port + `opts.port` 未 指 定 で throw)。 `actual.sampleRate` を wav header
 * に 書 く (= `13-offline-render.md` §2 で carry)。
 *
 * chain 形 = `await expect(actual).toMatchAudioSnapshot(opts?)` (= `@unworklet/test/extend`)。
 */
export async function expectAudioMatchesSnapshot(
  actual: RenderOfflineResult,
  opts: SnapshotOptions = {},
): Promise<void> {
  const ports = Object.keys(actual.outputs);
  let portName: string;
  if (opts.port !== undefined) {
    if (!(opts.port in actual.outputs)) {
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
  const channels = actual.outputs[portName]!;
  const wavBytes = encodeWav(channels, actual.sampleRate);

  let snapshotPath = opts.snapshotPath;
  if (snapshotPath === undefined) {
    const state = expect.getState();
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

  await expect(wavBytes).toMatchFileSnapshot(snapshotPath);
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

/**
 * Freq domain = 内 部 FFT 経 由 で `freqHz` 周 辺 の dB ゲ イ ン が
 * `expectedDb` ± `tolerance`。 EQ test の core (`docs/06-testing.md` §2.2)。
 *
 * chain 形 = `expect(result).toHaveGainAtFreq(freqHz, expectedDb, tolerance)` (= `@unworklet/test/extend`)。
 */
export function expectGainAtFreq(
  _result: RenderOfflineResult,
  _freqHz: number,
  _expectedDb: number,
  _tolerance: number,
): void {
  notImplemented();
}

/**
 * 入 力 impulse → 出 力 max abs index の delay sample 数 計 測 + assert。
 * lookahead processor の 設 計 latency 担 保。
 *
 * chain 形 = `expect(result).toHaveLatency(expectedSamples, opts?)` (= `@unworklet/test/extend`)。
 */
export function expectLatency(
  _result: RenderOfflineResult,
  _expectedSamples: number,
  _opts?: { tolerance?: number },
): void {
  notImplemented();
}

/**
 * 全 sample 平 均 値 (= DC bias) 絶 対 値 が `threshold` 未 満。 filter /
 * EQ の DC 振 る 舞 い 確 認。 channel ご と に 平 均 を 計 算、 ど の channel
 * の DC 絶 対 値 が threshold 以 上 で も throw。
 *
 * chain 形 = `expect(result).toHaveDcOffsetUnder(threshold)` (= `@unworklet/test/extend`)。
 */
export function expectDcOffsetUnder(result: RenderOfflineResult, threshold: number): void {
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
  _result: RenderOfflineResult,
  _name: string,
  _expectedCount: number,
): void {
  notImplemented();
}

/** `expectEventsContaining` の partial event shape。 */
export type PartialExpectedEvent = {
  name: string;
  payload?: unknown;
  atSample?: number;
};

/**
 * 部 分 一 致 (= `partial[i]` が `result.events` の ど こ か に exists)。 順
 * 不 同 + 余 計 な event 許 容。
 *
 * chain 形 = `expect(result).toContainEvents(partial)` (= `@unworklet/test/extend`)。
 */
export function expectEventsContaining(
  _result: RenderOfflineResult,
  _partial: PartialExpectedEvent[],
): void {
  notImplemented();
}

/** `expectMidiOut` で 渡 す MIDI event + 任 意 atSample。 */
export type ExpectedMidiEvent = MidiEvent & { atSample?: number };

/**
 * 特 定 `midiOutput({ name })` port 経 由 emit さ れ た MIDI event 列 を
 * `MidiEvent` 形 で 一 致 比 較 (= 内 部 で MIDI byte → `MidiEvent` decode)。
 *
 * chain 形 = `expect(result).toEmitMidi(portName, expectedMidiEvents, opts?)` (= `@unworklet/test/extend`)。
 */
export function expectMidiOut(
  _result: RenderOfflineResult,
  _portName: string,
  _expectedMidiEvents: ExpectedMidiEvent[],
  _opts?: { tolerance?: number },
): void {
  notImplemented();
}

/**
 * noteOn / noteOff pair が balance、 hanging note (= noteOn 後 noteOff
 * な し) が `opts.hangingNotes` (default `0`) 件 ま で 許 容。
 *
 * chain 形 = `expect(result).toHaveBalancedMidi(portName, opts?)` (= `@unworklet/test/extend`)。
 */
export function expectMidiBalance(
  _result: RenderOfflineResult,
  _portName: string,
  _opts?: { hangingNotes?: number },
): void {
  notImplemented();
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
 * 返 し)。
 */
export const midi = {
  noteOn(_opts: MidiNoteOnOpts): MidiEvent {
    return notImplemented();
  },
  noteOff(_opts: MidiNoteOffOpts): MidiEvent {
    return notImplemented();
  },
  cc(_opts: MidiCcOpts): MidiEvent {
    return notImplemented();
  },
  pitchBend(_opts: MidiPitchBendOpts): MidiEvent {
    return notImplemented();
  },
  programChange(_opts: MidiProgramChangeOpts): MidiEvent {
    return notImplemented();
  },
  channelPressure(_opts: MidiChannelPressureOpts): MidiEvent {
    return notImplemented();
  },
  aftertouch(_opts: MidiAftertouchOpts): MidiEvent {
    return notImplemented();
  },
  systemRealtime(_status: number): MidiEvent {
    return notImplemented();
  },
  sysex(_bytes: Uint8Array): MidiEvent {
    return notImplemented();
  },
  sequence(_portName: string, _events: MidiSequenceEntry[]): OfflineEvent[] {
    return notImplemented();
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
