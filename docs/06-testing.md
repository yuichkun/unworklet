# 06 — Testing (`@unworklet/test`)

Vitest matchers and audio test utilities for unworklet processors. Wraps `@unworklet/offline` (see `13-offline-render.md`) and provides audio-domain assertions, input signal construction, MIDI event construction, and sample/time conversion. Everything runs deterministically without a browser (host JS WebAssembly runtime path; see `13-offline-render.md` §3).

## Status

42 matchers implemented (19 audio/signal/event/MIDI/state matchers + 7 signal utilities + 10 MIDI utilities + 6 sample-time utilities) with all 19 chain-form equivalents and TypeScript-only chain typing guards (`WhenResult<T, M>` / `WhenAudioActual<T, M>`). `expectStateValue` (asserts a snapshot blob slot value) depends on upstream `inspect` (see `05-client.md` §2.6) and is planned to ship alongside it in Phase 11 in both plain and chain forms; it is excluded from the current export surface (the principle: never ship a public API that always throws — v1.0.0 surface contains only working matchers).

### Upstream dependency status (renderer capture status)

All matchers are implemented and work correctly when given a `RenderOfflineResult`. Impact by capture status of `renderOffline`:

- **`expectEventsEqual` / `expectEventCount` / `expectEventsContaining`** compare `renderOffline.events` directly. Event capture in `renderOffline` is implemented (main → worklet `event<T>({ from: "main" })` injection and worklet → main `event<T>({ to: "main" })` capture, including typed-array payloads). `events` carries real data from a real `renderOffline` call, so end-to-end event assertions pass as-is.
- **`expectMidiOut` / `expectMidiBalance`** — while the MIDI renderer is not yet implemented (see `10-roadmap.md` §Phase 9), `renderOffline` does not capture MIDI, so `midiEvents` is always `[]`. An assertion expecting empty passes spuriously; an assertion expecting non-empty fails loudly. Using these matchers against a hand-built `RenderOfflineResult` (a test fixture) is safe; end-to-end use against real `renderOffline` output awaits Phase 9.
- **`expectStateMatches`** — until Phase 11 (snapshot/restore) fills in `state` capture in the renderer, `state` is always `new Uint8Array(0)` (an empty blob stub). An assertion expecting an empty blob passes spuriously; a non-empty expectation fails loudly with a length mismatch.
- **`RenderOfflineResult.sampleRate`** carries `config.sampleRate` as reliable metadata (used by `expectAudioMatches` / `expectAudioMatchesGolden` for sample-rate comparison). The processor's `ctx.sampleRate` is a Phase 3 placeholder equal to `0`; code paths that read `ctx.sampleRate` directly inside DSP do not receive the real rate (core-side plumbing is a later phase). Within this phase, sample-rate comparison catches metadata mismatches (same PCM, different rate label); the path where a processor reads `ctx.sampleRate` to compute a result and that result is compared against the real rate awaits the core-side fix — this is independent of matcher behavior.

Summary: matchers behave correctly against their input contract (`RenderOfflineResult`); each end-to-end usage path opens as the upstream renderer produces real data. End-to-end verification works for audio output and event paths (both directions of `event<T>` capture are implemented). MIDI and state paths unlock in subsequent phases (see `10-roadmap.md` §Phase 9 / Phase 11).

## 1. Relationship to `@unworklet/offline`

`@unworklet/test` does **not** re-implement rendering. It calls `renderOffline` from `@unworklet/offline` internally and layers audio-domain assertions on top of the returned `RenderOfflineResult` (`{ outputs, events, state }`). This split allows offline rendering to be used standalone in server-side, batch, or preview-UI contexts (see `13-offline-render.md` §1), while test-specific concerns (matchers, golden files, signal utilities, etc.) are consolidated here.

Standard MIDI File loader (`loadSmf` / `parseSmf`) is outside the v1.0.0 ship scope; see `10-roadmap.md` §3.2 for the planned additive addition (verifying synth/arp output against a known MIDI song as input).

## 2. Matchers (19 + `expectStateValue` in Phase 11)

All matchers are declared as **plain functions**. On failure they throw an `Error`; Vitest catches it and reports the test as failed. The chain form (via `expect.extend(...)`) is declared separately in §6 and coexists with the plain form.

Result type: `RenderOfflineResult` = `{ outputs: Record<string, Float32Array[]>, events: OfflineEmittedEvent[], state: Uint8Array }` (see `13-offline-render.md` §2).

