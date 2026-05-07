<script setup>
const tryItCode0 = `import {
  defineProcessor, audioInput, audioOutput, state, forSample, everyNSamples,
  add, sub, mul, abs, max, gt, select, exp, div, flushDenormals,
} from "@unworklet/core";

export const subRateEnv = defineProcessor((ctx) => {
  const main = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });
  const env = state.f32(0, { name: "env", publish: { rateFps: 30 } });

  // Attack/release coefficients computed once per block.
  const attackCoef = sub(1, exp(div(-1, mul(0.005, ctx.sampleRate))));
  const releaseCoef = sub(1, exp(div(-1, mul(0.1, ctx.sampleRate))));

  return {
    process: () => {
      forSample((i) => {
        const x = abs(main.at(0, i));
        // Update env every sample for smoothness, but...
        const cur = env.load();
        const isAttack = gt(x, cur);
        const c = select(isAttack, attackCoef, releaseCoef);
        env.store(flushDenormals(add(cur, mul(c, sub(x, cur)))));
        // Apply: gate audio when env > 0.1.
        const gate = select(gt(env.load(), 0.1), 1, 0);
        out.set(0, i, mul(main.at(0, i), gate));

        // ...do the heavier per-stage logic at 1/16 rate.
        everyNSamples(16, () => {
          // (no-op here — would run e.g. spectral metering, lookup tables, etc.)
        });
      });
    },
  };
});
`;
</script>

# Sub-rate computation

Not every part of a processor needs to update at audio rate. Filter coefficients, LFOs feeding coefficients, envelope detectors — all update fine at a fraction of the sample rate. unworklet has two tools.

## forSample.byN(N, ...)

The simplest knob. Run the body every `N`th sample. `N` must be a power of 2 that divides the render quantum (128 by default).

```ts
forSample.byN(4, (i) => {
  // 32 iterations per block instead of 128.
  // i is the absolute sample-position within the block (0, 4, 8, ..., 124).
});
```

## everyNSamples(N, ...) — nested

`everyNSamples` runs inside `forSample`. Use it when most work is per-sample but some is sub-rate:

```ts
forSample((i) => {
  everyNSamples(64, () => {
    // Recompute biquad coefficients twice per block (every 64 samples).
    const k = computeCoef(cutoff.at(i));
    coefSlot.store(k);
  });
  // The rest runs every sample, using the stored coefficient.
  const c = coefSlot.load();
  out.set(0, i, biquad(main.at(0, i), c));
});
```

`everyNSamples` is callable only inside a `forSample` body. The static analyzer enforces this.

## Live envelope follower

Envelope at full rate would over-track transients. Sub-rate at every 16 samples gives a noticeably smoother + cheaper response:

<TryIt label="sub-rate envelope" size="tall" :code="tryItCode0" />

The published `env` slot updates at 30 fps for a UI meter — that's main-side only, costs nothing on the audio thread.
