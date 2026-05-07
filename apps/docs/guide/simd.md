<script setup>
const tryItCode0 = `import {
  defineProcessor, audioInput, audioOutput, buffer, state, forSample,
  add, mul, mod, sub,
} from "@unworklet/core";
import { splat, mulVec, addVec } from "@unworklet/core/simd";

const TAP = 16;

export const firSimd = defineProcessor(() => {
  const main = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });
  const hist = buffer.f32({ size: TAP * 2, name: "hist" });
  const coef = buffer.f32({ size: TAP, name: "coef", snapshot: "persistent" });
  const head = state.i32(0, { name: "head" });

  return {
    process: () => {
      const blockHead = head.load();
      forSample((i) => {
        const wIdx = mod(add(blockHead, i), TAP);
        hist.write(wIdx, main.at(0, i));

        let acc = splat(0);
        for (let k = 0; k < TAP; k += 4) {
          const histIdx = mod(add(sub(sub(wIdx, k), 3), TAP), TAP);
          const h = hist.loadVec(histIdx);
          const c = coef.loadVec(k);
          acc = addVec(acc, mulVec(h, c));
        }
        const sum = add(
          add(acc.lane(0), acc.lane(1)),
          add(acc.lane(2), acc.lane(3)),
        );
        out.set(0, i, sum);
      });
      head.store(mod(add(blockHead, 128), TAP));
    },
  };
});
`;
</script>

# SIMD (f32x4)

Opt-in via `@unworklet/core/simd`. Lowers to native WebAssembly `f32x4.*` ops on every modern browser. Per-sample cost drops 3-4× when the inner loop fits the SIMD-friendly pattern.

## When to reach for SIMD

- Inner products / convolutions (FIR, partitioned reverb).
- Per-sample biquad cascades (4 stages).
- Vectorized envelope / LFO calculations.
- Polyphonic synth voice mixing.

If your hot path looks like "scalar arithmetic on independent sample-indexed data", it vectorizes well.

## Primitives

```ts
import { splat, vec4, addVec, subVec, mulVec, divVec } from "@unworklet/core/simd";

const a = splat(0.5);                   // [0.5, 0.5, 0.5, 0.5]
const b = vec4(1, 2, 3, 4);             // [1, 2, 3, 4]
const c = mulVec(a, b);                 // [0.5, 1.0, 1.5, 2.0]
const sum = addVec(c, splat(1));        // [1.5, 2.0, 2.5, 3.0]

// Lane access:
const lane0 = (sum as any).lane(0);     // Node<'f32'>
```

## Buffer SIMD

`buffer.f32` exposes `loadVec(offset)` / `storeVec(offset, vec)` for 4-lane bulk reads/writes:

```ts
const acc = splat(0);
for (let k = 0; k < TAP; k += 4) {
  const h = histBuf.loadVec(k);     // 4 history samples
  const c = coefBuf.loadVec(k);     // 4 coefficients
  acc = addVec(acc, mulVec(h, c));  // FIR partial sum
}
const out = add(
  add(acc.lane(0), acc.lane(1)),
  add(acc.lane(2), acc.lane(3)),
);
```

## Live FIR demo

A 16-tap FIR filter implemented as a SIMD inner-product:

<TryIt label="SIMD FIR" size="tall" :code="tryItCode0" />

The demo's coefficient buffer starts empty (zeros), so the output is silent — uploading coefficients is left as an exercise. The point is that the inner loop **emits real `f32x4.*` opcodes** in the WASM binary; you can verify with `unworklet build my-processor.ts && cat dist-unworklet/my-processor.wat | grep f32x4`.

## Bench numbers

A 16-tap FIR at 48 kHz, mono:

| Implementation | per-block ns | CPU% |
|---|---|---|
| Scalar | ~3,400 | 0.13% |
| SIMD (f32x4) | ~890 | 0.03% |

(Measured via `unworklet bench`.)
