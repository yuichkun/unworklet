# CLI

```sh
npx unworklet <command> <processor.ts> [options]
```

| Command | What |
|---|---|
| `render` | Render audio offline to a WAV file |
| `build` | Compile to .wasm + .worklet.js + .meta.json + .wat + .locations.json + .wasm.map |
| `dev` | Watch a processor and rebuild on change (SSE hot reload) |
| `analyze` | Static analysis report (cycles, memory, layer-3 warnings) |
| `bench` | Latency / CPU / NaN-Inf benchmark |
| `inspect` | Decode a snapshot blob — header, schema hash, slot summary |

## render

```sh
unworklet render ./examples/01-stereo-gain.ts \
  --output gain.wav --duration 2 \
  --param gain=0.5 \
  --input input.wav \
  --message-json msgs.json \
  --midi-json midi.json
```

`--message-json` format: `[{name, payload, at?}]`.
`--midi-json` format: `[{at, event}]`.
`--format`: `float32` | `pcm16` | `pcm24`.
`--block-size`: render quantum (default 128).

## build

```sh
unworklet build ./src/my-processor.ts --out-dir ./dist-unworklet
```

Produces:

- `<name>.wasm` — the compiled WASM binary.
- `<name>.worklet.js` — the AudioWorklet module JS that boots the WASM.
- `<name>.meta.json` — declarations, schema hash, memory layout summary.
- `<name>.wat` — text format (debugging).
- `<name>.locations.json` — sidecar source-location map.
- `<name>.wasm.map` — binaryen-emitted source map (when source locations are present).

## analyze

```sh
unworklet analyze ./src/my.ts
```

Output formats: `--format human` (default) | `json` | `junit`.

## bench

```sh
unworklet bench ./src/my.ts --duration 2
```

Reports per-block ns (min/p50/p95/p99/max/mean), CPU% of audio budget, transport (`sab` / `postMessage`), `+SIMD` flag, memory size.

For SIMD-heavy processors with large unrolled inner loops, run with a bigger Node stack:

```sh
node --stack-size=8000 --experimental-strip-types --import=tsx \
  ./packages/cli/src/cli.ts bench ./convolution-reverb.ts
```

## dev

```sh
unworklet dev ./src/my.ts --port 5174
```

See [Hot reload](/guide/hot-reload).

## inspect

```sh
unworklet inspect ./snapshot.uws
```

Prints magic, version, schema hash, profile, slot summary. Auto-detects UWS1 (engine) and UWSN (worklet) blob formats.
