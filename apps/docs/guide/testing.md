# Testing + benchmarking

## Unit tests via @unworklet/test

Drives WASM offline, no AudioContext required.

```ts
import { renderOfflineWasm } from "@unworklet/test";
import { myProcessor } from "./my-processor";

const result = await renderOfflineWasm(myProcessor, {
  sampleRate: 48000,
  duration: 0.5,
  input: { main: [leftIn, rightIn] },
  params: { gain: 0.6 },
  midiEvents: [{ at: 0, event: { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 } }],
  messages: [{ at: 0, name: "uploadSample", payload: { samples: clickBuffer } }],
});

expect(result.peak).toBeGreaterThan(0.1);
expect(result.hasNaN).toBe(false);
expect(result.events).toContainEqual({ at: 0, name: "noteStart", payload: { note: 60 } });
```

## Bit-exact golden WAV regressions

Capture once, compare on every test run.

```sh
# Render canonical inputs once into tests/golden/
npx tsx scripts/build-goldens.ts

# Run regression test (re-renders, compares within 1e-6 tolerance)
npx vitest run tests/golden-wav.test.ts
```

If you change codegen and any byte shifts, the test fails loudly with the diff.

## SIMD vs scalar parity

Verify the SIMD path stays bit-equivalent (within FP rounding) to the scalar reference.

```ts
const simd = await renderOfflineWasm(simdImpl, cfg);
const scalar = await renderOfflineWasm(scalarImpl, cfg);
let maxDiff = 0;
for (let i = 0; i < simd.output.main[0].length; i++) {
  maxDiff = Math.max(maxDiff, Math.abs(simd.output.main[0][i] - scalar.output.main[0][i]));
}
expect(maxDiff).toBeLessThan(1e-5);
```

## Benchmarking

```sh
unworklet bench ./my-processor.ts
```

Sample output:

```
Bench myProcessor @ 48000 Hz, 128 samples/block, 750 blocks (2s):
  per-block (ns): min=414  p50=844  p95=947  p99=2133  max=623274  mean=1653
  CPU usage:      0.06% of audio budget
  output sanity:  hasNaN=false  hasInf=false
  transport:      sab  +SIMD
  memory:         2616 bytes (1 pages)
```

The `transport: sab` line confirms SAB+Atomics is in use (otherwise you'd see `postMessage`). `+SIMD` means f32x4 ops are present in the binary.

## What "production-ready" means

The framework runs the canonical 14 examples through:

- **Unit tests** (Vitest) on every push.
- **WASM ↔ JS engine cross-validation** — the same processor on two backends.
- **Headless WASM AudioWorklet** in real Chromium — boots a real `AudioContext`, instantiates the worklet, asserts non-silent output.
- **Bit-exact golden WAV regression** on 12 fixtures.
- **SIMD parity** within 1e-5 over 16 chirp blocks.
- **Static analysis** with 7+ Layer-3 codes.
- **Property-based** tests via fast-check on numeric primitives.
