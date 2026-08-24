# Testing unworklet processors

Test stack: render with `@unworklet/offline` (`renderOffline` = the deterministic
Node oracle) → assert with `@unworklet/test` matchers + signal/MIDI/time helpers.
**USE these matchers — never hand-roll audio assertions.** Do not loop samples to
compute RMS/peak/NaN/latency/FFT yourself; the named matchers are exact and report
the failure for you. Plain matcher functions throw on failure under any runner; an
optional `expect(...).to…()` chain form is available via one side-effect import.

The processor under test is authored in `.uwk.ts` (PRIMARY / recommended form — see
`dsl.md`) or in the `.processor.ts` core method API (`defineProcessor`; the secondary
explicit alternative — see `dsl.md`). Either way it reduces to a
`CompiledProcessor` you feed to `renderOffline`.

## Package specifiers (exact)

Cite `packages/test/package.json` (exports `.` + `./extend`), `packages/offline/package.json` (exports `.`).

- `@unworklet/offline` → `renderOffline`, `encodeWav`, `decodeWav` (+ types).
- `@unworklet/test` → all plain matchers + `sine` / `midi` / etc. helpers.
- `@unworklet/test/extend` → side-effect import; registers the 19 chain matchers via `expect.extend`.
- `@unworklet/test` peer-deps `vitest@^3 || ^4` and `@unworklet/core` (it imports `expect` from `vitest`).
- Processor source: `@unworklet/core` `defineProcessor` (`.processor.ts`), or a `.uwk.ts` lowered to a `CompiledProcessor` via `lowerToProcessor` from `@unworklet/lang/browser` (`packages/lang/src/browser.ts:38`).

## Import `expect` / `test`

Cite `packages/test/README.md`, `examples/demo/src/examples.render.test.ts:31`, `packages/test/src/index.test.ts:13`.

- Plain matchers need NO `expect.extend` and NO special `expect` — they throw `Error`
  and the runner reports it. Import `test` from your runner:
  - stock vitest consumer: `import { test } from "vitest";`
  - this Vite+ repo: `import { expect, test } from "vite-plus/test";`
- Chain form: add once `import "@unworklet/test/extend";` (ideally a setupFile).
  Two type augmentations ship: `declare module "vitest"` (`packages/test/src/extend.ts:130`)
  AND `declare module "@vitest/expect"` (`extend.ts:143`). Stock vitest re-exports
  `Assertion` from `@vitest/expect`, so a `vitest`-only augmentation would type-check
  as a fresh unused interface; the `@vitest/expect` one is what actually makes
  `expect(...).toBeCloseToArray(...)` etc. resolve. Both are shipped, so consumers on
  stock vitest 4 get the chain-method types automatically. The Vite+ fork bridges the
  same types via dev-only `packages/test/src/fork-assertion.d.ts` (`declare module
"vite-plus/test"`, NOT shipped).

  Because that augmentation has to resolve `@vitest/expect`, it is a **required
  peer** of `@unworklet/test`, not an optional one. npm installs it for you; under
  pnpm or Yarn PnP, where a dependency's dependencies are not visible to siblings,
  add it explicitly (`pnpm add -D @vitest/expect`) or the shipped types fail with
  `TS2664: Invalid module name in augmentation`.

```ts
// vitest.setup.ts
import "@unworklet/test/extend";
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { setupFiles: ["./vitest.setup.ts"] } });
```

## `renderOffline` — the Node oracle

Cite `packages/offline/src/index.ts:124` (signature), `:64-84` (config), `:110-119` (result).

```ts
import { renderOffline } from "@unworklet/offline";
function renderOffline<C>(
  processor: CompiledProcessor<C>, // defineProcessor(...) OR lowerToProcessor(uwkSource)
  config: RenderOfflineConfig,
): Promise<RenderOfflineResult>; // ASYNC — await it
```

`RenderOfflineConfig`:

- `sampleRate: number`
- `duration: number` — seconds; rounded UP to a 128-sample block. totalSamples = `ceil(duration*sampleRate/128)*128` (`SAMPLES_PER_BLOCK=128`, `packages/core/src/dsl/constants.ts:11`).
- `inputs?: Record<string, Float32Array[]>` — key = `audioInput({name})` port; value = per-channel arrays.
- `params?: Record<string, number[]>` — key = `param.named(...)`. `[]` / omitted = declared default; length 1 = constant; length > 1 = per-sample automation.
- `messages?: { name: string; payload: unknown; atQuantum?: number }[]` — main→worklet (block index, default 0).
- `events?: { name: string; payload: unknown; atSample: number }[]` — inbound events / MIDI; `atSample` is ABSOLUTE.
- `profile?: string`, `restore?: Uint8Array` (initial-state injection + migration).

