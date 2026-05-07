<script setup>
const tryItCode0 = `import { defineProcessor, audioInput, audioOutput, param, forSample, mul } from "@unworklet/core";

export const tworate = defineProcessor(() => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });

  // a-rate: reads via .at(i) — updates per sample. Good for vol envelopes.
  const aRateGain = param({
    name: "aRateGain", default: 0.5, min: 0, max: 1,
    automationRate: "a-rate",
  });
  // k-rate: reads via .at(0) — constant per block. Good for stable knobs.
  const kRateGain = param({
    name: "kRateGain", default: 1.0, min: 0, max: 2,
    automationRate: "k-rate",
  });

  return {
    process: () => {
      const k = kRateGain.at(0);
      forSample((i) => {
        const a = aRateGain.at(i);
        out.set(0, i, mul(mul(main.at(0, i), a), k));
        out.set(1, i, mul(mul(main.at(1, i), a), k));
      });
    },
  };
});
`;
</script>

# Parameters

`param({...})` declares an `AudioParam`-backed control. It exposes a real Web Audio `AudioParam` on `node.params.<name>` — connect oscillators / LFOs / automation curves to it, just like with built-in nodes.

## Declaration

```ts
const cutoff = param({
  name: "cutoff",
  default: 0.5,
  min: 0,
  max: 1,
  automationRate: "k-rate",  // or "a-rate"
  unit: "ratio",              // optional metadata
});
```

## Reading — a-rate vs k-rate

- **a-rate**: parameter can change every sample. Read with `param.at(i)` where `i` is the per-sample index from `forSample`.
- **k-rate**: parameter is constant for the whole render block. Read with `param.at(0)` outside `forSample` (or anywhere — it's the same value).

Choose a-rate when the param drives perceptual modulation (LFO target, envelope target, smoothed UI controls). Choose k-rate when the param is a configuration knob that updates rarely (filter Q, delay time, ratio, threshold).

<TryIt label="a-rate vs k-rate" size="tall" :code="tryItCode0" />

## Defaults, min, max, validation

`min` / `max` are clamped by the Web Audio runtime — values outside the range don't reach your processor. The static analyzer warns if a declared param is never read inside the body (`param-unused`).

```ts
// Won't compile if the body never calls cutoff.at(...) anywhere.
const cutoff = param({ name: "cutoff", default: 0.5, min: 0, max: 1, automationRate: "k-rate" });
```

## Automation

Because `node.params.<name>` is a real `AudioParam`, all of Web Audio's scheduling works:

```ts
const node = await createWasmNode(ctx, processor, "name");

// Linear ramp to 0.8 over 2 seconds
node.params.gain.linearRampToValueAtTime(0.8, ctx.currentTime + 2);

// Connect an LFO to it
const lfo = ctx.createOscillator();
lfo.frequency.value = 0.5;
const lfoGain = ctx.createGain();
lfoGain.gain.value = 0.2;
lfo.connect(lfoGain).connect(node.params.cutoff);
lfo.start();
```

Inside the worklet, `cutoff.at(i)` returns the current automation lane value at sample `i` — including LFO contributions, ramps, and `setValueAtTime` schedules.

## Per-block automation

`forSample.byN(stride, ...)` lets coefficient updates run cheaper:

```ts
forSample.byN(4, (i) => {
  // Only run every 4 samples — 32 updates/block instead of 128.
  // Great for filter coefficient recomputation that doesn't need
  // sample accuracy.
  const c = computeCoef(cutoff.at(i));
  coefSlot.store(c);
});
```

## Default surface in the host

```ts
const node = await createWasmNode(ctx, processor, "name");
// node.params is a Record<name, AudioParam>:
node.params.gain.value = 0.7;
node.params.cutoff.setValueAtTime(0.3, ctx.currentTime);
node.params.feedback.linearRampToValueAtTime(0.6, ctx.currentTime + 1);
```
