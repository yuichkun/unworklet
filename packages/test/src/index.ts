/**
 * `@unworklet/test` — Vitest matchers + audio test utility for `@unworklet/core`
 * processors (`docs/06-testing.md` §2-§6).
 *
 * The plain function form (`expectAudioMatches(result, ...)`) throws an `Error`
 * on failure, which vitest catches and reports as a test failure. The chain form
 * (`expect(result).toMatchAudio(...)`) is registered separately via the
 * side-effect import of the `@unworklet/test/extend` subpath (§6, available
 * alongside the plain form).
 *
 * v1.0.0 ship surface: 20 matchers + 7 signal utilities + 10 MIDI utilities + 6
 * sample/time utilities + the chain form. The plain function form lives in this
 * module; the chain form is the side-effect import of the `@unworklet/test/extend`
 * subpath.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { MidiEvent } from "@unworklet/core";
import { decodeWav, encodeWav } from "@unworklet/offline";
import type { OfflineEmittedEvent, OfflineEvent, RenderOfflineResult } from "@unworklet/offline";
import { expect } from "vitest";

/**
 * What the audio matchers accept: a real `renderOffline` result, or a
 * hand-built result-shaped object. The matchers read outputs / events / state
 * / sampleRate only, so the render-health `diagnostics` block is optional here
 * — a fixture built in a test (a documented pattern) does not have to invent
 * one.
 */
export type RenderResultLike = Omit<RenderOfflineResult, "diagnostics"> &
  Partial<Pick<RenderOfflineResult, "diagnostics">>;

export type AudioMatchOptions = {
  /**
   * Sample-absolute-difference tolerance. Default `0` means bit-exact, because
   * `renderOffline` is designed to instantiate the same WASM binary on the same
   * host JS runtime for the same input, so identical input naturally yields
   * identical output.
   */
  tolerance?: number;
};

/** Single event entry expected by `expectEventsEqual`. */
export type ExpectedEvent = {
  name: string;
  payload: unknown;
  atSample: number;
};

/**
 * Asserts, with a `label` prefix, that every sample in a `Float32Array[]` is
 * finite (no NaN / ±Infinity). Shared helper that inspects the reference side
 * when `expectAudioMatches` receives its `expected` as a `Float32Array[]`, or
 * when `expectAudioMatchesGolden` decodes a golden, so that a corrupted golden
 * or a NaN fixture cannot pass falsely.
 */
const assertChannelsFinite = (label: string, channels: Float32Array[]): void => {
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c]!;
    for (let s = 0; s < ch.length; s++) {
      const v = ch[s]!;
      if (Number.isNaN(v)) {
        throw new Error(`${label}: channel ${c} sample ${s} is NaN`);
      }
      if (!Number.isFinite(v)) {
        const sign = v > 0 ? "+Infinity" : "-Infinity";
        throw new Error(`${label}: channel ${c} sample ${s} is ${sign}`);
      }
    }
  }
};

/**
 * Finite-check across all channels of `RenderOfflineResult.outputs`, raising a
 * `label`-prefixed error. `expectNoNaN` is implemented in terms of this, and the
 * `expected` side of `expectAudioMatches` also goes through this path when it is
 * a `RenderOfflineResult`.
 */
const assertResultFinite = (label: string, result: RenderResultLike): void => {
  for (const port of Object.keys(result.outputs)) {
    const channels = result.outputs[port]!;
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c]!;
      for (let s = 0; s < ch.length; s++) {
        const v = ch[s]!;
        if (Number.isNaN(v)) {
          throw new Error(`${label}: port '${port}' channel ${c} sample ${s} is NaN`);
        }
        if (!Number.isFinite(v)) {
          const sign = v > 0 ? "+Infinity" : "-Infinity";
          throw new Error(`${label}: port '${port}' channel ${c} sample ${s} is ${sign}`);
        }
      }
    }
  }
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
 * `opts.tolerance` (default `0`). `expected` has two shapes:
 * - `RenderOfflineResult` = multi-port comparison (the entire port set of
 *   `actual.outputs`), plus a `actual.sampleRate` vs `expected.sampleRate`
 *   equality check (identical PCM at a different rate is a pitch / timing bug,
 *   so matching PCM must not pass falsely).
 * - `Float32Array[]` = single-port inference (if `actual.outputs` has exactly
 *   one port, compare against that port's channels; with two or more ports it
 *   throws and points to the multi-port form). No sampleRate comparison is
 *   done, because a raw buffer carries no rate metadata — if the consumer is
 *   rate-sensitive, pass the full result form.
 *
 * Chain form: `expect(actual).toMatchAudio(expected, opts?)` (`@unworklet/test/extend`).
 */
