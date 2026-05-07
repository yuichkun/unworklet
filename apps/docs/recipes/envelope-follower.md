<script setup>
const tryItCode0 = `import {
  defineProcessor, audioInput, audioOutput, param, state, forSample,
  add, sub, mul, abs, max, gt, select, exp, div, flushDenormals,
} from "@unworklet/core";

export const envFollower = defineProcessor((ctx) => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });

  const attackMs = param({ name: "attackMs", default: 5, min: 0.1, max: 200, automationRate: "k-rate" });
  const releaseMs = param({ name: "releaseMs", default: 80, min: 1, max: 1000, automationRate: "k-rate" });

  const env = state.f32(0, { name: "env", publish: { rateFps: 30 } });

  return {
    process: () => {
      // Attack/release coefficients (block-rate — values stable for 2.7ms at 48kHz).
      const aCoef = sub(1, exp(div(-1, mul(mul(attackMs.at(0), 0.001), ctx.sampleRate))));
      const rCoef = sub(1, exp(div(-1, mul(mul(releaseMs.at(0), 0.001), ctx.sampleRate))));

      forSample((i) => {
        const det = max(abs(main.at(0, i)), abs(main.at(1, i)));  // peak detector
        const e = env.load();
        const isAttacking = gt(det, e);
        const c = select(isAttacking, aCoef, rCoef);
        const newE = flushDenormals(add(e, mul(c, sub(det, e))));
        env.store(newE);
        // Pass-through audio so the processor has output.
        out.set(0, i, main.at(0, i));
        out.set(1, i, main.at(1, i));
      });
    },
  };
});
`;
</script>

# Envelope follower

Tracks the magnitude of a signal with separate attack + release time constants. The basis for compressors, gates, side-chain ducking, and meter UIs.

<TryIt label="env follower" size="tall" :code="tryItCode0" />

The published `env` slot makes the meter visible main-side at 30 fps:

```ts
const node = await createWasmNode(ctx, envFollower, "envFollower");
node.state.env.subscribe((v) => meterEl.style.width = `${Math.min(100, v * 100)}%`);
```

## Why peak detector + asymmetric coefs

- `max(abs(L), abs(R))` is the simplest sensible peak detector for stereo.
- Attack faster than release matches how ears perceive transients — a fast attack means the env catches the leading edge; a slow release smooths the trailing meter.
- A few ms attack + ~80 ms release is the standard "VU-ish" feel.

For RMS instead of peak, replace the detector with `sqrt(mul(L, L) + mul(R, R))` (and adjust the coefs).