`RenderOfflineResult`:

- `outputs: Record<string, Float32Array[]>` — per `audioOutput({name})` port.
- `events: { name: string; payload: unknown; atSample: number }[]` — emitted (worklet→main + `midiOutput`). `atSample` is BLOCK-LOCAL (0..127), NOT absolute.
- `state: Uint8Array` — end-of-render snapshot blob (persistent slots).
- `sampleRate: number` — carried through from config.
- `diagnostics.scrubbedSamples: number` — output samples the compiled processor's
  non-finite scrub replaced with 0 (a NaN / ±Inf the DSP produced: `0/0`, `x/0`,
  a runaway accumulator). `0` for a healthy render; assert it when a processor
  divides or feeds back, because the scrubbed output itself looks like clean
  silence.

Repeat renders of the SAME processor value at the SAME `sampleRate` reuse the
compiled artifact automatically (the compile dominates wall time; instantiation
is fresh per render, so state never leaks between renders). Write one render per
test naturally — no manual memoization. A processor is treated as immutable once
rendered.

## Plain matchers — USE these (exact names + signatures)

Cite `packages/test/src/index.ts`. `result` = `RenderOfflineResult` (a hand-built
result-shaped object is also accepted — `diagnostics` is optional on the matcher
input side, exported as `RenderResultLike`). All throw on failure; `void` return
unless noted.

Audio compare:

- `expectAudioMatches(actual, expected: RenderOfflineResult | Float32Array[], opts?: { tolerance?: number })` — default tolerance `0` (bit-exact). `Float32Array[]` form requires single-port actual; multi-port: pass full `RenderOfflineResult` (compares port set + sampleRate). (`:136`)
- `expectAudioMatchesGolden(actual, wavPath: string, opts?: { tolerance?: number })` — compares vs a WAV file; sampleRate must match; single-port only. (`:319`)
- `await expectAudioMatchesSnapshot(actual: RenderOfflineResult | Float32Array | Float32Array[], opts?: SnapshotOptions): Promise<void>` — vitest-style auto WAV snapshot; first run writes, later runs bit-exact; `vitest -u` overwrites; `--ci` fails if missing. (`:589`)
- `await expectAudioMatchesSnapshotWithState(actual, opts: SnapshotOptions, state): Promise<void>` — state-explicit worker, concurrent-safe (the chain form uses this). (`:463`)

Level / stability:

- `expectNoNaN(result)` — no NaN / ±Infinity. (`:184`)
- `expectStable(result)` — finite-check alias (no NaN/Inf), level-agnostic. (`:609`)
- `expectPeakUnder(result, dbfs: number)` — peak < dBFS. (`:195`)
- `expectRmsUnder(result, dbfs: number)` — RMS < dBFS. (`:223`)
- `expectMaster(result, opts?: { peakDbfs?: number; rmsDbfs?: number })` — defaults peak `-0.1`, rms `-14`; always also NaN-checks. (`:628`)
- `expectSilence(result, opts?: { tolerance?: number })` — every sample 0 ± tol (default 0). (`:642`)
- `expectDcOffsetUnder(result, threshold: number)` — |mean| per channel < threshold. (`:954`)

Timing / spectrum (single-port; multichannel needs `channel`):

- `expectPeakAtSample(result, expectedAtSample: number, opts?: { tolerance?: number; port?: string })` — index of max|x|; multi-PORT needs `port`. (`:680`)
- `expectLatency(result, expectedSamples: number, opts?: { tolerance?: number; channel?: number })` — impulse delay; single-port; multichannel needs `channel`. (`:891`)
- `expectGainAtFreq(result, freqHz: number, expectedDb: number, tolerance: number, opts?: { channel?: number })` — internal FFT; `tolerance` is the POSITIONAL 4th arg; single-port; multichannel needs `channel`. (`:812`)

Events / MIDI / state:

- `expectEventsEqual(result, expectedEvents: ExpectedEvent[])` — exact ordered name+payload+atSample. `ExpectedEvent = { name: string; payload: unknown; atSample: number }`. (`:252`, `:37`)
- `expectEventsContaining(result, partial: PartialExpectedEvent[])` — each partial exists (unordered, extras OK). `PartialExpectedEvent = { name: string; payload?: unknown; atSample?: number }`. (`:1008`, `:995`)
- `expectEventCount(result, name: string, expectedCount: number)`. (`:980`)
- `expectStateMatches(result, expectedSnapshot: Uint8Array)` — byte-exact snapshot blob. (`:290`)
- `expectMidiOut(result, portName: string, expectedMidiEvents: ExpectedMidiEvent[], opts?: { tolerance?: number })` — ordered MIDI on a `midiOutput` / `event.midi({to})` port. `ExpectedMidiEvent = MidiEvent & { atSample?: number }` (omit `atSample` = ignore timing). (`:1044`, `:1032`)
- `expectMidiBalance(result, portName: string, opts?: { hangingNotes?: number })` — noteOn/noteOff balance; a stray noteOff always fails. `hangingNotes` is an upper bound (default `0`) on unclosed noteOns; there is no "unlimited" sentinel — passing `-1` / `Infinity` does not disable the check and will still fail. If you only want to observe the count without asserting a bound, skip this matcher and read `result.events.filter((e) => e.name === portName && e.payload.type === "noteOn").length` directly. (`:1097`)

`SnapshotOptions = { snapshotPath?: string; snapshotName?: string; sampleRate?: number; tolerance?: number; port?: string }` (`:336`). Precedence: `snapshotPath` > `snapshotName` > auto-infer from test name.

## Signal generators (return `Float32Array`)

Cite `packages/test/src/index.ts:1158-1253`.

- `sine({ freqHz, durationSamples, sampleRate, amplitude?=1, phase?=0 })`
- `silence(durationSamples)`
- `impulse(durationSamples, opts?: { atSample?=0 })`
- `sineSweep({ startHz, endHz, durationSamples, sampleRate, type?: "lin"|"log" /*="log"*/, amplitude?=1 })`
- `whiteNoise({ durationSamples, amplitude?=1, seed?=1 })` — deterministic xorshift32
- `dc(durationSamples, value=1)`
- `ramp({ durationSamples, from, to })`

## MIDI builders — `midi` namespace

Cite `packages/test/src/index.ts:1273`. Each returns a `MidiEvent`; `channel` defaults `0`.

- `midi.noteOn({ note, velocity, channel?=0 })`
- `midi.noteOff({ note, velocity?=0, channel?=0 })`
- `midi.cc({ controller, value, channel?=0 })`
- `midi.pitchBend({ value, channel?=0 })`
- `midi.programChange({ program, channel?=0 })`
- `midi.channelPressure({ pressure, channel?=0 })`
- `midi.aftertouch({ note, pressure, channel?=0 })`
- `midi.systemRealtime(status: number)`
- `midi.sysex(bytes: Uint8Array)`
- `midi.sequence(portName: string, entries: { at: number; event: MidiEvent }[]): OfflineEvent[]` — spreads straight into `config.events`.

## Sample / time helpers

Cite `packages/test/src/index.ts:1341-1372`.

- `samplesToMs(samples, sampleRate)` / `msToSamples(ms, sampleRate)`
- `samplesToSec(samples, sampleRate)` / `secToSamples(sec, sampleRate)`
- `bpmToSamples({ bpm, division, sampleRate })` / `bpmToMs({ bpm, division })`
- `Division = "1/1"|"1/2"|"1/4"|"1/8"|"1/16"|"1/32"`.

## Chain form (`@unworklet/test/extend`) — 19 matchers

Cite `packages/test/src/extend.ts:201-221` (registrations), `:92-128` (typed interface).
Names are NOT 1:1 with plain fn names. A method exists only when `expect(value)`'s value
is a `RenderOfflineResult` (otherwise its type is `never` = build error); `toMatchAudioSnapshot`
also accepts `Float32Array | Float32Array[]`.