export function expectAudioMatches(
  actual: RenderResultLike,
  expected: RenderResultLike | Float32Array[],
  opts?: AudioMatchOptions,
): void {
  // Reject NaN / ±Infinity input up front on both the actual and expected
  // sides, since `Math.abs(NaN) > tolerance` is `false` and would otherwise
  // pass falsely. Skipping the expected side is dangerous: a corrupted golden
  // or NaN fixture frozen into state would make later regressions look green.
  assertResultFinite("expectAudioMatches: actual", actual);
  const tolerance = opts?.tolerance ?? 0;
  if (Array.isArray(expected)) {
    const ports = Object.keys(actual.outputs);
    if (ports.length !== 1) {
      throw new Error(
        `expectAudioMatches: \`Float32Array[]\` expected requires single-port actual; actual has ${ports.length} ports (${ports.join(", ")}) — use the RenderOfflineResult form to specify per-port expected.`,
      );
    }
    assertChannelsFinite("expectAudioMatches: expected", expected);
    compareChannels(ports[0]!, actual.outputs[ports[0]!]!, expected, tolerance);
    return;
  }
  assertResultFinite("expectAudioMatches: expected", expected);
  if (actual.sampleRate !== expected.sampleRate) {
    throw new Error(
      `expectAudioMatches: sampleRate mismatch — actual=${actual.sampleRate}, expected=${expected.sampleRate} (pitch and timing scale with sample rate, so identical PCM at different rates is still a mismatch)`,
    );
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
 * Assert that `result.outputs` contains no NaN / ±Infinity samples.
 *
 * Chain form: `expect(result).toBeFinite()` (`@unworklet/test/extend`).
 */
export function expectNoNaN(result: RenderResultLike): void {
  assertResultFinite("expectNoNaN", result);
}

const linearToDb = (linear: number): number => 20 * Math.log10(linear);

/**
 * Assert peak amplitude below the given dBFS threshold.
 *
 * Chain form: `expect(result).toHavePeakUnder(dbfs)` (`@unworklet/test/extend`).
 */
export function expectPeakUnder(result: RenderResultLike, dbfs: number): void {
  // Since `Math.abs(NaN) > peak` is `false`, peak would stay 0 and db would be
  // -Infinity, falling below the threshold and passing falsely; reject NaN first
  // to close that path.
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
 * Assert RMS amplitude below the given dBFS threshold (the root mean square of
 * the squared samples across all channels).
 *
 * Chain form: `expect(result).toHaveRmsUnder(dbfs)` (`@unworklet/test/extend`).
 */
export function expectRmsUnder(result: RenderResultLike, dbfs: number): void {
  // A NaN mixed into sumSq makes rms NaN, and `NaN >= dbfs` is `false`, which
  // would pass falsely.
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
 * Assert emitted events (name + payload + atSample) match the expected sequence.
 *
 * Chain form: `expect(result).toMatchEvents(expectedEvents)` (`@unworklet/test/extend`).
 */
export function expectEventsEqual(result: RenderResultLike, expectedEvents: ExpectedEvent[]): void {
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
 * (`'persistent'` slot only, Q5 format). Transient slots are observed through
 * the audio output and detected via `expectAudioMatches`.
 *
 * Chain form: `expect(result).toMatchState(expectedSnapshot)` (`@unworklet/test/extend`).
 */
export function expectStateMatches(result: RenderResultLike, expectedSnapshot: Uint8Array): void {
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
 * `wavPath` (`docs/06-testing.md` §2.1 + §7). Single-port only — for multi-port
 * results, be explicit with `expectAudioMatches(actual, fullResult)`. The WAV
 * header's `sampleRate` is always compared against `actual.sampleRate`, and a
 * mismatch throws, closing the path where identical PCM at a different rate
 * would let a pitch / timing bug through.
 *
 * Chain form: `expect(actual).toMatchAudioFile(wavPath, opts?)` (`@unworklet/test/extend`).
 */
export function expectAudioMatchesGolden(
  actual: RenderResultLike,
  wavPath: string,
  opts?: AudioMatchOptions,
): void {
  const bytes = readFileSync(wavPath);
  const decoded = decodeWav(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (decoded.sampleRate !== actual.sampleRate) {
    throw new Error(
      `expectAudioMatchesGolden: sampleRate mismatch — actual=${actual.sampleRate}, wav '${wavPath}'=${decoded.sampleRate} (even when the PCM matches, a different rate shifts pitch and timing)`,
    );
  }
  expectAudioMatches(actual, decoded.channels, opts);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━ matcher: golden / snapshot / peak / EQ ━━━━━━━━━━━━━━━━━━━━━━━━

export type SnapshotOptions = {
  /** Overrides the full path so the consumer fully controls both directory and filename. Omitting this together with `snapshotName` triggers auto-inference based on the test name. */
  snapshotPath?: string;
  /** Overrides only the test-name portion of the filename (`<test-file-base>__<safe(snapshotName)>.wav`, with no counter — the consumer is responsible for unique naming). Keeps the test name free for descriptive text while making the filename cleaner. When `snapshotPath` is set, that takes precedence. */
  snapshotName?: string;
  /** Sample rate written into the WAV header when `actual` is passed as a `Float32Array` / `Float32Array[]` (default `48000`). Ignored when a `RenderOfflineResult` is passed, in which case `result.sampleRate` takes precedence. */
  sampleRate?: number;
  tolerance?: number;
  port?: string;
};

const snapshotCounters = new Map<string, number>();
const snapshotTestBoundary: { lastKey: string | undefined } = { lastKey: undefined };

/**
 * Turns a string into a filename-safe form. ASCII alphanumerics are kept as-is,
 * and Unicode (Japanese and the like) is preserved as well; filesystem-unsafe
 * characters (`/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`) and whitespace are
 * collapsed to `_`, and leading / trailing `_` are trimmed. Sanitizing Unicode
 * down to ASCII-only once caused a regression where a non-ASCII name like "Тест"
 * became "" and a
 * `.wav` (a hidden dotfile) was created, so this preserves Unicode instead.
 */
const sanitizeForFilename = (name: string): string => {
  // Control characters (\x00-\x1f) are also filesystem-unsafe, so reject them explicitly.
  // eslint-disable-next-line no-control-regex
  return name.replace(/[/\\:*?"<>|\s\x00-\x1f]+/g, "_").replace(/^_+|_+$/g, "");
};

/**
 * FNV-1a 32-bit hash (8 hex digits). Appended to auto-inferred filenames to give
 * collision resistance, so that distinct test names that sanitize to the same
 * slug (for example "foo bar" and "foo!bar" both become "foo_bar") resolve to
 * different paths.
 */
const shortHash = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};

/**
 * Per-test state (a subset of vitest's `MatcherState`). The chain form receives
 * per-test bound state via `this` inside `expect.extend(...)`, so there is no
 * race even with concurrent tests; the plain form reads it from the global
 * `expect.getState()` (sequential use only — concurrent use risks cross-test
 * interference).
 *
 * `_unworkletCounters` is the expando field for the counter Map used by the
 * auto-inference path. The chain form attaches a fresh Map to `this` (the
 * per-test-invocation MatcherState) and carries it, so it resets naturally per
 * invocation and there is no counter drift across vitest retries / watch reruns.
 * The plain form leaves this field unset and falls back to the module-global Map
 * (the sequential path).
 */
export type SnapshotResolutionState = {
  testPath?: string;
  currentTestName?: string;
  snapshotState?: { _updateSnapshot?: string };
  _unworkletCounters?: Map<string, number>;
};

const resolveSnapshotPath = (state: SnapshotResolutionState, opts: SnapshotOptions): string => {
  if (opts.snapshotPath !== undefined) {
    return opts.snapshotPath;
  }
  if (opts.snapshotName !== undefined) {
    // Explicit `snapshotName` path: compute `__snapshots__/<safe(snapshotName)>.wav`
    // directly (no test-file-base prefix and no counter — the consumer is
    // responsible for unique naming, and this is independent of the test name, so
    // the test description stays free). A name that sanitizes to empty (entirely
    // filesystem-unsafe / whitespace, e.g. "??") throws rather than creating a
    // hidden `.wav`.
    if (!state.testPath) {
      throw new Error(
        `expectAudioMatchesSnapshot: computing the opts.snapshotName path requires testPath; pass opts.snapshotPath explicitly to override.`,
      );
    }
    const safeName = sanitizeForFilename(opts.snapshotName);
    if (safeName.length === 0) {
      throw new Error(
        `expectAudioMatchesSnapshot: opts.snapshotName "${opts.snapshotName}" sanitizes to empty filename (no filesystem-safe characters); pass opts.snapshotPath explicitly, or use a name containing alphanumeric / Unicode characters.`,
      );
    }
    return join(dirname(state.testPath), "__snapshots__", `${safeName}.wav`);
  }
  if (!state.testPath || !state.currentTestName) {
    throw new Error(
      `expectAudioMatchesSnapshot: snapshot path auto-infer requires testPath + currentTestName; pass opts.snapshotPath explicitly to override.`,
    );
  }
  const dir = dirname(state.testPath);
  const base = basename(state.testPath, extname(state.testPath));
  const safeName = sanitizeForFilename(state.currentTestName);
  const key = `${state.testPath}::${state.currentTestName}`;
  // Counter source: the chain form brings its own `state._unworkletCounters`
  // (a per-test-invocation Map bound to MatcherState), so it resets naturally on
  // retry / watch and never drifts. The plain form leaves it unset and falls back
  // to the module-global Map plus a boundary heuristic (reset only when moving to
  // a different test); repeated invocations within the same test drift, so
  // docs §2.1 recommends an explicit snapshotName or the chain form.
  const counterMap = state._unworkletCounters ?? snapshotCounters;
  if (counterMap === snapshotCounters && snapshotTestBoundary.lastKey !== key) {
    snapshotCounters.delete(key);
    snapshotTestBoundary.lastKey = key;
  }
  const counter = (counterMap.get(key) ?? 0) + 1;
  counterMap.set(key, counter);
  // If the sanitize result is empty, use a "_" placeholder plus the hash to keep
  // them distinct (a safety net so an entirely-unsafe test name never creates a
  // hidden file). Normal test names contain ASCII / Unicode, so safeName is
  // non-empty.
  const slug = safeName.length > 0 ? safeName : "_";
  const hash = shortHash(state.currentTestName);
  return join(dir, "__snapshots__", `${base}__${slug}_${hash}__${counter}.wav`);
};

/**
 * State-explicit internal worker. The chain form passes `this` (the per-test
 * bound `MatcherState`); the plain form passes the `expect.getState()` global.
 * All path and update-mode resolution goes through `state`, removing the
 * dependency on global state and providing a concurrent-safe path for the chain
 * form.
 */
export async function expectAudioMatchesSnapshotWithState(
  actual: RenderResultLike | Float32Array | Float32Array[],
  opts: SnapshotOptions,
  state: SnapshotResolutionState,
): Promise<void> {
  // Normalize actual: a Float32Array / Float32Array[] is wrapped into RenderOfflineResult form.
  let result: RenderResultLike;
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

  // Reject NaN / ±Infinity samples first: if a broken wav is snapshotted on the
  // initial write, it would keep passing bit-exact afterwards and hide a
  // catastrophic DSP failure.
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

  const snapshotPath = resolveSnapshotPath(state, opts);

  // Read the update / CI mode from vitest snapshot state (the jest-compatible
  // `_updateSnapshot`: "all" = `-u`, "new" = default, write when missing, and
  // "none" = `--ci`, fail when missing). vitest's built-in toMatchFileSnapshot
  // serializes Uint8Array as text JSON and never produces a playable wav binary,
  // so this takes its own fs API path.
  const updateMode = state.snapshotState?._updateSnapshot ?? "new";
  const exists = existsSync(snapshotPath);

  if (!exists) {
    if (updateMode === "none") {
      throw new Error(
        `expectAudioMatchesSnapshot: snapshot file does not exist at ${snapshotPath} (vitest --ci mode cannot create new snapshots)`,
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
  // Maintain the Promise<void> return: the API is async, and the internal
  // synchronous I/O is cosmetic.
  return Promise.resolve();
}

/**
 * Assert that `actual` matches a vitest-style auto-managed wav snapshot
 * (`docs/06-testing.md` §2.1). `actual` has three shapes:
 * - `RenderOfflineResult` = the usual path; sample rate comes from `actual.sampleRate`
 * - `Float32Array` = a mono single channel directly, encoded to wav at
 *   `opts.sampleRate` (default `48000`) — the path for passing a signal
 *   generator's output and the like without wrapping
 * - `Float32Array[]` = multiple channels directly, encoded the same way
 *
 * Path resolution precedence:
 * 1. Explicit `opts.snapshotPath` = full-path override
 * 2. Explicit `opts.snapshotName` = `<test-file-dir>/__snapshots__/<safe(snapshotName)>.wav` (no test-file-base prefix and no counter; the consumer is responsible for unique naming)
 * 3. Both omitted = auto-infer = `<test-file-dir>/__snapshots__/<test-file-base>__<safe(test-name)>__<counter>.wav` (the test name is inferred automatically, so a prefix + counter are required to prevent collisions)
 *
 * On the first run the wav is written automatically and the assertion passes;
 * subsequent runs do a bit-exact comparison. `vitest -u` forces an overwrite,
 * and CI mode fails when the snapshot is missing (the update / CI mode is
 * decided via vitest snapshot state).
 *
 * Single-port only (inferred when there is one port, overridden explicitly via
 * `opts.port`, and a throw for multi-port without `opts.port`).
 *
 * Concurrent-test caveat: the plain function form reads the `expect.getState()`
 * global, so under `test.concurrent` it may pick up another test's testName /
 * counter — it is a sequential-only path. When used under concurrency, use the
 * `expect(actual).toMatchAudioSnapshot(opts?)` chain form
 * (`@unworklet/test/extend`), which avoids the race via `expect.extend`'s bound
 * matcher state (per-test `this.testPath` / `this.currentTestName`). Alternatively,
 * setting `opts.snapshotPath` explicitly skips the auto-infer path and is
 * concurrent-safe (zero state reads).
 *
 * Chain form: `await expect(actual).toMatchAudioSnapshot(opts?)` (`@unworklet/test/extend`).
 */
export async function expectAudioMatchesSnapshot(
  actual: RenderResultLike | Float32Array | Float32Array[],
  opts: SnapshotOptions = {},
): Promise<void> {
  // Plain form: via the global `expect.getState()`, a sequential-only path
  // (under concurrency, prefer the chain form, which carries bound state).
  return expectAudioMatchesSnapshotWithState(
    actual,
    opts,
    expect.getState() as unknown as SnapshotResolutionState,
  );
}

/**
 * One-line wrapper for "no NaN and every sample finite" (no divergence). A
 * stability sanity check for IIR feedback / long renders (`docs/06-testing.md`
 * §2.2). Audio level is not considered, so it passes even when clipping.
 *
 * Chain form: `expect(result).toBeStable()` (`@unworklet/test/extend`).
 */
export function expectStable(result: RenderResultLike): void {
  expectNoNaN(result);
}

export type MasterOptions = {
  peakDbfs?: number;
  rmsDbfs?: number;
};

/**
 * One-line wrapper for a default master-bus check: no NaN, peak < `opts.peakDbfs`
 * (default `-0.1`), and RMS < `opts.rmsDbfs` (default `-14`). `expectStable` ⊂
 * `expectMaster` (master includes stability plus clip / excessive-loudness
 * detection). The NaN check is always on (every numerical matcher guards itself
 * uniformly, and the underlying `expectPeakUnder` / `expectRmsUnder` also check
 * unconditionally).
 *
 * Chain form: `expect(result).toBeMasterReady(opts?)` (`@unworklet/test/extend`).
 */
export function expectMaster(result: RenderResultLike, opts: MasterOptions = {}): void {
  const peakDbfs = opts.peakDbfs ?? -0.1;
  const rmsDbfs = opts.rmsDbfs ?? -14;
  expectNoNaN(result);
  expectPeakUnder(result, peakDbfs);
  expectRmsUnder(result, rmsDbfs);
}

/**
 * Every sample is 0 within tolerance (default `0` = bit-exact silence). For a
 * pure MIDI processor, mute, the moment right after startup, and similar cases.
 *
 * Chain form: `expect(result).toBeSilent(opts?)` (`@unworklet/test/extend`).
 */
export function expectSilence(result: RenderResultLike, opts: { tolerance?: number } = {}): void {
  // Since `Math.abs(NaN) > tolerance` is `false`, a NaN sample would pass falsely
  // as silence; reject NaN first to close that path.
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
 * Time domain: the index of the maximum absolute value is within
 * `expectedAtSample` ± `opts.tolerance` (in samples). For the envelope attack
 * peak, the impulse-response peak position, and similar cases. The port is
 * either `opts.port` explicitly or inferred for a single port (multi-port
 * without one throws).
 *
 * Chain form: `expect(result).toHavePeakAtSample(expectedAtSample, opts?)` (`@unworklet/test/extend`).
 */
export function expectPeakAtSample(
  result: RenderResultLike,
  expectedAtSample: number,
  opts: PeakAtSampleOptions = {},
): void {
  // If NaN is present, every max-abs comparison is false and maxIdx stays at its
  // initial value (-1 / 0), which would pass falsely; reject NaN first.
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
  // An all-zero buffer has maxAbs 0 and leaves maxIdx at 0, which would pass
  // falsely when `expectedAtSample === 0`; fail a silent buffer explicitly so a
  // mute / non-responding-processor regression is caught.
  if (maxAbs <= 0) {
    throw new Error(
      `expectPeakAtSample: port '${portName}' has no detectable response (max abs ${maxAbs}) = silent buffer = cannot infer peak index`,
    );
  }
  if (Math.abs(maxIdx - expectedAtSample) > tolerance) {
    throw new Error(
      `expectPeakAtSample: port '${portName}' peak index ${maxIdx} (= max abs ${maxAbs}) not within ±${tolerance} of expected ${expectedAtSample}`,
    );
  }
}

/** Next power of 2 (for the FFT input size). */
const nextPow2 = (n: number): number => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

/**
 * In-place radix-2 Cooley-Tukey FFT (the internal FFT used by `expectGainAtFreq`).
 * Input: `real` / `imag` (equal length, with a length that is a power of two);
 * output is written in place.
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

export type GainAtFreqOptions = {
  /**
   * The channel index to analyze for multichannel input (ignored for a
   * single-channel port). When `result.outputs[port]` has two or more channels
   * and `channel` is unspecified, it throws to prevent a blind spot, forcing the
   * consumer to choose explicitly; a single-channel port defaults to `0`. Out of
   * range throws.
   */
  channel?: number;
};

/**
 * Frequency domain: via the internal FFT, the dB gain around `freqHz` is within
 * `expectedDb` ± `tolerance`. The core of EQ tests (`docs/06-testing.md` §2.2).
 * Single-port inference (multi-port throws); the channel is ch 0 for a single
 * channel, and `opts.channel` is required for multiple channels (unspecified
 * throws, to prevent a silent blind spot). FFT size: the input is zero-padded to
 * the next power of two; freqHz → bin = round(freqHz × N / sampleRate);
 * magnitude = 2 × sqrt(re² + im²) / L (normalized by the original signal length
 * `ch.length`, since the zero-padded part contributes 0 to the DFT sum so the
 * amplitude is proportional to L only); dB = 20 × log10(magnitude).
 *
 * Chain form: `expect(result).toHaveGainAtFreq(freqHz, expectedDb, tolerance, opts?)` (`@unworklet/test/extend`).
 */
export function expectGainAtFreq(
  result: RenderResultLike,
  freqHz: number,
  expectedDb: number,
  tolerance: number,
  opts: GainAtFreqOptions = {},
): void {
  // Running NaN through the FFT makes magnitude / db NaN, and
  // `Math.abs(NaN - expectedDb) > tolerance` is `false`, which would pass falsely;
  // reject NaN first.
  expectNoNaN(result);
  const ports = Object.keys(result.outputs);
  if (ports.length !== 1) {
    throw new Error(
      `expectGainAtFreq: single-port result expected; got ports=[${ports.join(", ")}]`,
    );
  }
  const portName = ports[0]!;
  const channels = result.outputs[portName]!;
  let channelIdx: number;
  if (opts.channel !== undefined) {
    if (opts.channel < 0 || opts.channel >= channels.length) {
      throw new Error(
        `expectGainAtFreq: opts.channel ${opts.channel} out of range for port '${portName}' (channels=${channels.length})`,
      );
    }
    channelIdx = opts.channel;
  } else if (channels.length === 1) {
    channelIdx = 0;
  } else {
    throw new Error(
      `expectGainAtFreq: multichannel port '${portName}' (channels=${channels.length}) requires opts.channel; explicit choice prevents silent blind spot on non-first channels`,
    );
  }
  const ch = channels[channelIdx]!;
  if (ch.length === 0) {
    throw new Error(`expectGainAtFreq: port '${portName}' channel ${channelIdx} is empty`);
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
  // Mitigate spectral leakage by taking the max magnitude over bin ± 1, so that
  // when freqHz does not land exactly on a bin center, the adjacent bins rescue
  // the otherwise-underestimated amplitude.
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
      `expectGainAtFreq: port '${portName}' channel ${channelIdx} bin ${bin} (= ${freqHz} Hz) gain ${db.toFixed(3)} dB not within ±${tolerance} of expected ${expectedDb} dB`,
    );
  }
}

/**
 * Measures and asserts the delay, in samples, between the input impulse and the
 * max-abs index of the output. Guarantees the designed latency of a lookahead
 * processor. Single-port inference; the channel is ch 0 for a single channel,
 * and `opts.channel` is required for multiple channels (unspecified throws, to
 * prevent a silent blind spot). The consumer passes the result of running
 * renderOffline with an impulse input.
 *
 * Chain form: `expect(result).toHaveLatency(expectedSamples, opts?)` (`@unworklet/test/extend`).
 */
export function expectLatency(
  result: RenderResultLike,
  expectedSamples: number,
  opts: { tolerance?: number; channel?: number } = {},
): void {
  // If NaN is present, every max-abs comparison is false and maxIdx stays at its
  // initial value (-1), which would pass falsely; reject NaN first.
  expectNoNaN(result);
  const tolerance = opts.tolerance ?? 0;
  const ports = Object.keys(result.outputs);
  if (ports.length !== 1) {
    throw new Error(`expectLatency: single-port result expected; got ports=[${ports.join(", ")}]`);
  }
  const portName = ports[0]!;
  const channels = result.outputs[portName]!;
  let channelIdx: number;
  if (opts.channel !== undefined) {
    if (opts.channel < 0 || opts.channel >= channels.length) {
      throw new Error(
        `expectLatency: opts.channel ${opts.channel} out of range for port '${portName}' (channels=${channels.length})`,
      );
    }
    channelIdx = opts.channel;
  } else if (channels.length === 1) {
    channelIdx = 0;
  } else {
    throw new Error(
      `expectLatency: multichannel port '${portName}' (channels=${channels.length}) requires opts.channel; explicit choice prevents silent blind spot on non-first channels`,
    );
  }
  const ch = channels[channelIdx]!;
  let maxAbs = -1;
  let maxIdx = -1;
  for (let s = 0; s < ch.length; s++) {
    const abs = Math.abs(ch[s]!);
    if (abs > maxAbs) {
      maxAbs = abs;
      maxIdx = s;
    }
  }
  // An all-zero buffer has maxAbs 0 and leaves maxIdx at 0, which would pass
  // falsely when `expectedSamples === 0`; fail a silent buffer explicitly so a
  // non-responding lookahead-processor regression is caught.
  if (maxAbs <= 0) {
    throw new Error(
      `expectLatency: port '${portName}' channel ${channelIdx} has no detectable response (max abs ${maxAbs}) = silent buffer = cannot infer delay`,
    );
  }
  if (Math.abs(maxIdx - expectedSamples) > tolerance) {
    throw new Error(
      `expectLatency: port '${portName}' channel ${channelIdx} detected delay ${maxIdx} sample (= max abs ${maxAbs}) not within ±${tolerance} of expected ${expectedSamples}`,
    );
  }
}

/**
 * The absolute value of the mean of all samples (the DC bias) is below
 * `threshold`. Checks the DC behavior of a filter / EQ. The mean is computed
 * per channel, and it throws if any channel's absolute DC value is at or above
 * the threshold.
 *
 * Chain form: `expect(result).toHaveDcOffsetUnder(threshold)` (`@unworklet/test/extend`).
 */
export function expectDcOffsetUnder(result: RenderResultLike, threshold: number): void {
  // A NaN mixed into the sum makes the mean NaN, and `NaN >= threshold` is
  // `false`, which would pass falsely.
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
 * The number of events with a given name matches (order / payload are ignored).
 *
 * Chain form: `expect(result).toHaveEventCount(name, expectedCount)` (`@unworklet/test/extend`).
 */
export function expectEventCount(
  result: RenderResultLike,
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

/** The partial event shape for `expectEventsContaining`. */
export type PartialExpectedEvent = {
  name: string;
  payload?: unknown;
  atSample?: number;
};

/**
 * Partial match: each `partial[i]` exists somewhere in `result.events`. Order is
 * irrelevant and extra events are allowed. Omitting `payload` / `atSample` means
 * that field is not compared (matching on name alone is enough).
 *
 * Chain form: `expect(result).toContainEvents(partial)` (`@unworklet/test/extend`).
 */
export function expectEventsContaining(
  result: RenderResultLike,
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

/** A MIDI event passed to `expectMidiOut`, plus an optional atSample. */
export type ExpectedMidiEvent = MidiEvent & { atSample?: number };

/**
 * Compares the sequence of MIDI events emitted through a specific
 * `event.midi({ to: 'main', name })` port against an expected sequence in
 * `MidiEvent` form. Filters `result.events` to `name === portName`, treats each
 * payload as a `MidiEvent`, and deep-compares order + type + all fields; for
 * atSample, omitting `expected.atSample` zips it to the actual value, while an
 * explicit value is compared within ± `opts.tolerance` (default 0).
 *
 * Chain form: `expect(result).toEmitMidi(portName, expectedMidiEvents, opts?)` (`@unworklet/test/extend`).
 */
export function expectMidiOut(
  result: RenderResultLike,
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
    // Deep-compare the payload (all MidiEvent fields except atSample).
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
 * noteOn / noteOff pairs are balanced, with up to `opts.hangingNotes` (default
 * `0`) hanging notes allowed (a noteOn with no following noteOff). A stray
 * noteOff (a noteOff with no in-flight noteOn for its (channel, note) at the
 * time it appears — a lifecycle inversion, or two or more noteOffs for one
 * noteOn) always fails: a stray is always a bug in the MIDI lifecycle, so there
 * is no tolerance option. Walks the events in time order, tracking a running
 * counter per (channel, note); when a noteOff arrives with cur ≤ 0, it is
 * immediately counted as stray, detecting "noteOff → noteOn (net 0)" and
 * "noteOn 1 → noteOff 2" in an order-sensitive way (closing false passes that a
 * final-sum path would miss).
 *
 * Chain form: `expect(result).toHaveBalancedMidi(portName, opts?)` (`@unworklet/test/extend`).
 */
export function expectMidiBalance(
  result: RenderResultLike,
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━ signal utility (7 total) ━━━━━━━━━━━━━━━━━━━━━━━

export type SineOpts = {
  freqHz: number;
  durationSamples: number;
  sampleRate: number;
  amplitude?: number;
  phase?: number;
};

/** A pure tone (`amplitude` default `1`, `phase` default `0` rad). */
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

/** An all-zero `Float32Array`. */
export function silence(durationSamples: number): Float32Array {
  return new Float32Array(durationSamples);
}

/** A single sample of 1.0 with the rest 0 (an impulse-response input). `atSample` default `0`. */
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

/** A frequency sweep (an EQ-test input). `type` default `'log'`. */
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

/** White noise from a deterministic seed (xorshift32), so tests stay reproducible. */
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

/** A constant signal (for DC-gain tests and the like). `value` default `1`. */
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

/** A linear ramp (mimicking a gain ramp / param automation). */
export function ramp(opts: RampOpts): Float32Array {
  const data = new Float32Array(opts.durationSamples);
  const denom = Math.max(1, opts.durationSamples - 1);
  const step = (opts.to - opts.from) / denom;
  for (let i = 0; i < opts.durationSamples; i++) {
    data[i] = opts.from + step * i;
  }
  return data;
}

// ━━━━━━━━━━━━━━━━━━━━━ midi utility: event constructors + sequence ━━━━━━━━━━━━━━━━━━━━━━

export type MidiNoteOnOpts = { note: number; velocity: number; channel?: number };
export type MidiNoteOffOpts = { note: number; velocity?: number; channel?: number };
export type MidiCcOpts = { controller: number; value: number; channel?: number };
export type MidiPitchBendOpts = { value: number; channel?: number };
export type MidiProgramChangeOpts = { program: number; channel?: number };
export type MidiChannelPressureOpts = { pressure: number; channel?: number };
export type MidiAftertouchOpts = { note: number; pressure: number; channel?: number };
export type MidiSequenceEntry = { at: number; event: MidiEvent };

/**
 * A namespace for constructing MIDI events. Builds a `MidiEvent` (main-side,
 * `docs/11-midi.md` §2.2) to pass into the `payload` field of
 * `renderOffline({ events })`. 9 variants plus `sequence` (which builds a whole
 * array at once and returns `OfflineEvent[]`). `channel` defaults to `0`, and
 * `noteOff`'s `velocity` defaults to `0`.
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

// ━━━━━━━━━━━━━━━━━━━━━━ sample / time utility (6 total) ━━━━━━━━━━━━━━━━━━━━

/** The `Division` literal union (the 6 in v1.0.0 core). */
export type Division = "1/1" | "1/2" | "1/4" | "1/8" | "1/16" | "1/32";

const DIVISION_FACTOR: Record<Division, number> = {
  "1/1": 4,
  "1/2": 2,
  "1/4": 1,
  "1/8": 0.5,
  "1/16": 0.25,
  "1/32": 0.125,
};

/** Samples → ms. */
export function samplesToMs(samples: number, sampleRate: number): number {
  return (samples / sampleRate) * 1000;
}

/** ms → samples. */
export function msToSamples(ms: number, sampleRate: number): number {
  return (ms * sampleRate) / 1000;
}

/** Samples → sec. */
export function samplesToSec(samples: number, sampleRate: number): number {
  return samples / sampleRate;
}

/** sec → samples. */
export function secToSamples(sec: number, sampleRate: number): number {
  return sec * sampleRate;
}

/** Beats → samples (`(60 / bpm) * factor(division) * sampleRate`; factor: 1/4 = 1 = 1 beat at the given BPM). */
export function bpmToSamples(opts: {
  bpm: number;
  division: Division;
  sampleRate: number;
}): number {
  return (60 / opts.bpm) * DIVISION_FACTOR[opts.division] * opts.sampleRate;
}

/** Beats → ms (`(60 / bpm) * factor(division) * 1000`). */
export function bpmToMs(opts: { bpm: number; division: Division }): number {
  return (60 / opts.bpm) * DIVISION_FACTOR[opts.division] * 1000;
}
