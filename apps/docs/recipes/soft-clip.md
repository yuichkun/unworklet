<script setup>
const tryItCode0 = `import {
  defineProcessor, audioInput, audioOutput, param, forSample, num,
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
        const dryL = main.left.at(i);
        const dryR = main.right.at(i);
        const d = drive.at(i);
        const m = mix.at(i);
        // Wet = tanh(x * drive). Mix dry+wet:  (1 - mix) × dry + mix × wet
        const wetL = dryL.mul(d).tanh();
        const wetR = dryR.mul(d).tanh();
        const dryGain = num(1).sub(m);
        out.left.set(i,  dryL.mul(dryGain).add(wetL.mul(m)));
        out.right.set(i, dryR.mul(dryGain).add(wetR.mul(m)));
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
const driveUsed = select(x.gt(0), driveUp, driveDn);
const out = x.mul(driveUsed).tanh();
```