- `toMatchAudio(expected, opts?)` = `expectAudioMatches`
- `toMatchAudioFile(wavPath, opts?)` = `expectAudioMatchesGolden`
- `await toMatchAudioSnapshot(opts?)` = `expectAudioMatchesSnapshot` (async)
- `toBeFinite()` = `expectNoNaN`
- `toHavePeakUnder(dbfs)` = `expectPeakUnder`
- `toHaveRmsUnder(dbfs)` = `expectRmsUnder`
- `toBeStable()` = `expectStable`
- `toBeMasterReady(opts?)` = `expectMaster`
- `toBeSilent(opts?)` = `expectSilence`
- `toHavePeakAtSample(expectedAtSample, opts?)` = `expectPeakAtSample`
- `toHaveGainAtFreq(freqHz, expectedDb, tolerance, opts?)` = `expectGainAtFreq`
- `toHaveLatency(expectedSamples, opts?)` = `expectLatency`
- `toHaveDcOffsetUnder(threshold)` = `expectDcOffsetUnder`
- `toMatchEvents(expectedEvents)` = `expectEventsEqual`
- `toHaveEventCount(name, expectedCount)` = `expectEventCount`
- `toContainEvents(partial)` = `expectEventsContaining`
- `toEmitMidi(portName, expectedMidiEvents, opts?)` = `expectMidiOut`
- `toHaveBalancedMidi(portName, opts?)` = `expectMidiBalance`
- `toMatchState(expectedSnapshot)` = `expectStateMatches`

```ts
// after `import "@unworklet/test/extend"`
expect(result).toBeStable();
expect(result).toHavePeakUnder(-6);
await expect(result).toMatchAudioSnapshot(); // async matcher
expect(result).toEmitMidi("out", [midi.noteOn({ note: 72, velocity: 100 })]);
```

## Complete real test — PRIMARY: `.uwk.ts` processor

The processor is authored in `.uwk.ts` (the recommended form; full authoring in
`dsl.md`). Two ways to get from a `.uwk.ts` on disk to a `CompiledProcessor` a
`renderOffline` call can consume:

- **Single-file source string → `lowerToProcessor`** (`@unworklet/lang/browser`
  or `@unworklet/lang`, `packages/lang/src/browser.ts:38`). Fast, no disk
  materialisation. **Only single-file**: throws if the `.uwk.ts` imports from a
  sibling (subgraph library module split into its own file — the pattern
  `dsl.md §4` recommends). Use for the common case where the whole processor
  lives in one file.
- **Multi-file entry path → `loadUwkProcessor`** (`@unworklet/lang`,
  `packages/lang/src/index.ts`). Materialises the entry `.uwk.ts` and every
  sibling `.uwk.ts` it imports as temp `.uwklowered.mjs` files next to their
  sources, dynamically imports the entry, and returns the `CompiledProcessor`.
  This is the offline / test counterpart to the Vite plugin's `?worklet`
  build-path import — reach for it when the processor splits into a subgraph
  library module.

  Sibling `.uwk.ts` imports are lowered to JavaScript for you, so they run on any
  supported Node. A plain TypeScript helper (`import { GAIN } from "./constants.ts"`)
  is left as you wrote it, so loading it needs a Node that strips types
  (22.18+ / 23.6+) AND a helper that is erasable — stripping removes annotations
  but cannot build an `enum`, a `namespace` or a parameter property, which Node
  transforms only behind `--experimental-transform-types`. Either case reports an
  error naming the import. Give the helper a `.mjs` extension (or keep it
  erasable — a `const` object rather than an `enum`) to avoid both.

Single-file pattern from `examples/demo/src/examples.render.test.ts:14-85`:

```ts
import { renderOffline } from "@unworklet/offline";
import { dc, expectStable, expectPeakUnder } from "@unworklet/test";
import { expect, test } from "vite-plus/test"; // stock vitest: from "vitest"
import { lowerToProcessor } from "@unworklet/lang/browser";

const SR = 48_000,
  FRAMES = 2048;

test("lowpass: a step input ramps smoothly toward it", async () => {
  const processor = lowerToProcessor(lowpassUwkSource); // single-file .uwk.ts source → CompiledProcessor
  const r = await renderOffline(processor, {
    sampleRate: SR,
    duration: FRAMES / SR,
    inputs: { main: [dc(FRAMES), dc(FRAMES)] }, // 2-ch step input
  });
  expectStable(r); // USE matchers: finite, no runaway
  expectPeakUnder(r, 0.1); // never overshoots the input
  expect(r.outputs.main![0]![FRAMES - 1]!).toBeGreaterThan(0.99); // converged
});
```

Multi-file pattern (processor + sibling subgraph):

