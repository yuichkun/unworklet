<script setup>
const tryItCode0 = `import {
  defineProcessor, audioInput, audioOutput, param, forSample,
  add, sub, mul, tanh,
} from "@unworklet/core";

export const tanhSat = defineProcessor(() => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const drive = param({
    name: "drive", default: 2, min: 0.5, max: 10, automationRate: "a-rate",
  });
  const mix = param({
    name: "mix", default: 1, min: 0, max: 1, automationRate: "a-rate",
  });

  return {
    process: () => {
      forSample((i) => {
        const dryL = main.at(0, i);
        const dryR = main.at(1, i);
        const d = drive.at(i);
        const m = mix.at(i);
        // Wet = tanh(x * drive). Mix dry+wet.
        const wetL = tanh(mul(dryL, d));
        const wetR = tanh(mul(dryR, d));
        out.set(0, i, add(mul(dryL, sub(1, m)), mul(wetL, m)));
        out.set(1, i, add(mul(dryR, sub(1, m)), mul(wetR, m)));
      });
    },
  };
});
`;
</script>

# Soft-clip distortion

`tanh(x * drive)` is the canonical cheap soft-clipper — symmetric, monotonic, smooth derivative. unworklet's `tanh` lowers to a JS Math import at f64 precision (no error vs. `Math.tanh`).

<TryIt label="tanh saturator" :code="tryItCode0" />

The mix knob blends `(1 - mix) × dry + mix × wet`. Hit Run, drag **mix** between 0 (dry passes through unchanged) and 1 (full saturation). At `drive = 1` the soft-clip is gentle, near-transparent; raise it for harder distortion.

## Variants

- **Hard clip**: `clamp(x, -1, 1)` — cheaper, harsher, has a discontinuous derivative.
- **Polynomial sigmoid**: `x * (3 - x²) / 2` — quadratic-cost, similar curve to tanh.
- **Asymmetric**: `tanh(x * driveUp)` for `x > 0`, `tanh(x * driveDn)` for `x < 0`.

Asymmetric, branchless:

```ts
const isPos = gt(x, 0);
const driveUsed = select(isPos, driveUp, driveDn);
const out = tanh(mul(x, driveUsed));
```
