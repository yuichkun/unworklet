# @unworklet/test

Assertions and signal generators for testing unworklet processors. Render with
`@unworklet/offline`, then assert on the audio, events, MIDI, and state. Works
with any Vitest-compatible runner.

```bash
npm install -D @unworklet/test @unworklet/offline @unworklet/core vitest
```

(`vitest` is a peer dependency — `@unworklet/test` imports `expect` from it.)

## Usage

```ts
import { test } from "vitest";
import { renderOffline } from "@unworklet/offline";
import { sine, expectNoNaN, expectGainAtFreq, expectStable } from "@unworklet/test";
import { lowpass } from "./lowpass.ts";

test("lowpass attenuates 10 kHz", async () => {
  const result = await renderOffline(lowpass, {
    sampleRate: 48000,
    duration: 0.5,
    inputs: { main: [sine({ freqHz: 10000, durationSamples: 24000, sampleRate: 48000 })] },
  });
  expectNoNaN(result);
  expectStable(result); // finite, no runaway DC / clipping
  expectGainAtFreq(result, 10000, -24, 3); // ~-24 dB ± 3 at 10 kHz
});
```

## Matchers (function form)

- **Audio:** `expectAudioMatches`, `expectAudioMatchesGolden` (WAV file),
  `expectAudioMatchesSnapshot`, `expectAudioMatchesSnapshotWithState`.
- **Levels / stability:** `expectNoNaN`, `expectPeakUnder`, `expectRmsUnder`,
  `expectStable`, `expectMaster`, `expectSilence`, `expectDcOffsetUnder`.
- **Time / frequency:** `expectPeakAtSample`, `expectLatency`, `expectGainAtFreq`.
- **Events / state / MIDI:** `expectEventsEqual`, `expectEventsContaining`,
  `expectEventCount`, `expectStateMatches`, `expectMidiOut`, `expectMidiBalance`.

`expectLatency` and `expectGainAtFreq` take a trailing `opts`. On a **multichannel**
port you must pass `{ channel }` to choose which channel to measure —
`expectGainAtFreq(result, 10000, -24, 3, { channel: 1 })` — so a broken non-first
channel can't slip by; a mono port defaults to channel 0. `expectPeakAtSample`
instead reduces across all channels for the global peak and selects the port via
`{ port }` (no per-channel option).

## Generators & helpers

- **Signals:** `sine`, `silence`, `impulse`, `sineSweep`, `whiteNoise`, `dc`, `ramp`.
- **MIDI:** `midi.noteOn`, `midi.noteOff`, `midi.cc`, `midi.pitchBend`,
  `midi.programChange`, `midi.channelPressure`, `midi.aftertouch`,
  `midi.systemRealtime`, `midi.sysex`, `midi.sequence`.
- **Time:** `samplesToMs`, `msToSamples`, `samplesToSec`, `secToSamples`,
  `bpmToSamples`, `bpmToMs`.

## Vitest chain form

Import `@unworklet/test/extend` once to get fluent matchers:
`expect(result).toMatchAudio(...)`, `.toBeStable()`, `.toHaveGainAtFreq(...)`,
`.toEmitMidi(...)`, and so on. Put the import in a setup file and register it in
your Vitest config:

```ts
// vitest.setup.ts
import "@unworklet/test/extend";

// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { setupFiles: ["./vitest.setup.ts"] } });
```

## Related packages

- `@unworklet/offline` — the renderer these matchers assert on (`renderOffline`).
- `@unworklet/core` — define the processor under test (`defineProcessor`, the DSL primitives).
- `@unworklet/lang` — write processors in `.uwk.ts` sugar.
- `@unworklet/unplugin` — load processors in the browser via `?worklet`, plus DevTools.

License: MIT.
