<script setup>
const tryItCode0 = `import {
  defineProcessor, audioInput, audioOutput, param, state, forSample,
  add, sub, mul, flushDenormals,
} from "@unworklet/core";

export const onePoleLP = defineProcessor(() => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const cutoff = param({
    name: "cutoff", default: 0.2, min: 0.001, max: 0.999, automationRate: "k-rate",
  });

  // Two state slots — one per channel.
  const lpL = state.f32(0, { name: "lpL" });
  const lpR = state.f32(0, { name: "lpR" });

  return {
    process: () => {
      const k = cutoff.at(0);
      forSample((i) => {
        // L
        const yL = flushDenormals(add(lpL.load(), mul(k, sub(main.left.at(i), lpL.load()))));
        lpL.store(yL);
        out.left.set(i, yL);
        // R
        const yR = flushDenormals(add(lpR.load(), mul(k, sub(main.right.at(i), lpR.load()))));
        lpR.store(yR);
        out.right.set(i, yR);
      });
    },
  };
});
`;
</script>

# One-pole low-pass

Single-state IIR. Cheapest filter shape that still tracks signal envelopes meaningfully.

`y[n] = y[n-1] + k * (x[n] - y[n-1])`

`k` is in `(0, 1)`. Smaller k → slower, smoother. Larger → faster, more transparent.

<TryIt label="one-pole LP" :code="tryItCode0" />

`flushDenormals` is essential here — when the input goes silent, both channel states would otherwise decay through subnormal floats and stall the audio thread on x86.

If you want a real cutoff in Hz, the standard mapping is:

```ts
const k = sub(1, exp(div(-2 * Math.PI * fc, ctx.sampleRate)));
```

where `fc` is the cutoff frequency in Hz.