```ts
import { fileURLToPath } from "node:url";

import { loadUwkProcessor } from "@unworklet/lang";
import { renderOffline } from "@unworklet/offline";
import { expect, test } from "vite-plus/test";

test("subgraph split across files renders correctly", async () => {
  // `./main.uwk.ts` imports `./gainStep.uwk.ts`. loadUwkProcessor handles
  // both — lower each, materialise temp siblings, dynamic-import the entry.
  // `fileURLToPath`, not `.pathname`: the latter yields `/C:/…` on Windows and
  // leaves `%20` in place, so the path never resolves.
  const processor = await loadUwkProcessor(
    fileURLToPath(new URL("./main.uwk.ts", import.meta.url)),
  );
  const r = await renderOffline(processor, {
    sampleRate: 48000,
    duration: 128 / 48000,
    inputs: { main: [new Float32Array(128).fill(0.1)] },
  });
  expect(r.outputs.main![0]![64]).toBeCloseTo(0.3);
});
```

A `.uwk.ts` source is bare top-level declarations + a bare `process(() => forSample(...))`
— no `defineProcessor` wrapper, no imports (`packages/unplugin/__fixtures__/stereo-gain.uwk.ts`; full rules in `dsl.md`):

```ts
// stereo-gain.uwk.ts   (// @ts-nocheck — the plugin lowers it at build)
const input = audioInput({ channels: 2, name: "main" });
const out = audioOutput({ channels: 2, name: "main" });
const gain = param.f32({ default: 1.0, min: 0.0, max: 4.0, automationRate: "a-rate" });
process(() => {
  forSample((i) => {
    out.left[i] = input.left[i] * gain[i];
    out.right[i] = input.right[i] * gain[i];
  });
});
```

A shipped consumer instead `import`s the `.uwk.ts` default export (compiled by
`@unworklet/unplugin` via `?worklet`; see `setup.md`) and passes the resulting
`CompiledProcessor` straight to `renderOffline`.

## Complete real test — SECONDARY: explicit core method API (`.processor.ts`)

Hand-write the processor with `defineProcessor` from `@unworklet/core` and pass it
directly to `renderOffline`. Use this only when you need a surface `.uwk.ts` does not
expose. End-to-end from `packages/test/src/midi-integration.test.ts:8-101`:

```ts
import { defineProcessor, event, state } from "@unworklet/core";
import { renderOffline } from "@unworklet/offline";
import { expect, test } from "vite-plus/test";
import { expectMidiOut, expectMidiBalance, midi } from "@unworklet/test";

const noteThru = defineProcessor(() => {
  const inPort = event.midi({ from: "main", name: "in" });
  const outPort = event.midi({ to: "main", name: "out" });
  // ... re-emit each inbound note up an octave ...
  return {
    process: () => {
      /* ... */
    },
  };
});

test("expectMidiOut matches the re-emitted notes from a real render", async () => {
  const result = await renderOffline(noteThru, {
    sampleRate: 48000,
    duration: 256 / 48000,
    events: midi.sequence("in", [
      { at: 0, event: midi.noteOn({ note: 60, velocity: 100 }) },
      { at: 128, event: midi.noteOff({ note: 60 }) },
    ]),
  });
  expectMidiOut(result, "out", [
    { type: "noteOn", channel: 0, note: 72, velocity: 100, atSample: 0 }, // block-local atSample
    { type: "noteOff", channel: 0, note: 72, velocity: 0, atSample: 0 },
  ]);
  expectMidiBalance(result, "out");
});
```

## Rules of thumb (verified)

- USE the matchers; never hand-roll audio assertions (no manual sample loops for RMS / peak / NaN / latency / FFT). Drop to inline `expect(...).toBeCloseTo(...)` only for a one-off positive check the matcher set has no equivalent for (e.g. "reaches a level").
- `renderOffline` is ASYNC — always `await`. (`packages/offline/src/index.ts:124`)
- Emitted `result.events[].atSample` is block-local (0..127); config inbound `events[].atSample` is absolute. (`packages/offline/src/index.ts:355,476`)
- `expectGainAtFreq` `tolerance` is the positional 4th arg, not in `opts`. (`packages/test/src/index.ts:812`)
- Multichannel ports: `expectGainAtFreq` / `expectLatency` require `{ channel }`; multi-PORT results require `{ port }` (`expectPeakAtSample`) or the full-result form — else they throw.
- Plain matchers need no setup; the chain form needs the one-time `import "@unworklet/test/extend"`.
- Renders are deterministic: default `expectAudioMatches` tolerance is `0` (bit-exact), snapshots compare bit-exact across runs, and `whiteNoise` is seeded — so re-running the same config reproduces the same outputs + `state`.