All numerical matchers (audio compare, golden, snapshot, peak, RMS, silence, peak-at, gain-at-freq, latency, DC offset) run a guard equivalent to `expectNoNaN` at the top, unconditionally failing on NaN or ±Infinity input. The reason: `Math.abs(NaN) > x` evaluates to `false` and `NaN >= x` evaluates to `false`, so numeric comparison matchers would silently pass NaN inputs and allow catastrophic DSP failures to go undetected. This guard closes that path mechanically, so matchers are self-defending even without a separate `expectStable` call. `expectAudioMatches` / `expectAudioMatchesGolden` guard both actual and expected (including the reference side, to prevent a corrupted golden or NaN fixture from being frozen in place).

### 2.1 Audio matchers

- **`expectAudioMatches(actual, expected, opts?)`** — sample-by-sample comparison. `expected` type: `RenderOfflineResult | Float32Array[]` (full-result form or single-port form). `opts.tolerance` defaults to `0` (bit-exact; satisfied naturally by `renderOffline`'s determinism guarantee). Passing a `Float32Array[]` when there are multiple ports is ambiguous and throws; consumers should use the full result form in that case. When passed as `RenderOfflineResult`, `actual.sampleRate` and `expected.sampleRate` must match (same PCM with different rate labels would be a pitch/timing bug passed off as correct); when passed as `Float32Array[]`, the data is a raw buffer with no rate metadata so no rate comparison is performed (rate-sensitive consumers should use the full result form).
- **`expectAudioMatchesGolden(actual, wavPath, opts?)`** — decodes an explicit WAV fixture and compares bit-exactly. `opts.tolerance` defaults to `0`. Single-port only; throws for multiple ports. Intended for bringing in industry-standard reference files from outside the project. The WAV header's `sampleRate` is also checked against `actual.sampleRate` (same PCM at a different rate would introduce pitch/timing drift).
- **`expectAudioMatchesSnapshot(actual, opts?): Promise<void>`** — mirrors the Vitest `toMatchSnapshot` pattern. `actual` accepts three shapes: `RenderOfflineResult` (sample rate from `result.sampleRate`), `Float32Array` (mono, single channel, `opts.sampleRate` defaults to `48000`), or `Float32Array[]` (multi-channel, same default) — allowing signal generator output to be passed directly without wrapping. Path resolution priority: (1) `opts.snapshotPath` explicit — used as the full path verbatim; (2) `opts.snapshotName` explicit — resolves to `<test-file-dir>/__snapshots__/<safe(snapshotName)>.wav` (no test-file base prefix, no counter; the consumer is responsible for unique naming independently of the test name); (3) both omitted — auto-infer: `<test-file-dir>/__snapshots__/<test-file-base>__<safe(test-name)>_<hash8>__<counter>.wav`, where an 8-digit FNV-1a hash derived from the test name disambiguates different test names that produce the same sanitized slug (e.g. "foo bar" vs "foo!bar"). Sanitization preserves Unicode and replaces only filesystem-unsafe characters (`/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`), whitespace, and control characters with `_`; if the sanitized result of `snapshotName` is empty, throws (to prevent creating a hidden `.wav` file). First run: snapshot absent → WAV is written automatically and the test passes (ear-check path, development-oriented). Subsequent runs: bit-exact comparison. `vitest -u` forces overwrite. CI mode: fails when snapshot is absent. **Concurrent test note**: the plain function form reads `testPath`, `currentTestName`, and snapshot mode from `expect.getState()` globally, which creates a race condition under `test.concurrent` where another test's state may be read; this is a sequential-test path. When using auto-infer or `snapshotName` paths under `test.concurrent`, use the chain form (`expect(actual).toMatchAudioSnapshot(opts?)` via `@unworklet/test/extend`), which uses the per-test-bound `MatcherState` (`this.testPath` / `this.currentTestName` / `this.snapshotState`) provided by `expect.extend` and avoids the race. Providing `opts.snapshotPath` explicitly requires no state reads and is safe in concurrent tests. **Retry / watch note**: the auto-infer counter uses a test-boundary heuristic (resets when the test key changes) that handles sequential reruns, but when the same test is invoked repeatedly within the same process (e.g. Vitest retry), the counter may drift and create new files (`_2.wav`, `_3.wav`, etc.); tests that use retry are recommended to provide an explicit `snapshotName` or `snapshotPath`.

### 2.2 Sample-level matchers

- **`expectNoNaN(result)`** — scans all channels in `result.outputs`; throws on NaN or ±Infinity.
- **`expectPeakUnder(result, dbfs)`** — converts peak absolute value to dBFS via 20·log10; throws if at or above threshold.
- **`expectRmsUnder(result, dbfs)`** — converts the root-mean-square of all channels to dBFS; throws if at or above threshold.
- **`expectStable(result)`** — one-line wrapper asserting no NaN and all samples finite (no divergence). Sanity check for stability of IIR feedback or long renders. Audio level is not checked (clipping passes).
- **`expectMaster(result, opts?: { peakDbfs?, rmsDbfs? })`** — master bus default check: no NaN + peak < `opts.peakDbfs` (default `-0.1`) + RMS < `opts.rmsDbfs` (default `-14`), wrapped in one call. `expectStable` ⊂ `expectMaster`: master implies stable and additionally catches clipping and excessive loudness. NaN check is always on (uniform across all numerical matchers; no escape hatch).
- **`expectSilence(result, opts?: { tolerance? })`** — all samples are 0 within tolerance (default `0`, bit-exact silence). Useful for pure MIDI processors, mute states, or immediately after startup.
- **`expectPeakAtSample(result, expectedAtSample, opts?: { tolerance?, port? })`** — time domain: asserts that the index of the maximum absolute value is within `expectedAtSample` ± `opts.tolerance` (in samples). Used for envelope attack peak position, impulse response peak position, etc. An all-zero buffer (silent, muted, or unresponsive processor) always throws with "no detectable response" — sample 0 is never passed as the peak, catching mute regressions.
- **`expectGainAtFreq(result, freqHz, expectedDb, tolerance, opts?: { channel? })`** — frequency domain: via internal FFT, asserts that the dB gain around `freqHz` is within `expectedDb` ± `tolerance`. Core of EQ testing. Single-channel port defaults to channel 0; multi-channel port requires `opts.channel` (throws if not provided, preventing silent blind spots).
- **`expectLatency(result, expectedSamples, opts?: { tolerance?, channel? })`** — measures the delay in samples from an input impulse to the output's maximum absolute value index and asserts it. Guarantees the designed latency of a lookahead processor. Channel inference follows the same rule as `expectGainAtFreq` (single: automatic; multi: required). An all-zero buffer (processing failure or impulse not passed through) always throws with "no detectable response", matching `expectPeakAtSample` behavior.
- **`expectDcOffsetUnder(result, threshold)`** — asserts that the absolute mean of all samples (DC bias) is below threshold. Verifies DC behavior of filters and EQ.

### 2.3 Event matchers

- **`expectEventsEqual(result, expectedEvents)`** — compares `result.events` (`{ name, payload, atSample }[]`) against expected events with strict ordering, full count, and exact payload match.
- **`expectEventCount(result, name, expectedCount)`** — asserts the count of events with a specific name (order and payload are not checked).
- **`expectEventsContaining(result, partial)`** — partial match: asserts that each entry in `partial` exists somewhere in `result.events`. Order-independent; extra events are allowed.

### 2.4 MIDI matchers

- **`expectMidiOut(result, portName, expectedMidiEvents, opts?)`** — compares the sequence of MIDI events emitted via a specific `event.midi({ to: "main", name })` port against `MidiEvent` values (see `11-midi.md` §2.2). `result.events[i].payload` follows the `13-offline-render.md` §2 contract and carries the same value passed to the online handler — it directly holds the `MidiEvent` structure (wire bytes are an internal compiler concern, as described in `11-midi.md` §4; they never appear on the author/consumer surface). The matcher compares the structured payload directly.
- **`expectMidiBalance(result, portName, opts?: { hangingNotes? })`** — asserts that noteOn/noteOff pairs are balanced. Hanging notes (a noteOn with no matching noteOff) are tolerated up to `opts.hangingNotes` (default `0`). Stray noteOffs (a noteOff with no prior noteOn for the same `(channel, note)`, or more noteOffs than noteOns for a given pair) always fail — stray noteOffs are always a bug in MIDI lifecycle, so no tolerance option is provided. Implemented as a running counter over the time-ordered event stream, also detecting "noteOff before noteOn" patterns that net to zero.

### 2.5 State matchers

- **`expectStateMatches(result, expectedSnapshot)`** — byte-exact comparison of `result.state` (snapshot blob, `'persistent'` slots only) against the expected snapshot.
- **`expectStateValue(result, slotName, expectedValue)`** — _planned to ship with Phase 11; not exported in the current phase_. Designed to call `inspect` (see `05-client.md` §2.6) internally to retrieve a single slot value from the snapshot blob and assert it. Both plain and chain forms will be exported once upstream `inspect` is implemented.

### 2.6 Separation of concerns: audio output / events / state snapshot

`expectAudioMatches` (covers the entire DSP computation path at sample granularity), `expectEventsEqual` (verifies sample-accurate emission), and `expectStateMatches` (covers migration/restore round-trip paths) have **orthogonal responsibilities**. Bugs in transient slots (filter coefficients, phase accumulators, etc.) surface in audio output and are caught by `expectAudioMatches`. Bugs in `'persistent'` slots surface in blob round-trips and are caught by `expectStateMatches`. The three axes together provide full coverage.

## 3. Signal construction utility (7 functions)

Eliminates the boilerplate of constructing input signals manually with `new Float32Array(N)`. All functions are deterministic, preserving test reproducibility.

- **`sine(opts: { freqHz, durationSamples, sampleRate, amplitude?, phase? }): Float32Array`** — pure tone (`amplitude` defaults to `1`, `phase` defaults to `0` rad).
- **`silence(durationSamples): Float32Array`** — all zeros.
- **`impulse(durationSamples, opts?: { atSample? }): Float32Array`** — single sample at `1.0`, rest `0` (impulse response input). `atSample` defaults to `0`.
- **`sineSweep(opts: { startHz, endHz, durationSamples, sampleRate, type?: 'lin' | 'log', amplitude? }): Float32Array`** — frequency sweep (EQ test input). `type` defaults to `'log'`.
- **`whiteNoise(opts: { durationSamples, amplitude?, seed? }): Float32Array`** — deterministic with a fixed seed via xorshift or equivalent, guaranteeing test reproducibility.
- **`dc(durationSamples, value?): Float32Array`** — constant signal (DC gain tests, etc.). `value` defaults to `1`.
- **`ramp(opts: { durationSamples, from, to }): Float32Array`** — linear ramp (gain ramp, parameter automation simulation).

## 4. MIDI utility (10 functions)

### 4.1 MIDI event construction (namespace `midi`, 9 variants + sequence)

A namespace for constructing main-side `MidiEvent` values (see `11-midi.md` §2.2) to pass in the `events` array of `renderOffline`. All 9 variants are collected under one namespace to avoid top-level pollution.

```ts
const midi: {
  noteOn(opts: { note: number; velocity: number; channel?: number }): MidiEvent;
  noteOff(opts: { note: number; velocity?: number; channel?: number }): MidiEvent;
  cc(opts: { controller: number; value: number; channel?: number }): MidiEvent;
  pitchBend(opts: { value: number; channel?: number }): MidiEvent;
  programChange(opts: { program: number; channel?: number }): MidiEvent;
  channelPressure(opts: { pressure: number; channel?: number }): MidiEvent;
  aftertouch(opts: { note: number; pressure: number; channel?: number }): MidiEvent;
  systemRealtime(status: number): MidiEvent;
  sysex(bytes: Uint8Array): MidiEvent;
  sequence(portName: string, events: Array<{ at: number; event: MidiEvent }>): OfflineEvent[];
};
```

`midi.sequence(portName, events)` constructs an entire array at once and returns `OfflineEvent[]` (see `13-offline-render.md` §2), which can be passed directly to `renderOffline({ events })`. `channel` defaults to `0`; `noteOff` `velocity` defaults to `0`.

## 5. Sample / time conversion utility (6 functions)

One-liners for converting between samples, milliseconds, seconds, and BPM in DSP tests.

- **`samplesToMs(samples: number, sampleRate: number): number`**
- **`msToSamples(ms: number, sampleRate: number): number`**
- **`samplesToSec(samples: number, sampleRate: number): number`**
- **`secToSamples(sec: number, sampleRate: number): number`**
- **`bpmToSamples(opts: { bpm: number; division: Division; sampleRate: number }): number`** — beat to samples.
- **`bpmToMs(opts: { bpm: number; division: Division }): number`** — beat to milliseconds.

`Division` literal union (v1.0.0 core, 6 values):

```ts
type Division = "1/1" | "1/2" | "1/4" | "1/8" | "1/16" | "1/32";
```

Triplets (`'1/8t'` / `'1/16t'`) and dotted values (`'1/4d'` / `'1/8d'`) are outside the v1.0.0 ship scope; see `10-roadmap.md` §3.2 for the planned additive addition.

## 6. Matcher chain form (`expect.extend`)

A chain form (`expect(result).toMatchAudio(...)`) is also provided via Vitest's `expect.extend(...)` registration. It coexists with the plain function form (§2); both forms may be used within the same test. It is separated into a subpath `@unworklet/test/extend` so that a single import applies the registration to the entire test file, and consumers who do not use chain form do not include it in their bundle (tree-shake compatible):

```ts
import "@unworklet/test/extend"; // registers all 20 chain forms + TypeScript declare merge
```

### 6.1 Chain name conventions

Chain names align naturally with Vitest core conventions (`toBe` / `toHave` / `toMatch` / `toContain`, etc.). Axes:

- **`toBe...`** — state / adjective ("the result is X"). Examples: `toBeStable` / `toBeSilent` / `toBeFinite` / `toBeMasterReady`.
- **`toHave...`** — property value ("the result has X within bound"). Examples: `toHavePeakUnder(dbfs)` / `toHaveLatency(n)` / `toHaveDcOffsetUnder(threshold)`.
- **`toMatch...`** — pattern match ("the result matches Y"). Examples: `toMatchAudio(expected)` / `toMatchEvents(events)` / `toMatchState(blob)`.
- **`toContain...`** — partial match ("the result contains Z"). Examples: `toContainEvents(partial)`.
- Snapshot variants mirror Vitest's standard `toMatchSnapshot` / `toMatchFileSnapshot`. Examples: `toMatchAudioSnapshot()` / `toMatchAudioFile(path)`.
- Verb-based variants (MIDI emit, etc., analogous to Vitest's `toThrow`). Examples: `toEmitMidi(port, events)`.

Plain names and chain names are not mechanically 1:1 derived — chain names prioritize natural English. The plain ↔ chain mapping is carried bidirectionally in JSDoc on each plain function and chain method, resolvable via IDE hover.

The receiver type of chain methods is constrained by default so that, for example, `expect(result).toMatchAudio(...)` is only exposed on `RenderOfflineResult` (via the `WhenResult<T, M>` guard). Exception: `toMatchAudioSnapshot` widens to `WhenAudioActual<T, M>` to match the polymorphic `actual` of `expectAudioMatchesSnapshot` (`RenderOfflineResult | Float32Array | Float32Array[]`; see §2.1), allowing `expect(sine(...)).toMatchAudioSnapshot()` (signal generator output directly) and `expect([ch0, ch1]).toMatchAudioSnapshot()` (multi-channel buffer directly) to pass type-checking.

### 6.2 All 20 mappings

| plain                        | chain                  |
| ---------------------------- | ---------------------- |
| `expectAudioMatches`         | `toMatchAudio`         |
| `expectAudioMatchesGolden`   | `toMatchAudioFile`     |
| `expectAudioMatchesSnapshot` | `toMatchAudioSnapshot` |
| `expectNoNaN`                | `toBeFinite`           |
| `expectPeakUnder`            | `toHavePeakUnder`      |
| `expectRmsUnder`             | `toHaveRmsUnder`       |
| `expectStable`               | `toBeStable`           |
| `expectMaster`               | `toBeMasterReady`      |
| `expectSilence`              | `toBeSilent`           |
| `expectPeakAtSample`         | `toHavePeakAtSample`   |
| `expectGainAtFreq`           | `toHaveGainAtFreq`     |
| `expectLatency`              | `toHaveLatency`        |
| `expectDcOffsetUnder`        | `toHaveDcOffsetUnder`  |
| `expectEventsEqual`          | `toMatchEvents`        |
| `expectEventCount`           | `toHaveEventCount`     |
| `expectEventsContaining`     | `toContainEvents`      |
| `expectMidiOut`              | `toEmitMidi`           |
| `expectMidiBalance`          | `toHaveBalancedMidi`   |
| `expectStateMatches`         | `toMatchState`         |

## 7. Property-based test pattern

<!-- fast-check examples: bounded gain, stable feedback under random input, monotonicity invariants under parameter sweeps.
     The library does not bundle fast-check; the patterns are documented for users to wire up. -->

## 8. Vitest integration notes

<!-- Vite+ wraps Vitest; tests import from `vite-plus/test`, not `vitest`.
     See AGENTS.md for the Vite+ command surface. -->
