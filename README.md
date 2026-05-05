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

- **Backend**: pure-JS interpreter (suitable for Node, offline rendering, and
  Vitest). A WASM emission path is planned (see `docs/03-compiler.md`); the
  pure-JS interpreter mirrors the surface and produces the same audio for
  testing and CLI rendering.
- **Surface**: the full v1.0.0 DSL surface from `docs/01-dsl.md` is implemented
  and exercised by all 8 canonical examples.
- **Test status**: 36 tests pass, covering each canonical example end-to-end.

## Packages

| Package | Description |
|---|---|
| `@unworklet/core` | DSL: `defineProcessor`, primitives, declarations, `forSample`, `defineSubgraph`, MIDI |
| `@unworklet/core/simd` | Opt-in SIMD primitives (`vec4`, `splat`, `mulVec`, `addVec`, …) |
| `@unworklet/client` | Main-thread `createNode` + `renderOffline` API |
| `@unworklet/cli` | Offline rendering CLI with WAV I/O |

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
  client/        # @unworklet/client (createNode, renderOffline)
  cli/           # @unworklet/cli (offline CLI with WAV)
examples/
  src/           # 8 canonical processors from docs/12-canonical-examples.md
docs/            # Authoritative spec
tests/           # End-to-end tests
scripts/         # Demo render scripts
```

## See also

- `docs/00-foundations.md` — vocabulary and type system
- `docs/01-dsl.md` — full DSL surface
- `docs/12-canonical-examples.md` — integrity-anchor examples
- `AGENTS.md` — guidance for AI implementers
