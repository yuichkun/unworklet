/**
 * `@unworklet/test` matcher + utility behavior (= `docs/06-testing.md` §2-§6).
 * TDD rule: behavior-based tests written first, then implementation filled in.
 * Each export gets a happy-path test followed by a fail-path test.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeWav } from "@unworklet/offline";
import type { RenderResultLike } from "./index.ts";
import { expect, test } from "vite-plus/test";

import {
  bpmToMs,
  bpmToSamples,
  dc,
  expectAudioMatches,
  expectAudioMatchesGolden,
  expectAudioMatchesSnapshot,
  expectAudioMatchesSnapshotWithState,
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

const monoResult = (channel: Float32Array, portName = "main"): RenderResultLike => ({
  outputs: { [portName]: [channel] },
  events: [],
  state: new Uint8Array(0),
  sampleRate: 48000,
});

const stereoResult = (left: Float32Array, right: Float32Array): RenderResultLike => ({
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

test("`expectAudioMatches`: multi-port actual + `Float32Array[]` expected throws (= ambiguous port)", () => {
  const result: RenderResultLike = {
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

test("`expectAudioMatches`: full result form port set mismatch throws (= expected port missing)", () => {
  const a = monoResult(filled(8, 0.5), "main");
  const b = monoResult(filled(8, 0.5), "send");
  expect(() => expectAudioMatches(a, b)).toThrow(/port/);
});

test("`expectAudioMatches`: full result form port count mismatch throws (= actual has more ports)", () => {
  const a: RenderResultLike = {
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

test("`expectAudioMatches`: tolerance default = 0 = bit-exact (= even tiny diff fails)", () => {
  const a = monoResult(new Float32Array([0.5]));
  const b = monoResult(new Float32Array([0.5000001]));
  expect(() => expectAudioMatches(a, b)).toThrow(/diff/);
});

test("`expectAudioMatches`: sampleRate mismatch = throw (= same PCM / different rate catches pitch and timing bugs)", () => {
  const sameData = new Float32Array([0.1, 0.2, 0.3]);
  const a: RenderResultLike = {
    outputs: { main: [sameData] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  const b: RenderResultLike = {
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

test("`expectNoNaN`: scans all ports and all channels", () => {
  const ch0 = filled(8, 0.5);
  const ch1 = filled(8, 0.5);
  ch1[5] = NaN; // target for detection
  const result: RenderResultLike = {
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

test("`expectPeakUnder`: negative values detected via abs (= -1.0 is also 0 dBFS)", () => {
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
  const empty: RenderResultLike = {
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
  const result: RenderResultLike = {
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
  const result: RenderResultLike = {
    outputs: {},
    events: [{ name: "peak", payload: {}, atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectEventsEqual(result, [])).toThrow(/length/);
});

test("`expectEventsEqual`: name mismatch throws", () => {
  const result: RenderResultLike = {
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
  const result: RenderResultLike = {
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
  const result: RenderResultLike = {
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
  const result: RenderResultLike = {
    outputs: {},
    events: [],
    state: new Uint8Array([1, 2, 3, 4]),
    sampleRate: 48000,
  };
  expect(() => expectStateMatches(result, new Uint8Array([1, 2, 3, 4]))).not.toThrow();
});

test("`expectStateMatches`: length mismatch throws", () => {
  const result: RenderResultLike = {
    outputs: {},
    events: [],
    state: new Uint8Array([1, 2, 3]),
    sampleRate: 48000,
  };
  expect(() => expectStateMatches(result, new Uint8Array([1, 2]))).toThrow(/length/);
});

test("`expectStateMatches`: byte content mismatch throws", () => {
  const result: RenderResultLike = {
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

test("`expectAudioMatchesGolden`: sampleRate mismatch = throw (= same PCM / different rate catches pitch and timing bugs)", () => {
  // wav written at 44.1k, compared against actual at 48k = mismatch fail
  // (= round-trip would still differ due to rate metadata causing pitch bugs)
  const ch = filled(128, 0.5);
  const path = tmpWav([ch], 44100);
  expect(() => expectAudioMatchesGolden(monoResult(ch), path)).toThrow(/sampleRate mismatch/);
});

test("`expectAudioMatchesGolden`: multi-port actual throws (= cannot infer single port)", () => {
  const path = tmpWav([filled(128, 0.5)]);
  const result: RenderResultLike = {
    outputs: { main: [filled(128, 0.5)], send: [filled(128, 0.3)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectAudioMatchesGolden(result, path)).toThrow(/single-port/);
});

// ━━━━━━━━━━━━━━━━━━━━━ expectAudioMatchesSnapshot ━━━━━━━━━━━━━━━━━━━━━━━

test("`expectAudioMatchesSnapshot`: round-trip = first run writes snapshot, second run is bit-exact pass", async () => {
  const result = monoResult(filled(128, 0.5));
  await expectAudioMatchesSnapshot(result, { snapshotName: "index-round-trip-128-0.5" });
  await expectAudioMatchesSnapshot(result, { snapshotName: "index-round-trip-128-0.5" });
});

test("`expectAudioMatchesSnapshot`: multi-port + opts.port not specified = throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-"));
  const path = join(dir, "ref.wav");
  const result: RenderResultLike = {
    outputs: { main: [filled(8, 0.5)], send: [filled(8, 0.3)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  await expect(expectAudioMatchesSnapshot(result, { snapshotPath: path })).rejects.toThrow(
    /multi-port/,
  );
});

test("`expectAudioMatchesSnapshot`: opts.port specified resolves the target port from multi-port result", async () => {
  const result: RenderResultLike = {
    outputs: { main: [filled(8, 0.5)], send: [filled(8, 0.3)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  await expectAudioMatchesSnapshot(result, {
    snapshotName: "index-multi-port-send",
    port: "send",
  });
});

test("`expectAudioMatchesSnapshot`: opts.port not present in actual.outputs = throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-"));
  const path = join(dir, "ref.wav");
  const result = monoResult(filled(8, 0));
  await expect(
    expectAudioMatchesSnapshot(result, { snapshotPath: path, port: "nonexistent" }),
  ).rejects.toThrow(/not in actual.outputs/);
});

test("expectAudioMatchesSnapshot auto-infer path", async () => {
  // auto-infer = `<test-file-dir>/__snapshots__/<test-file-name>__<test-name>__<counter>.wav`
  // On first run the snapshot wav is committed to the repo; subsequent runs guard against regressions bit-exactly.
  const result = monoResult(filled(8, 0));
  await expectAudioMatchesSnapshot(result);
});

test("expectAudioMatchesSnapshot opts.snapshotName path", async () => {
  // `snapshotName` overrides the test-name segment of the filename (no counter),
  // writing `<test-file-base>__<safe(snapshotName)>.wav`.
  const result = monoResult(filled(8, 0));
  await expectAudioMatchesSnapshot(result, { snapshotName: "snapshotName demo" });
});

test("expectAudioMatchesSnapshot opts.snapshotName preserves Unicode (= 'Тест имя')", async () => {
  // sanitize preserves Unicode — guards against an ASCII-only sanitizer that
  // strips all characters and creates a hidden `.wav` file.
  const result = monoResult(filled(8, 0));
  await expectAudioMatchesSnapshot(result, { snapshotName: "Тест имя" });
});

test("`expectAudioMatchesSnapshot`: entirely unsafe snapshotName sanitizes to empty string = throw", async () => {
  // '???' etc. = every char replaced by _ then trimmed to empty — throw
  // fail-fast instead of creating a hidden `.wav` file.
  const result = monoResult(filled(8, 0));
  await expect(expectAudioMatchesSnapshot(result, { snapshotName: "???" })).rejects.toThrow(
    /sanitizes to empty filename/,
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━ matcher stubs (= 12 remaining) ━━━━━━━━━━━━━━━━━━━━━

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ expectStable ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectStable`: clean PCM passes (= regardless of audio level)", () => {
  expect(() => expectStable(monoResult(filled(8, 1.5)))).not.toThrow();
});

test("`expectStable`: NaN throws", () => {
  const ch = filled(8, 0.5);
  ch[3] = NaN;
  expect(() => expectStable(monoResult(ch))).toThrow(/NaN/);
});

test("`expectStable`: Infinity throws (= divergence detected)", () => {
  const ch = filled(8, 0.5);
  ch[3] = Infinity;
  expect(() => expectStable(monoResult(ch))).toThrow(/Infinity/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ expectMaster ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectMaster`: low level + clean = pass (= default thresholds)", () => {
  expect(() => expectMaster(monoResult(filled(8, 0.1)))).not.toThrow();
});

test("`expectMaster`: peak >= default -0.1 dBFS = throw", () => {
  expect(() => expectMaster(monoResult(filled(8, 1.0)))).toThrow(/peak/);
});

test("`expectMaster`: RMS >= default -14 dBFS = throw", () => {
  expect(() => expectMaster(monoResult(filled(8, 0.5)))).toThrow(/RMS/);
});

test("`expectMaster`: opts.peakDbfs override relaxes threshold", () => {
  expect(() => expectMaster(monoResult(filled(8, 0.1)), { peakDbfs: 0, rmsDbfs: 0 })).not.toThrow();
});

test("`expectMaster`: buffer containing NaN = throw (= default thresholds)", () => {
  const ch = filled(8, 0.1);
  ch[3] = NaN;
  expect(() => expectMaster(monoResult(ch))).toThrow(/NaN/);
});

test("`expectMaster`: NaN check is always on (= cannot be disabled via opts)", () => {
  // underlying expectPeakUnder / expectRmsUnder have an unconditional NaN guard,
  // so a 'noNan' escape hatch at the master level would be a dead option.
  // The noNan opt is removed — always fails on NaN.
  const ch = filled(8, 0.1);
  ch[3] = NaN;
  expect(() => expectMaster(monoResult(ch), { peakDbfs: 0, rmsDbfs: 0 })).toThrow(/NaN/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━ expectSilence ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectSilence`: all zeros = pass", () => {
  expect(() => expectSilence(monoResult(filled(8, 0)))).not.toThrow();
});

test("`expectSilence`: non-silence = throw", () => {
  expect(() => expectSilence(monoResult(filled(8, 0.1)))).toThrow(/silence/i);
});

test("`expectSilence`: value within opts.tolerance = pass", () => {
  expect(() => expectSilence(monoResult(filled(8, 0.0001)), { tolerance: 0.001 })).not.toThrow();
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━ expectPeakAtSample ━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectPeakAtSample`: impulse → peak at 0 = pass", () => {
  expect(() => expectPeakAtSample(monoResult(impulse(8)), 0)).not.toThrow();
});

test("`expectPeakAtSample`: opts.atSample shifts the impulse position", () => {
  expect(() => expectPeakAtSample(monoResult(impulse(8, { atSample: 3 })), 3)).not.toThrow();
});

test("`expectPeakAtSample`: exceeds tolerance = throw", () => {
  expect(() => expectPeakAtSample(monoResult(impulse(8)), 5)).toThrow(/peak/);
});

test("`expectPeakAtSample`: within tolerance = pass", () => {
  expect(() => expectPeakAtSample(monoResult(impulse(8)), 2, { tolerance: 3 })).not.toThrow();
});

test("`expectPeakAtSample`: multi-port + opts.port not specified = throw", () => {
  const result: RenderResultLike = {
    outputs: { main: [impulse(8)], send: [impulse(8, { atSample: 5 })] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectPeakAtSample(result, 0)).toThrow(/multi-port/);
});

test("`expectPeakAtSample`: opts.port specified resolves the target port from multi-port result", () => {
  const result: RenderResultLike = {
    outputs: { main: [impulse(8)], send: [impulse(8, { atSample: 5 })] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectPeakAtSample(result, 5, { port: "send" })).not.toThrow();
});

test("`expectPeakAtSample`: opts.port absent from result.outputs = throw", () => {
  expect(() => expectPeakAtSample(monoResult(impulse(8)), 0, { port: "nonexistent" })).toThrow(
    /not in result.outputs/,
  );
});

test("`expectPeakAtSample`: silent buffer + expectedAtSample 0 = throw (= prevents mute regression false pass)", () => {
  // An all-zero buffer where the initial maxAbs is -1 and abs(0) > -1 sets maxIdx to 0,
  // which would yield a false pass when expectedAtSample is 0. The guard blocks this path.
  expect(() => expectPeakAtSample(monoResult(filled(8, 0)), 0)).toThrow(/no detectable response/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━ expectDcOffsetUnder ━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectDcOffsetUnder`: silence = DC 0 = pass", () => {
  expect(() => expectDcOffsetUnder(monoResult(filled(8, 0)), 0.001)).not.toThrow();
});

test("`expectDcOffsetUnder`: DC 0.5 + threshold 0.001 = throw", () => {
  expect(() => expectDcOffsetUnder(monoResult(filled(8, 0.5)), 0.001)).toThrow(/DC offset/);
});

test("`expectDcOffsetUnder`: oscillating signal (= mean ~0) = pass", () => {
  // one full sine period → mean ≈ 0
  const buf = sine({ freqHz: 1, durationSamples: 100, sampleRate: 100 });
  expect(() => expectDcOffsetUnder(monoResult(buf), 0.01)).not.toThrow();
});

test("`expectDcOffsetUnder`: empty channel (= length 0) = mean 0 = pass", () => {
  const result: RenderResultLike = {
    outputs: { main: [new Float32Array(0)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectDcOffsetUnder(result, 0.001)).not.toThrow();
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━ expectGainAtFreq ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectGainAtFreq`: pure tone amplitude 1 = 0 dB ± 2 dB passes (= spectral leakage tolerance)", () => {
  // sine 1000 Hz amplitude 1 / 1024 samples @ 48k, bin 21 is near 1000 Hz.
  // When freqHz does not land exactly on a bin center, spectral leakage spreads
  // amplitude across adjacent bins — 2 dB tolerance covers this.
  const buf = sine({ freqHz: 1000, durationSamples: 1024, sampleRate: 48000, amplitude: 1 });
  expect(() => expectGainAtFreq(monoResult(buf), 1000, 0, 2)).not.toThrow();
});

test("`expectGainAtFreq`: amplitude 0.5 = -6 dB ± 2 dB passes", () => {
  const buf = sine({ freqHz: 1000, durationSamples: 1024, sampleRate: 48000, amplitude: 0.5 });
  expect(() => expectGainAtFreq(monoResult(buf), 1000, -6, 2)).not.toThrow();
});

test("`expectGainAtFreq`: silence (= -Infinity dB) vs 0 dB expected = throw", () => {
  expect(() => expectGainAtFreq(monoResult(silence(1024)), 1000, 0, 1)).toThrow(/gain/);
});

test("`expectGainAtFreq`: multi-port = throw", () => {
  const result: RenderResultLike = {
    outputs: { main: [silence(1024)], send: [silence(1024)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectGainAtFreq(result, 1000, 0, 1)).toThrow(/single-port/);
});

test("`expectGainAtFreq`: empty channel = throw", () => {
  const result: RenderResultLike = {
    outputs: { main: [new Float32Array(0)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectGainAtFreq(result, 1000, 0, 1)).toThrow(/empty/);
});

test("`expectGainAtFreq`: frequency above Nyquist = throw", () => {
  expect(() => expectGainAtFreq(monoResult(silence(1024)), 30000, 0, 1)).toThrow(/out of range/);
});

test("`expectGainAtFreq`: non-power-of-2 length (= L = 48000) pure tone amplitude 1 = 0 dB ± 1.5 dB regression", () => {
  // L = 48000, sr = 48000, f = 1000 → nextPow2 = 65536 zero-padded, bin 1365 is
  // near 1000 Hz (= bin freq = 999.756 Hz = -0.244 Hz offset). Normalizing by
  // ch.length instead of zero-padded N causes leakage-induced amplitude error of
  // -0.87 dB (sinc factor 0.905); normalizing by padded N causes an additional
  // L/N = 0.732x underestimate = -3.57 dB, which fails the 1.5 dB tolerance.
  const buf = sine({ freqHz: 1000, durationSamples: 48000, sampleRate: 48000, amplitude: 1 });
  expect(() => expectGainAtFreq(monoResult(buf), 1000, 0, 1.5)).not.toThrow();
});

test("`expectGainAtFreq`: multichannel + opts.channel not specified = throw (= prevents silent blind spot)", () => {
  const buf = sine({ freqHz: 1000, durationSamples: 1024, sampleRate: 48000, amplitude: 1 });
  const result = stereoResult(buf, silence(1024));
  expect(() => expectGainAtFreq(result, 1000, 0, 2)).toThrow(/multichannel.*opts\.channel/);
});

test("`expectGainAtFreq`: multichannel + opts.channel specified = analyzes the specified channel (= catches broken non-zero channels)", () => {
  // ch 0 = pure tone at 0 dB, ch 1 = silence (= -Infinity dB).
  // With opts.channel: 1, ch 1 silence is analyzed = mismatch against expected 0 dB = throw.
  const buf = sine({ freqHz: 1000, durationSamples: 1024, sampleRate: 48000, amplitude: 1 });
  const result = stereoResult(buf, silence(1024));
  expect(() => expectGainAtFreq(result, 1000, 0, 2, { channel: 0 })).not.toThrow();
  expect(() => expectGainAtFreq(result, 1000, 0, 2, { channel: 1 })).toThrow(/gain/);
});

test("`expectGainAtFreq`: opts.channel out of range = throw", () => {
  const buf = sine({ freqHz: 1000, durationSamples: 1024, sampleRate: 48000, amplitude: 1 });
  expect(() => expectGainAtFreq(monoResult(buf), 1000, 0, 2, { channel: 5 })).toThrow(
    /out of range/,
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━ expectLatency ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectLatency`: impulse at 0 → latency 0 = pass", () => {
  expect(() => expectLatency(monoResult(impulse(8)), 0)).not.toThrow();
});

test("`expectLatency`: 5-sample delayed impulse → latency 5", () => {
  expect(() => expectLatency(monoResult(impulse(16, { atSample: 5 })), 5)).not.toThrow();
});

test("`expectLatency`: expected mismatch = throw", () => {
  expect(() => expectLatency(monoResult(impulse(16, { atSample: 5 })), 10)).toThrow(/delay/);
});

test("`expectLatency`: within tolerance band = pass", () => {
  expect(() =>
    expectLatency(monoResult(impulse(16, { atSample: 5 })), 7, { tolerance: 3 }),
  ).not.toThrow();
});

test("`expectLatency`: multi-port = throw", () => {
  const result: RenderResultLike = {
    outputs: { main: [impulse(8)], send: [impulse(8)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectLatency(result, 0)).toThrow(/single-port/);
});

test("`expectLatency`: multichannel + opts.channel not specified = throw (= prevents silent blind spot)", () => {
  const result = stereoResult(impulse(8, { atSample: 0 }), impulse(8, { atSample: 5 }));
  expect(() => expectLatency(result, 0)).toThrow(/multichannel.*opts\.channel/);
});

test("`expectLatency`: multichannel + opts.channel specified = analyzes the specified channel (= catches broken non-zero channels)", () => {
  // ch 0 = impulse @ 0, ch 1 = impulse @ 5. With expected latency 0:
  // channel: 0 passes, channel: 1 fails.
  const result = stereoResult(impulse(8, { atSample: 0 }), impulse(8, { atSample: 5 }));
  expect(() => expectLatency(result, 0, { channel: 0 })).not.toThrow();
  expect(() => expectLatency(result, 0, { channel: 1 })).toThrow(/delay/);
});

test("`expectLatency`: opts.channel out of range = throw", () => {
  expect(() => expectLatency(monoResult(impulse(8)), 0, { channel: 5 })).toThrow(/out of range/);
});

test("`expectLatency`: silent buffer + expectedSamples 0 = throw (= prevents mute regression false pass)", () => {
  // An all-zero buffer where the initial maxAbs is -1 and abs(0) > -1 sets maxIdx to 0,
  // which would yield a false pass when expectedSamples is 0. The guard blocks this path.
  expect(() => expectLatency(monoResult(filled(8, 0)), 0)).toThrow(/no detectable response/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━ expectEventCount ━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectEventCount`: matching count for a given name = pass", () => {
  const result: RenderResultLike = {
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

test("`expectEventCount`: count mismatch = throw", () => {
  const result: RenderResultLike = {
    outputs: {},
    events: [{ name: "peak", payload: {}, atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectEventCount(result, "peak", 2)).toThrow(/count 1 != expected 2/);
});

test("`expectEventCount`: absent name = 0 = pass", () => {
  expect(() => expectEventCount(monoResult(filled(8, 0)), "ghost", 0)).not.toThrow();
});

// ━━━━━━━━━━━━━━━━━━━━━━━━ expectEventsContaining ━━━━━━━━━━━━━━━━━━━━━━━━

test("`expectEventsContaining`: all partial entries exist in result = pass", () => {
  const result: RenderResultLike = {
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

test("`expectEventsContaining`: partial payload match", () => {
  const result: RenderResultLike = {
    outputs: {},
    events: [{ name: "peak", payload: { level: 0.5 }, atSample: 10 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() =>
    expectEventsContaining(result, [{ name: "peak", payload: { level: 0.5 } }]),
  ).not.toThrow();
});

test("`expectEventsContaining`: payload mismatch = throw", () => {
  const result: RenderResultLike = {
    outputs: {},
    events: [{ name: "peak", payload: { level: 0.5 }, atSample: 10 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectEventsContaining(result, [{ name: "peak", payload: { level: 0.7 } }])).toThrow(
    /not found/,
  );
});

test("`expectEventsContaining`: atSample match path", () => {
  const result: RenderResultLike = {
    outputs: {},
    events: [{ name: "peak", payload: {}, atSample: 10 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectEventsContaining(result, [{ name: "peak", atSample: 10 }])).not.toThrow();
});

test("`expectEventsContaining`: atSample mismatch = throw", () => {
  const result: RenderResultLike = {
    outputs: {},
    events: [{ name: "peak", payload: {}, atSample: 10 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectEventsContaining(result, [{ name: "peak", atSample: 99 }])).toThrow(
    /not found/,
  );
});

test("`expectEventsContaining`: extra events are tolerated (= unordered / partial match)", () => {
  const result: RenderResultLike = {
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ NaN guard regression (= all numerical matchers) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// `Math.abs(NaN) > x = false` / `NaN >= x = false` means NaN input can produce
// false passes. Each matcher blocks this at the start via `expectNoNaN(result)`.

const nanResult = (): RenderResultLike => {
  const ch = filled(8, 0.5);
  ch[3] = NaN;
  return monoResult(ch);
};

test("`expectAudioMatches`: NaN actual = throw (= prevents silent compare pass)", () => {
  expect(() => expectAudioMatches(nanResult(), [filled(8, 0.5)])).toThrow(/NaN/);
});

test("`expectAudioMatches`: NaN expected (= Float32Array[] form) = throw (= prevents corrupted reference from being frozen)", () => {
  const nanCh = filled(8, 0.5);
  nanCh[3] = NaN;
  expect(() => expectAudioMatches(monoResult(filled(8, 0.5)), [nanCh])).toThrow(/expected.*NaN/);
});

test("`expectAudioMatches`: NaN expected (= RenderOfflineResult form) = throw", () => {
  expect(() => expectAudioMatches(monoResult(filled(8, 0.5)), nanResult())).toThrow(
    /expected.*NaN/,
  );
});

test("`expectAudioMatchesGolden`: NaN actual = throw (= via internal `expectAudioMatches`)", () => {
  const path = tmpWav([filled(8, 0.5)]);
  expect(() => expectAudioMatchesGolden(nanResult(), path)).toThrow(/NaN/);
});

test("`expectAudioMatchesGolden`: golden wav containing NaN = throw (= rejects a broken reference frozen by a past run)", () => {
  const nanCh = filled(8, 0.5);
  nanCh[3] = NaN;
  const path = tmpWav([nanCh]);
  expect(() => expectAudioMatchesGolden(monoResult(filled(8, 0.5)), path)).toThrow(/expected.*NaN/);
});

test("`expectAudioMatchesSnapshot`: NaN actual = throw (= prevents persisting a broken wav on first snapshot write)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-nan-"));
  const path = join(dir, "ref.wav");
  await expect(expectAudioMatchesSnapshot(nanResult(), { snapshotPath: path })).rejects.toThrow(
    /NaN/,
  );
});

test("`expectPeakUnder`: NaN = throw (= prevents false pass when peak stays 0, reading as -Infinity dB)", () => {
  expect(() => expectPeakUnder(nanResult(), -3)).toThrow(/NaN/);
});

test("`expectRmsUnder`: NaN = throw (= prevents false pass when rms = NaN >= dbfs = false)", () => {
  expect(() => expectRmsUnder(nanResult(), -3)).toThrow(/NaN/);
});

test("`expectSilence`: NaN = throw (= prevents false pass when abs(NaN) > 0 = false)", () => {
  expect(() => expectSilence(nanResult())).toThrow(/NaN/);
});

test("`expectPeakAtSample`: NaN = throw (= prevents false pass when maxIdx stays at its initial value)", () => {
  expect(() => expectPeakAtSample(nanResult(), 3)).toThrow(/NaN/);
});

test("`expectGainAtFreq`: NaN = throw (= prevents false pass from NaN propagation through FFT magnitude)", () => {
  expect(() => expectGainAtFreq(nanResult(), 1000, 0, 1)).toThrow(/NaN/);
});

test("`expectLatency`: NaN = throw (= prevents false pass when maxIdx stays at its initial value)", () => {
  expect(() => expectLatency(nanResult(), 0)).toThrow(/NaN/);
});

test("`expectDcOffsetUnder`: NaN = throw (= prevents false pass when mean = NaN >= threshold = false)", () => {
  expect(() => expectDcOffsetUnder(nanResult(), 0.001)).toThrow(/NaN/);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━ signal utilities (7 cases) ━━━━━━━━━━━━━━━━━━━━━━━━━

test("`sine`: 440 Hz @ 48k — sample 0 = 0, quarter-period sample ≈ 1", () => {
  // period in samples = 48000 / 440 ≈ 109.09, quarter period ≈ 27.27 samples
  const buf = sine({ freqHz: 440, durationSamples: 128, sampleRate: 48000 });
  expect(buf.length).toBe(128);
  expect(buf[0]).toBeCloseTo(0, 6);
  // around sample 27 sin approaches 1
  expect(buf[27]).toBeCloseTo(1, 1);
});

test("`sine`: amplitude and phase are applied", () => {
  const buf = sine({
    freqHz: 1,
    durationSamples: 4,
    sampleRate: 4,
    amplitude: 0.5,
    phase: Math.PI / 2,
  });
  // phase = π/2 → sample 0 = sin(π/2) = 1, scaled by amplitude 0.5 = 0.5
  expect(buf[0]).toBeCloseTo(0.5, 6);
});

test("`silence`: all zeros", () => {
  const buf = silence(8);
  expect(buf.length).toBe(8);
  expect([...buf]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
});

test("`impulse`: default = sample 0 = 1, rest 0", () => {
  const buf = impulse(4);
  expect([...buf]).toEqual([1, 0, 0, 0]);
});

test("`impulse`: opts.atSample shifts the impulse position", () => {
  const buf = impulse(4, { atSample: 2 });
  expect([...buf]).toEqual([0, 0, 1, 0]);
});

test("`impulse`: opts.atSample out of range = all zeros", () => {
  const buf = impulse(4, { atSample: 100 });
  expect([...buf]).toEqual([0, 0, 0, 0]);
});

test("`sineSweep`: log sweep deterministic", () => {
  const buf = sineSweep({ startHz: 100, endHz: 1000, durationSamples: 64, sampleRate: 48000 });
  expect(buf.length).toBe(64);
  // sample 0 = 0 (phase = 2π * 100 / 48000)
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

test("`whiteNoise`: deterministic seed produces identical buffers", () => {
  const a = whiteNoise({ durationSamples: 32, seed: 42 });
  const b = whiteNoise({ durationSamples: 32, seed: 42 });
  expect([...a]).toEqual([...b]);
});

test("`whiteNoise`: different seeds produce different buffers", () => {
  const a = whiteNoise({ durationSamples: 32, seed: 1 });
  const b = whiteNoise({ durationSamples: 32, seed: 2 });
  expect([...a]).not.toEqual([...b]);
});

test("`whiteNoise`: amplitude is respected — all samples |s| <= amplitude", () => {
  const buf = whiteNoise({ durationSamples: 1024, amplitude: 0.5 });
  for (const s of buf) expect(Math.abs(s)).toBeLessThanOrEqual(0.5);
});

test("`dc`: default value = 1", () => {
  const buf = dc(4);
  expect([...buf]).toEqual([1, 1, 1, 1]);
});

test("`dc`: arbitrary value", () => {
  const buf = dc(3, 0.25);
  expect([...buf]).toEqual([0.25, 0.25, 0.25]);
});

test("`ramp`: 0..1 / 5 samples = [0, 0.25, 0.5, 0.75, 1]", () => {
  const buf = ramp({ durationSamples: 5, from: 0, to: 1 });
  expect([...buf]).toEqual([0, 0.25, 0.5, 0.75, 1]);
});

test("`ramp`: single sample = from", () => {
  const buf = ramp({ durationSamples: 1, from: 0.5, to: 1 });
  expect(buf[0]).toBe(0.5);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━ midi namespace (10 cases) ━━━━━━━━━━━━━━━━━━━━━━━━━

test("`midi.noteOn`: builds message with default channel 0", () => {
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

test("`midi.cc`: builds message with channel override", () => {
  expect(midi.cc({ controller: 7, value: 100, channel: 5 })).toEqual({
    type: "cc",
    channel: 5,
    controller: 7,
    value: 100,
  });
});

test("`midi.pitchBend`: builds message", () => {
  expect(midi.pitchBend({ value: 8192 })).toEqual({
    type: "pitchBend",
    channel: 0,
    value: 8192,
  });
});

test("`midi.programChange`: builds message", () => {
  expect(midi.programChange({ program: 42 })).toEqual({
    type: "programChange",
    channel: 0,
    program: 42,
  });
});

test("`midi.channelPressure`: builds message", () => {
  expect(midi.channelPressure({ pressure: 80 })).toEqual({
    type: "channelPressure",
    channel: 0,
    pressure: 80,
  });
});

test("`midi.aftertouch`: builds message", () => {
  expect(midi.aftertouch({ note: 60, pressure: 80 })).toEqual({
    type: "aftertouch",
    channel: 0,
    note: 60,
    pressure: 80,
  });
});

test("`midi.systemRealtime`: builds message (= 0xF8 = timing clock)", () => {
  expect(midi.systemRealtime(0xf8)).toEqual({ type: "systemRealtime", status: 0xf8 });
});

test("`midi.sysex`: builds message (= data carry)", () => {
  const bytes = new Uint8Array([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]);
  expect(midi.sysex(bytes)).toEqual({ type: "sysex", data: bytes });
});

test("`midi.sequence`: converts array to OfflineEvent[]", () => {
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

test("`expectMidiOut`: order + type + payload match = pass", () => {
  const result: RenderResultLike = {
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

test("`expectMidiOut`: count mismatch = throw", () => {
  const result: RenderResultLike = {
    outputs: {},
    events: [{ name: "out", payload: midi.noteOn({ note: 60, velocity: 100 }), atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectMidiOut(result, "out", [])).toThrow(/count/);
});

test("`expectMidiOut`: type mismatch = throw", () => {
  const result: RenderResultLike = {
    outputs: {},
    events: [{ name: "out", payload: midi.noteOn({ note: 60, velocity: 100 }), atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectMidiOut(result, "out", [midi.noteOff({ note: 60 })])).toThrow(/type/);
});

test("`expectMidiOut`: atSample exceeds tolerance = throw", () => {
  const result: RenderResultLike = {
    outputs: {},
    events: [{ name: "out", payload: midi.noteOn({ note: 60, velocity: 100 }), atSample: 100 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() =>
    expectMidiOut(result, "out", [{ ...midi.noteOn({ note: 60, velocity: 100 }), atSample: 0 }]),
  ).toThrow(/atSample/);
});

test("`expectMidiOut`: payload field mismatch = throw", () => {
  const result: RenderResultLike = {
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

test("`expectMidiBalance`: fully paired noteOn/noteOff = pass", () => {
  const result: RenderResultLike = {
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
  const result: RenderResultLike = {
    outputs: {},
    events: [{ name: "out", payload: midi.noteOn({ note: 60, velocity: 100 }), atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectMidiBalance(result, "out")).toThrow(/hanging/);
});

test("`expectMidiBalance`: opts.hangingNotes allows a permitted number of hanging notes", () => {
  const result: RenderResultLike = {
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

test("`expectMidiBalance`: different channels are tracked as separate notes", () => {
  const result: RenderResultLike = {
    outputs: {},
    events: [
      { name: "out", payload: midi.noteOn({ note: 60, velocity: 100, channel: 0 }), atSample: 0 },
      { name: "out", payload: midi.noteOff({ note: 60, channel: 1 }), atSample: 480 },
    ],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  // ch 0 noteOn is hanging, ch 1 noteOff is stray (= both counted as failures).
  expect(() => expectMidiBalance(result, "out")).toThrow(/hanging.*stray|stray.*hanging/);
});

test("`expectMidiBalance`: stray noteOff (= noteOn without a matching pair) = throw", () => {
  // a lone noteOff = invalid lifecycle = always fails (no tolerance opt).
  const result: RenderResultLike = {
    outputs: {},
    events: [{ name: "out", payload: midi.noteOff({ note: 60 }), atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectMidiBalance(result, "out")).toThrow(/stray/);
});

test("`expectMidiBalance`: double noteOff (= noteOn 1 → noteOff 2) = throw", () => {
  // sending noteOff twice for the same note = noteOff over-count = stray fail.
  const result: RenderResultLike = {
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

test("`expectMidiBalance`: stray noteOff cannot be pardoned by hangingNotes opt", () => {
  // hangingNotes only applies to hanging noteOns; stray noteOffs always fail.
  const result: RenderResultLike = {
    outputs: {},
    events: [{ name: "out", payload: midi.noteOff({ note: 60 }), atSample: 0 }],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expect(() => expectMidiBalance(result, "out", { hangingNotes: 100 })).toThrow(/stray/);
});

test("`expectMidiBalance`: noteOff before noteOn (= reversed order, net 0) = throw", () => {
  // A final-sum approach would pass because on/off cancel out, but the running
  // counter catches the stray noteOff immediately — regression guard.
  const result: RenderResultLike = {
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

// ━━━━━━━━━━━━━━━━━━━━━━━ sample / time utilities (6 cases) ━━━━━━━━━━━━━━━━━━━━━━

test("`samplesToMs`: 480 samples @ 48k = 10 ms", () => {
  expect(samplesToMs(480, 48000)).toBe(10);
});

test("`msToSamples`: 10 ms @ 48k = 480 samples", () => {
  expect(msToSamples(10, 48000)).toBe(480);
});

test("`samplesToSec`: 48000 samples @ 48k = 1 sec", () => {
  expect(samplesToSec(48000, 48000)).toBe(1);
});

test("`secToSamples`: 1 sec @ 48k = 48000 samples", () => {
  expect(secToSamples(1, 48000)).toBe(48000);
});

test("`bpmToSamples`: 120 BPM 1/4 @ 48k = 24000 samples (= half sec)", () => {
  // 120 BPM = 0.5 sec / beat, 1/4 = 1 beat = 0.5 sec = 24000 samples @ 48k
  expect(bpmToSamples({ bpm: 120, division: "1/4", sampleRate: 48000 })).toBe(24000);
});

test("`bpmToSamples`: 120 BPM 1/16 @ 48k = 6000 samples (= 1/16 beat)", () => {
  expect(bpmToSamples({ bpm: 120, division: "1/16", sampleRate: 48000 })).toBe(6000);
});

test("`bpmToMs`: 120 BPM 1/4 = 500 ms", () => {
  expect(bpmToMs({ bpm: 120, division: "1/4" })).toBe(500);
});

test("`bpmToMs`: 60 BPM 1/1 = 4000 ms (= 4 beats = 1 whole note)", () => {
  expect(bpmToMs({ bpm: 60, division: "1/1" })).toBe(4000);
});

test("`bpmToMs`: division factors (1/1: 4, 1/2: 2, 1/4: 1, 1/8: 0.5, 1/16: 0.25, 1/32: 0.125)", () => {
  // 60 BPM × 1000 ms/beat = 1000 ms/beat; ms per division
  expect(bpmToMs({ bpm: 60, division: "1/1" })).toBe(4000);
  expect(bpmToMs({ bpm: 60, division: "1/2" })).toBe(2000);
  expect(bpmToMs({ bpm: 60, division: "1/4" })).toBe(1000);
  expect(bpmToMs({ bpm: 60, division: "1/8" })).toBe(500);
  expect(bpmToMs({ bpm: 60, division: "1/16" })).toBe(250);
  expect(bpmToMs({ bpm: 60, division: "1/32" })).toBe(125);
});

// ━━━━━━━━━━━━━━━━━━━━━━━ remaining branch coverage (= -Infinity / snapshot state) ━━━━━━━━━━━━━━━━

test("`expectAudioMatches`: +Infinity expected (= Float32Array[] form) = throw (= positive-infinity branch)", () => {
  // Hits the `v > 0 ? "+Infinity" : "-Infinity"` true branch inside `assertChannelsFinite`.
  const posInfCh = filled(8, 0.5);
  posInfCh[3] = Infinity;
  expect(() => expectAudioMatches(monoResult(filled(8, 0.5)), [posInfCh])).toThrow(
    /expected.*\+Infinity/,
  );
});

test("`expectAudioMatches`: -Infinity expected (= Float32Array[] form) = throw (= negative-infinity branch)", () => {
  // Hits the `v > 0 ? "+Infinity" : "-Infinity"` false branch inside `assertChannelsFinite`.
  // Paired with the +Infinity test to cover both branches.
  const negInfCh = filled(8, 0.5);
  negInfCh[3] = -Infinity;
  expect(() => expectAudioMatches(monoResult(filled(8, 0.5)), [negInfCh])).toThrow(
    /expected.*-Infinity/,
  );
});

test("`expectAudioMatchesSnapshotWithState`: snapshotName provided + state.testPath absent = throw", () => {
  // Hits the `if (!state.testPath)` branch inside `resolveSnapshotPath` (snapshotName path).
  // Passing an empty state object explicitly creates the missing-testPath condition.
  return expect(
    expectAudioMatchesSnapshotWithState(monoResult(filled(8, 0.5)), { snapshotName: "demo" }, {}),
  ).rejects.toThrow(/requires testPath/);
});

test("`expectAudioMatchesSnapshotWithState`: auto-infer + state.testPath absent = throw", () => {
  // Hits the `if (!state.testPath || !state.currentTestName)` branch inside
  // `resolveSnapshotPath` (auto-infer path). Passing a state with neither field
  // triggers fail-fast.
  return expect(
    expectAudioMatchesSnapshotWithState(monoResult(filled(8, 0.5)), {}, {}),
  ).rejects.toThrow(/auto-infer requires testPath/);
});

test("`expectAudioMatchesSnapshotWithState`: auto-infer + currentTestName absent = throw", () => {
  // Hits the same branch via the short-circuit right operand `!state.currentTestName`
  // by providing testPath only, leaving currentTestName absent.
  return expect(
    expectAudioMatchesSnapshotWithState(
      monoResult(filled(8, 0.5)),
      {},
      {
        testPath: "/tmp/dummy.test.ts",
      },
    ),
  ).rejects.toThrow(/auto-infer requires testPath/);
});

test("`expectAudioMatchesSnapshotWithState`: fully unsafe currentTestName in auto-infer = `_` placeholder slug", async () => {
  // Hits the `safeName.length > 0 ? safeName : "_"` false branch inside
  // `resolveSnapshotPath` — all chars in '???' are unsafe, producing an empty
  // string, which falls through to the '_' placeholder path.
  // testPath + currentTestName both set, snapshotState absent → also hits the
  // `?? "new"` fallback (= L506).
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-unsafe-"));
  const result = monoResult(filled(8, 0));
  await expectAudioMatchesSnapshotWithState(
    result,
    {},
    {
      testPath: join(dir, "dummy.test.ts"),
      currentTestName: "???",
    },
  );
});

test("`expectMidiBalance`: non-noteOn/noteOff MIDI messages (= cc / pitchBend etc.) do not affect balance", () => {
  // Hits the `else` branch (neither noteOn nor noteOff) inside `expectMidiBalance`,
  // e.g. cc / pitchBend / programChange / sysex / etc. These do not affect
  // the running note count and therefore pass as balanced.
  const result: RenderResultLike = {
    outputs: {},
    events: [
      {
        name: "out",
        payload: { type: "cc", channel: 0, controller: 7, value: 100 },
        atSample: 0,
      },
    ],
    state: new Uint8Array(0),
    sampleRate: 48000,
  };
  expectMidiBalance(result, "out");
});

test("`sineSweep`: durationSamples=1 = single sample (= t-calculation div-by-zero fallback path)", () => {
  // Hits the `opts.durationSamples > 1 ? ... : 0` false branch inside `sineSweep`
  // (= durationSamples = 1 avoids division by zero via fallback to 0).
  const out = sineSweep({
    durationSamples: 1,
    sampleRate: 48000,
    startHz: 100,
    endHz: 1000,
  });
  expect(out.length).toBe(1);
});

test("`whiteNoise`: seed = 0 hits xorshift32 zero-seed rescue path", () => {
  // Hits the `if (s === 0) s = 1` true branch inside `whiteNoise`
  // (= xorshift32 gets stuck at 0, so seed 0 is forced to 1).
  const out = whiteNoise({ durationSamples: 8, seed: 0 });
  expect(out.length).toBe(8);
});

test("`midi.cc`: channel omitted defaults to 0 (= null-fallback branch)", () => {
  // Hits the `opts.channel ?? 0` null-fallback branch inside `midi.cc` (channel omitted).
  // Paired with the channel-override test (= 5) to cover both branches.
  expect(midi.cc({ controller: 7, value: 100 })).toEqual({
    type: "cc",
    channel: 0,
    controller: 7,
    value: 100,
  });
});
