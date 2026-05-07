<script setup>
const tryItCode0 = `import {
  defineProcessor, defineSubgraph, audioInput, audioOutput, param, state,
  forSample, flushDenormals,
} from "@unworklet/core";

const channel = defineSubgraph((x, k, drive) => {
  const lp = state.f32(0);
  // tanh saturate, then one-pole LP (read in DSP-flow order).
  const driven = x.mul(drive).tanh();
  const out = flushDenormals(lp.load().add(k.mul(driven.sub(lp.load()))));
  lp.store(out);
  return out;
});

export const stereoChannel = defineProcessor(() => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const cutoff = param({ name: "cutoff", default: 0.25, min: 0.001, max: 0.999, automationRate: "k-rate" });
  const drive = param({ name: "drive", default: 1.5, min: 0.5, max: 6, automationRate: "k-rate" });

  return {
    process: () => {
      const k = cutoff.at(0);
      const d = drive.at(0);
      forSample((i) => {
        // Two call sites of \`channel\` — each gets its own internal lp slot.
        out.left.set(i,  channel(main.left.at(i),  k, d));
        out.right.set(i, channel(main.right.at(i), k, d));
      });
    },
  };
});
`;
</script>

# Subgraphs (DSP libraries)

`defineSubgraph` factors reusable DSP fragments. Each call site gets its own state slots — perfect for stereo channels, polyphonic voices, or independent parallel filters.

## L1 vs L2 helpers

unworklet has two integration layers for third-party DSP code:

- **L1**: a pure TS function. No state, no I/O. Composes in any context. `lerp(a, b, t) = add(a, mul(sub(b, a), t))`.
- **L2**: `defineSubgraph(body)` — a function returning a graph fragment that owns its own state slots. Each call site allocates fresh state.

```ts
// L1 — pure helper, stateless. Lives anywhere.
function softclip(x: Node<'f32'>): Node<'f32'> {
  return tanh(mul(x, 1.5));
}

// L2 — subgraph, owns state. Call-site instances are independent.
const onePoleLP = defineSubgraph((x: Node<'f32'>, k: Node<'f32'>) => {
  const z = state.f32(0);
  const y = add(z.load(), mul(k, sub(x, z.load())));
  z.store(y);
  return y;
});
```

## Stereo: same DSP, two instances

<TryIt label="stereo subgraph" size="tall" :code="tryItCode0" />

The two `channel(...)` invocations don't bleed into each other's filter state. The compiler tracks call sites by source position and allocates per-instance state.

## Polyphonic synth voices

Same pattern — declare a `synthVoice` subgraph, call it per-voice in a loop:

```ts
const synthVoice = defineSubgraph((noteHz, gate, attack, release, sr) => {
  const phase = state.f32(0);
  const env = state.f32(0);
  // ... per-voice DSP
  return mul(sin(mul(phase.load(), 2 * Math.PI)), env.load());
});

forSample((i) => {
  let mix = mul(0, 0);
  for (let v = 0; v < NUM_VOICES; v++) {
    mix = add(mix, synthVoice(voiceHz[v]!.load(), voiceGate[v]!.load(), 0.01, 0.3, ctx.sampleRate));
  }
  out.left.set(i,  mix);
  out.right.set(i, mix);
});
```

The `for` loop runs at **capture time** — the compiler unrolls it into 8 independent voice graphs, each with its own state. At runtime the WASM module is a single tight loop.

## Why two layers, not one

The audit-flagged tradeoff (Q2 in the spec): pure functions are simpler to reason about, but DSP that needs internal memory (filters, oscillators, envelopes) needs a way to attach state to a call site. L2 = "subgraph with private state per call site"; L1 = "pure function over graph nodes."

Most third-party DSP libraries can be expressed as a small L1 surface plus a few L2 building blocks (one-pole, biquad, delay line, oscillator).
