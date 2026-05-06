# unworklet

A TypeScript-first framework for declarative Audio Worklet DSP. Authors write
realtime-safe audio processors in pure TypeScript; the framework provides
declarations (`state` / `buffer` / `param`), per-sample loops (`forSample`),
typed messaging (`message<T>` / `event<T>`), MIDI ingestion / emission, opt-in
SIMD, and snapshot/restore.

This repository is the v1.0.0 implementation. See `docs/` for the authoritative
specification and `docs/12-canonical-examples.md` for the integrity-anchor
example set the implementation is verified against.

## Status

- **Backend**: WASM via binaryen.js, with f32x4 SIMD on hot paths.
  AudioWorkletGlobalScope-compatible per-processor JS module emitted alongside
  the binary; the playground and CLI both use it. JS interpreter (`@unworklet/core/internal`)
  mirrors the surface and is used for offline rendering, testing, and the
  host-side migration walk.
- **Surface**: full v1.0.0 DSL from `docs/01-dsl.md` exercised by 14 canonical
  showcases (12 from `docs/12-canonical-examples.md` + 2 extras: drum sampler,
  FM synth).
- **Tests**: 130 passing. Coverage:
  - 14/14 examples produce audible output (or are silent-by-design) on a real
    Chromium AudioWorklet via the headless smoke test.
  - Bit-exact golden WAV regression for 9 examples.
  - SIMD parity (f32x4 vs scalar within 1e-5 over 16 chirp blocks).
  - WASM ↔ JS-engine cross-validation per example.
  - Snapshot/restore round-trips through both transports, with schema-mismatch
    rejection and host-walked migrations.
  - Layer-3 static-analysis diagnostics (allocation-free, loop-bound, denormal-prone).
- **Decisions**: 21/27 entries in `docs/decisions-log.md` resolved. Q11 (browser
  quirks) and Q19 (channel-count specialization) remain open.

## Packages

| Package | Description |
|---|---|
| `@unworklet/core` | DSL: `defineProcessor`, primitives, declarations, `forSample`, `defineSubgraph`, MIDI, `flushDenormals` |
| `@unworklet/core/simd` | Opt-in SIMD primitives (`vec4`, `splat`, `mulVec`, `addVec`, …) |
| `@unworklet/compiler` | Capture → AST → memory layout → WASM emission via binaryen.js + per-processor worklet codegen |
| `@unworklet/client` | Main-thread `createNode` (JS) + `renderOffline` + `inspect` |
| `@unworklet/worklet` | Browser-side `createWasmNode` (WASM AudioWorklet, SAB+Atomics transport) + `engineSnapshotToWasm` bridge |
| `@unworklet/dsp` | High-precision (`/precise`) and table-based (`/table`) math variants |
| `@unworklet/cli` | `unworklet render / build / analyze / bench / inspect / dev` |
| `@unworklet/vite-plugin` | `?unworklet` import suffix resolves to a precompiled worklet asset |
| `@unworklet/test` | `renderOfflineWasm` (drives a WASM module without a real AudioContext) |
| `@unworklet/bench` | Latency / CPU / NaN-Inf benchmarks |

## Hello world

```typescript
import {
  defineProcessor, audioInput, audioOutput, param, forSample, mul,
} from '@unworklet/core';

export const gain = defineProcessor(() => {
  const main = audioInput({ channels: 2, name: 'main' });
  const out = audioOutput({ channels: 2, name: 'main' });
  const g = param({ default: 1, min: 0, max: 4, automationRate: 'a-rate', name: 'gain' });

  return {
    process: () => {
      forSample((i) => {
        out.set(0, i, mul(main.at(0, i), g.at(i)));
        out.set(1, i, mul(main.at(1, i), g.at(i)));
      });
    },
  };
});
```

## Offline rendering (CLI)

```sh
# Generate a 1s 440Hz sine input
npx tsx scripts/make-input.ts

# Apply 0.5 gain to it
npx tsx packages/cli/src/cli.ts render examples/src/01-stereo-gain.ts \
  --output gain.wav --duration 1 --input /tmp/uw/sine.wav --param gain=0.5
```

The CLI exposes:

| Flag | Description |
|---|---|
| `--output <path>` | WAV output (required) |
| `--duration <seconds>` | Render duration |
| `--sample-rate <hz>` | Default 48000 |
| `--input <path>` | Input WAV file |
| `--input-name <name>` | Audio input port name (default `main`) |
| `--output-name <name>` | Audio output port name (default `main`) |
| `--param <name=value>` | Param value (repeatable) |
| `--message-json <path>` | JSON file with `[{name, payload, at?}]` messages |
| `--midi-json <path>` | JSON file with MIDI events |
| `--export <name>` | Named export of the processor |
| `--format <fmt>` | `float32` / `pcm16` / `pcm24` |
| `--block-size <n>` | Block size (default 128) |

## Programmatic offline rendering

```typescript
import { renderOffline } from '@unworklet/client';
import { gain } from './my-processor';

const result = await renderOffline(gain, {
  sampleRate: 48000,
  duration: 2,
  input: { main: [leftChannel, rightChannel] },
  params: { gain: 0.5 },
});
// result: { output, events, midiOut, peak, rms, hasNaN }
```

## Tests

```sh
vp test
```

All canonical examples have round-trip tests verifying actual audio output.

## Repository layout

```
packages/
  core/          # @unworklet/core + @unworklet/core/simd + @unworklet/core/internal
  compiler/      # capture / memory-layout / wasm-emit / worklet-codegen / static-analysis
  client/        # @unworklet/client (createNode JS path, renderOffline, inspect)
  worklet/       # @unworklet/worklet (createWasmNode browser path, snapshot bridge)
  dsp/           # @unworklet/dsp + /precise + /table
  cli/           # @unworklet/cli (render/build/analyze/bench/inspect/dev)
  vite-plugin/   # @unworklet/vite-plugin (?unworklet import suffix)
  test/          # @unworklet/test (renderOfflineWasm)
  bench/         # @unworklet/bench (perf harness)
examples/
  src/           # 14 canonical processors (docs/12 + 2 extras)
apps/playground/ # Vue 3 / Vite live demo of every showcase via createWasmNode
docs/            # Authoritative spec
tests/           # 130 unit + integration tests + tests/golden/*.wav fixtures
scripts/         # build-goldens (regenerate golden WAVs)
```

## See also

- `docs/00-foundations.md` — vocabulary and type system
- `docs/01-dsl.md` — full DSL surface
- `docs/12-canonical-examples.md` — integrity-anchor examples
- `AGENTS.md` — guidance for AI implementers
