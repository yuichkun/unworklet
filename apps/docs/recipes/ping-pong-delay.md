<script setup>
const tryItCode0 = `import {
  defineProcessor, audioInput, audioOutput, param, state, buffer, forSample,
  add, sub, mul, mod, gte, select, i32, flushDenormals,
} from "@unworklet/core";

const MAX_DELAY = 96000;  // 2s @ 48kHz

export const pingPong = defineProcessor((ctx) => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });

  const delayMs = param({ name: "delayMs", default: 280, min: 1, max: 2000, automationRate: "k-rate" });
  const feedback = param({ name: "feedback", default: 0.5, min: 0, max: 0.92, automationRate: "k-rate" });
  const wet = param({ name: "wet", default: 0.4, min: 0, max: 1, automationRate: "k-rate" });
  const dry = param({ name: "dry", default: 0.7, min: 0, max: 1, automationRate: "k-rate" });

  const dlyL = buffer.f32({ size: MAX_DELAY, name: "dlyL" });
  const dlyR = buffer.f32({ size: MAX_DELAY, name: "dlyR" });
  const head = state.i32(0, { name: "head" });

  return {
    process: () => {
      const dSamples = i32(mul(delayMs.at(0), ctx.sampleRate / 1000));
      const fb = feedback.at(0);
      const w = wet.at(0);
      const d = dry.at(0);
      const block = head.load();

      forSample((i) => {
        const wIdx = mod(add(block, i), MAX_DELAY);
        const rIdx = mod(add(sub(wIdx, dSamples), MAX_DELAY), MAX_DELAY);

        const inL = main.at(0, i);
        const inR = main.at(1, i);
        const tapL = dlyL.read(rIdx);
        const tapR = dlyR.read(rIdx);

        // Cross-feed: L gets in + R*fb; R gets in + L*fb.
        dlyL.write(wIdx, flushDenormals(add(inL, mul(tapR, fb))));
        dlyR.write(wIdx, flushDenormals(add(inR, mul(tapL, fb))));

        // Output: dry + wet of the same-channel tap.
        out.set(0, i, add(mul(inL, d), mul(tapL, w)));
        out.set(1, i, add(mul(inR, d), mul(tapR, w)));
      });
      head.store(mod(add(block, 128), MAX_DELAY));
    },
  };
});
`;
</script>

# Ping-pong delay

Two delay lines that cross-feed: L's tap goes into R's input, R's tap goes into L's input. The result bounces left-right with the feedback amount controlling decay.

<TryIt label="ping-pong" size="tall" :code="tryItCode0" />

The cross-feed is what makes it ping-pong. Without it, you'd have two parallel mono delays.

## Variants to try

- **Stereo widener**: replace the cross-feed with `dlyL.write(wIdx, ...inL...)` (no cross) and apply different `delayMs` per channel.
- **Tape modulation**: scale the read index by a slow LFO to add wow/flutter.
- **Filter the feedback**: insert a one-pole LP between tap and write to darken on each repeat.
