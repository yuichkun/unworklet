<script setup>
const tryItCode0 = `import {
  defineProcessor, audioInput, audioOutput, state, forSample,
  add, sub, mul, flushDenormals,
} from "@unworklet/core";

export const filterFTZ = defineProcessor(() => {
  const main = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });
  const z = state.f32(0);
  return {
    process: () => {
      const k = 0.97; // close-to-1 coefficient — denormal trap
      forSample((i) => {
        const y = flushDenormals(add(z.load(), mul(k, sub(main.at(0, i), z.load()))));
        z.store(y);
        out.set(0, i, y);
      });
    },
  };
});
`;
</script>

# Denormals + flushDenormals

## What's the problem?

Audio thread DSP often has **feedback paths with coefficients close to 1.0**:

- One-pole low-pass: `y = y + k*(x - y)` with `k` between 0 and 1.
- Reverb decay: `tail = tail * 0.95 + ...`
- Compressor envelope: `env = env + alpha * (det - env)`
- Meter follower: `meter = meter * 0.92`

When the input goes silent and `y` decays toward 0, the floats reach the **subnormal** range (|x| < 1.18 × 10⁻³⁸ for f32). On x86 CPUs without flush-to-zero enabled, every subnormal arithmetic op is **30-100× slower** than a normal op. A single subnormal in a feedback path can spike the audio thread CPU 3-5× when the user steps away.

## flushDenormals

unworklet ships a primitive that lowers to a branchless `select(abs(x) < 1e-30, 0, x)`:

```ts
import { flushDenormals } from "@unworklet/core";

env.store(flushDenormals(mul(env.load(), 0.95)));
```

It's free at the WASM level (one compare + one select) and removes the subnormal stall.

## Where to apply it

Anywhere the **state-store or buffer-write** in a feedback path could decay to zero:

```ts
// One-pole filter — apply on the state store.
forSample((i) => {
  const x = main.at(0, i);
  const y = flushDenormals(add(z.load(), mul(k, sub(x, z.load()))));
  z.store(y);
  out.set(0, i, y);
});

// Compressor envelope.
env.store(flushDenormals(add(e, mul(coef, sub(det, e)))));

// Reverb tail.
wet.store(flushDenormals(mul(wet.load(), 0.93)));
```

## Live demo: with vs without

<TryIt label="with FTZ" :code="tryItCode0" />

## Static-analysis warning

The compiler scans for one-pole-style filters with coefficients in `(0.9, 1.0)` and flags them at compile time:

```
WARNING [denormal-prone-filter] state slot "env" (id=2) is updated by a
  one-pole-style filter with a coefficient close to 1.0 (0.950000); inputs
  that decay to zero may produce subnormal floats and stall the audio
  thread.
  hint: Add a noise-floor injection (e.g. add(state, 1e-30) at the end of
  the loop) or wrap the path in flushDenormals(...).
```

Run `unworklet analyze ./my-processor.ts` to see it.
