/**
 * Chain-form tests for `@unworklet/test/extend` (see `docs/06-testing.md` §6).
 * A side-effect import runs `expect.extend(...)`, after which all 20 chain
 * methods must be recognised and behave identically to their plain-function
 * counterparts. The tail section is a regression guard ensuring that the
 * `WhenResult<T, M>` TS guard collapses chain methods to `never` for any
 * actual type other than `RenderOfflineResult`. The `toHaveStateValue` chain
 * is kept as a stub-throw pending `inspect` (see `docs/05-client.md` §2.6).
 */

import "./extend.ts";

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

// ━━━━━━━━━━━━━━━━━━━━ happy + fail paths for 7 already-filled matchers ━━━━━━━━━━━━━━━━━━━━

test("`toMatchAudio` (chain) happy = single-port bit-exact", () => {
  expect(monoResult(filled(8, 0.5))).toMatchAudio([filled(8, 0.5)]);
});

test("`toMatchAudio` (chain) fail = diff exceeding tolerance converts to vitest failure", () => {
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

test("`toBeFinite` (chain) happy = no NaN", () => {
  expect(monoResult(filled(8, 0.5))).toBeFinite();
});

test("`toBeFinite` (chain) fail = contains NaN", () => {
  const ch = filled(8, 0.5);
  ch[3] = NaN;
  expect(() => expect(monoResult(ch)).toBeFinite()).toThrow(/NaN/);
});

test("`toHavePeakUnder` (chain) happy = peak < threshold", () => {
  expect(monoResult(filled(8, 0.5))).toHavePeakUnder(-3);
});

test("`toHavePeakUnder` (chain) fail = peak >= threshold", () => {
  expect(() => expect(monoResult(filled(8, 1.0))).toHavePeakUnder(-3)).toThrow(/peak/);
});

test("`toHaveRmsUnder` (chain) happy = RMS < threshold", () => {
  expect(monoResult(filled(8, 0.1))).toHaveRmsUnder(-10);
});

test("`toHaveRmsUnder` (chain) fail = RMS >= threshold", () => {
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

// ━━━━━━━━━━━━━━━━━━━━ stub-throw paths for remaining 13 chain matchers ━━━━━━━━━━━━━━━━━━━━━

test("`toMatchAudioSnapshot` (chain) round-trip = write on first call + bit-exact pass on second", async () => {
  const result = monoResult(filled(128, 0.5));
  await expect(result).toMatchAudioSnapshot({ snapshotName: "round-trip-128-0.5" });
  await expect(result).toMatchAudioSnapshot({ snapshotName: "round-trip-128-0.5" });
});

test("toMatchAudioSnapshot (chain) auto-infer path", async () => {
  const result = monoResult(filled(8, 0));
  await expect(result).toMatchAudioSnapshot();
});

test("toMatchAudioSnapshot (chain) opts.snapshotName path", async () => {
  const result = monoResult(filled(8, 0));
  await expect(result).toMatchAudioSnapshot({ snapshotName: "chain snapshotName demo" });
});

test("toMatchAudioSnapshot (chain) Float32Array direct = polymorphic actual zip", async () => {
  // Regression: the plain `expectAudioMatchesSnapshot` accepts `Float32Array`
  // directly; this test ensures the chain form passes the same path. If chain
  // typing locks `actual` to `RenderOfflineResult` via `WhenResult`, typecheck
  // fails here.
  await expect(filled(8, 0)).toMatchAudioSnapshot({ snapshotName: "polymorphic-mono-8-0" });
  await expect(filled(8, 0)).toMatchAudioSnapshot({ snapshotName: "polymorphic-mono-8-0" });
});

test("toMatchAudioSnapshot (chain) Float32Array[] direct = multi-channel polymorphic actual zip", async () => {
  const channels = [filled(8, 0.1), filled(8, 0.2)];
  await expect(channels).toMatchAudioSnapshot({ snapshotName: "polymorphic-multi-8-0.1-0.2" });
  await expect(channels).toMatchAudioSnapshot({ snapshotName: "polymorphic-multi-8-0.1-0.2" });
});

test("`toBeStable` (chain) happy = clean PCM", () => {
  expect(monoResult(filled(8, 1.5))).toBeStable();
});

test("`toBeStable` (chain) fail = NaN", () => {
  const ch = filled(8, 0.5);
  ch[3] = NaN;
  expect(() => expect(monoResult(ch)).toBeStable()).toThrow(/NaN/);
});

test("`toBeMasterReady` (chain) happy = low level + clean", () => {
  expect(monoResult(filled(8, 0.1))).toBeMasterReady();
});

test("`toBeMasterReady` (chain) fail = peak exceeds limit", () => {
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

test("`toHaveGainAtFreq` (chain) happy + fail (tolerance 2 dB accepts spectral leakage)", () => {
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
  // A stray noteOff always fails (same on the chain path).
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

// ━━━━━━━━ chain `.not.toXyz()` — exercises the pass=true message thunk ━━━━━━━━

test("`.not.toBeStable()` (chain) = pass=true message thunk returns `expected NOT to satisfy ${chainName}`", () => {
  // Applying `.not` on the pass=true branch causes vitest to evaluate the
  // `pass: true` message thunk, hitting the `expected NOT to satisfy
  // ${chainName}` branch inside `wrap()`.
  expect(() => expect(monoResult(filled(8, 0.5))).not.toBeStable()).toThrow(
    /expected NOT to satisfy toBeStable/,
  );
});

test("`.not.toMatchAudioSnapshot()` (chain) = pass=true message thunk hit (snapshot match causes .not to fail)", async () => {
  // Applying `.not` on the pass=true branch of the chain snapshot matcher hits
  // the `expected NOT to satisfy toMatchAudioSnapshot` branch inside
  // `toMatchAudioSnapshotChain`.
  const result = monoResult(filled(8, 0.5));
  await expect(result).toMatchAudioSnapshot({ snapshotName: "not-fail-base-8-0.5" });
  await expect(
    expect(result).not.toMatchAudioSnapshot({ snapshotName: "not-fail-base-8-0.5" }),
  ).rejects.toThrow(/expected NOT to satisfy toMatchAudioSnapshot/);
});

// ━━━━━━━━━━━ chain snapshot catch path — pass=false branch on content mismatch ━━━━━━━━━━━

test("`toMatchAudioSnapshot` (chain) two consecutive invocations in same test reuse `_unworkletCounters` (= else branch hit)", async () => {
  // The `this` MatcherState is shared across invocations within the same test
  // in vitest. A second consecutive call therefore takes the already-attached
  // `_unworkletCounters` path (the else branch at `toMatchAudioSnapshotChain`
  // L169-171). Exercised via the auto-infer path to hit the counter-map reuse
  // branch.
  const result = monoResult(filled(8, 0));
  await expect(result).toMatchAudioSnapshot();
  await expect(result).toMatchAudioSnapshot();
});

test("`toMatchAudioSnapshot` (chain) byte content mismatch = zips to vitest fail", async () => {
  // A mismatch (snapshot exists, bytes differ) causes the chain matcher to
  // return `pass: false` via the catch block, covering the full catch block of
  // `toMatchAudioSnapshotChain`. Base snapshot = filled(8, 0.5), actual =
  // filled(8, 0.6) to force a mismatch.
  await expect(monoResult(filled(8, 0.5))).toMatchAudioSnapshot({
    snapshotName: "mismatch-content-base-8-0.5",
  });
  await expect(
    expect(monoResult(filled(8, 0.6))).toMatchAudioSnapshot({
      snapshotName: "mismatch-content-base-8-0.5",
    }),
  ).rejects.toThrow(/snapshot byte/);
});

test("`toMatchAudioSnapshot` (chain) byte length mismatch = zips to vitest fail", async () => {
  // A mismatch (snapshot exists, length differs) causes the chain matcher to
  // return `pass: false` via the catch block, also covering the byte-length
  // mismatch throw at `expectAudioMatchesSnapshotWithState` L526-529. Base =
  // filled(8, 0.5), actual = filled(16, 0.5) to force a length mismatch.
  await expect(monoResult(filled(8, 0.5))).toMatchAudioSnapshot({
    snapshotName: "mismatch-length-base-8-0.5",
  });
  await expect(
    expect(monoResult(filled(16, 0.5))).toMatchAudioSnapshot({
      snapshotName: "mismatch-length-base-8-0.5",
    }),
  ).rejects.toThrow(/snapshot byte length mismatch/);
});

// ━━━━━━━━━ `expectAudioMatchesSnapshot` updateMode branches (shared by chain + plain) ━━━━━━━

test("`toMatchAudioSnapshot` (chain) updateMode='all' = overwrites and passes even on mismatch", async () => {
  // The chain matcher reads update mode via `this.snapshotState._updateSnapshot`
  // (the per-test bound MatcherState). This hits the force-overwrite branch
  // (`updateMode === "all"`, equivalent to `vitest -u`) at
  // `expectAudioMatchesSnapshotWithState` L520-523. The base snapshot is
  // written directly via fs (avoiding the "new" mode failure under --ci), and
  // the plain-form matcher is used to verify the overwrite.
  const { expectAudioMatchesSnapshot } = await import("./index.ts");
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-update-all-"));
  const path = join(dir, "ref.wav");
  writeFileSync(path, encodeWav([filled(8, 0.5)], 48000));
  const prev = expect.getState().snapshotState as unknown as
    | { _updateSnapshot?: string }
    | undefined;
  const prevMode = prev?._updateSnapshot;
  if (prev) prev._updateSnapshot = "all";
  try {
    // Mismatched actual still passes because updateMode='all' forces overwrite.
    await expectAudioMatchesSnapshot(monoResult(filled(8, 0.6)), { snapshotPath: path });
  } finally {
    if (prev) prev._updateSnapshot = prevMode;
  }
});

test("`expectAudioMatchesSnapshot` (plain) updateMode='none' + missing snapshot = throw (equivalent to --ci mode)", async () => {
  // `updateMode === "none"` with no existing snapshot mirrors `vitest --ci`:
  // creating a snapshot is disallowed and the call must throw
  // (see `expectAudioMatchesSnapshotWithState` L510-514).
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
  // Covers the byte content mismatch throw on the plain path (L531-536).
  // The base snapshot is written directly via fs so the test works under --ci.
  const { expectAudioMatchesSnapshot } = await import("./index.ts");
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-plain-mismatch-"));
  const path = join(dir, "ref.wav");
  writeFileSync(path, encodeWav([filled(8, 0.5)], 48000));
  await expect(
    expectAudioMatchesSnapshot(monoResult(filled(8, 0.6)), { snapshotPath: path }),
  ).rejects.toThrow(/snapshot byte/);
});

test("`expectAudioMatchesSnapshot` (plain) byte length mismatch = throw", async () => {
  // Covers the byte length mismatch throw on the plain path (L526-529).
  const { expectAudioMatchesSnapshot } = await import("./index.ts");
  const dir = mkdtempSync(join(tmpdir(), "unworklet-snapshot-plain-length-"));
  const path = join(dir, "ref.wav");
  writeFileSync(path, encodeWav([filled(8, 0.5)], 48000));
  await expect(
    expectAudioMatchesSnapshot(monoResult(filled(16, 0.5)), { snapshotPath: path }),
  ).rejects.toThrow(/snapshot byte length mismatch/);
});

// ━━━━━━━━━━━━━━━ TS-only chain guard — regression: does the type narrow to never? ━━━━━━━━━━━━━━━

test("chain method TS guard refuses non-RenderOfflineResult types", () => {
  // Validates at build time that `WhenResult<T, M>` / `WhenAudioActual<T, M>`
  // collapse chain methods to `never` for non-audio types. No runtime
  // execution occurs (guarded by `if (false)`; only the TS checker runs).
  // If a `@ts-expect-error` stops being satisfied, it means the guard has
  // regressed and a build error surfaces.
  if (false as boolean) {
    // @ts-expect-error T = number for `expect(1)`, chain method resolves to never.
    expect(1).toMatchAudio([new Float32Array(8)]);
    // @ts-expect-error T = string for `expect("foo")`, chain method is never.
    expect("foo").toBeStable();
    // @ts-expect-error T = null for `expect(null)`, chain method is never.
    expect(null).toHavePeakUnder(-6);
    // @ts-expect-error `toMatchAudioSnapshot` accepts Float32Array but a
    // non-audio actual (number) resolves to never via `WhenAudioActual`.
    expect(1).toMatchAudioSnapshot();
    // `toMatchAudioSnapshot` with a Float32Array actual is valid via
    // `WhenAudioActual` — no @ts-expect-error needed.
    void expect(new Float32Array(8)).toMatchAudioSnapshot();
    // Same for Float32Array[] direct actual — typecheck passes.
    void expect([new Float32Array(8)]).toMatchAudioSnapshot();
  }
});

test("`@vitest/expect` is a required peer, because the shipped augmentation cannot resolve without it", () => {
  // `extend.ts` is a module, so its `declare module "@vitest/expect"` is an
  // augmentation — and an augmentation whose target cannot be resolved is
  // `TS2664: Invalid module name in augmentation`, raised inside a file the
  // consumer did not write. Under a hoisting install it resolves transitively
  // through vitest and nobody notices; under pnpm / PnP it does not. Declaring the
  // peer optional therefore declared something untrue. Reported by @codex on #43.
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as {
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  expect(pkg.peerDependencies?.["@vitest/expect"]).toBeDefined();
  expect(pkg.peerDependenciesMeta?.["@vitest/expect"]?.optional).not.toBe(true);
});
