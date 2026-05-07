<script setup>
const tryItCode0 = `import {
  defineProcessor, audioOutput, param, state, forSample,
} from "@unworklet/core";

export const helloSine = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  const freq = param({ name: "freq", default: 220, min: 55, max: 1760, automationRate: "k-rate" });
  const phase = state.f32(0, { name: "phase" });
  const TWO_PI = 2 * Math.PI;

  return {
    process: () => {
      const inc = freq.at(0).mul(TWO_PI / ctx.sampleRate);
      forSample((i) => {
        const next = phase.load().add(inc).mod(TWO_PI);
        phase.store(next);
        out.set(0, i, next.sin().mul(0.5));
      });
    },
  };
});
`;
</script>

# Getting started

## Install

```sh
pnpm add @unworklet/core @unworklet/client @unworklet/worklet
# Optional but recommended:
pnpm add -D @unworklet/cli @unworklet/vite-plugin
```

unworklet is ESM-only. Your project must be `"type": "module"` (or use `.mts`/`.mjs` imports).

::: tip COOP/COEP
The WASM transport uses SharedArrayBuffer. To enable it, your dev/preview server must respond with these two headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them the framework silently falls back to a `postMessage` transport — slower but functionally complete.
:::

## Project layout

```
my-plugin/
├── src/
│   └── my-processor.ts   # defineProcessor body
├── index.html
└── vite.config.ts
```

`vite.config.ts`:

```ts
import { defineConfig } from "vite";
import unworkletPlugin from "@unworklet/vite-plugin";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue(), unworkletPlugin()],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
```

## Hello, sine wave

Try a complete synthesiser. **Hit Run** below — your code, your browser, real WASM in a real AudioWorklet:

<TryIt label="quickstart" :code="tryItCode0" source="silent" />

In a real app you'd boot it like this:

```ts
import { createWasmNode } from "@unworklet/worklet";
import { helloSine } from "./my-processor";

const ctx = new AudioContext();
const node = await createWasmNode(ctx, helloSine, "helloSine");

// Connect to speakers
node.outputs.main.connect(ctx.destination);

// Drive the freq param — it's a real AudioParam, automation works.
node.params.freq.setValueAtTime(440, ctx.currentTime);
node.params.freq.linearRampToValueAtTime(880, ctx.currentTime + 2);
```

That's it. No `AudioWorkletProcessor` subclass. No `addModule()`. No `postMessage`. The `createWasmNode` helper compiles the processor to WASM, installs the worklet module, and returns a node-shaped object you connect like any other Web Audio node.

## What's next

Hands-on tutorials, in order:

1. **[Your first processor](/guide/your-first-processor)** — sine → freq knob → tremolo → filter. ~10 minutes, ends with a 4-knob synth voice.
2. **[Build a synth](/guide/build-a-synth)** — detuned saws, ADSR envelope, resonant filter with envelope mod. A real instrument.
3. **[Build a drum machine](/guide/build-a-drum)** — kick, hat, 16-step sequencer that plays itself.

Then dig deeper into the building blocks:

- [Audio I/O + forSample](/guide/audio-io) — the per-sample loop in detail.
- [State + buffers](/guide/state-and-buffers) — bigger memory: delay lines, IRs.
- [Parameters](/guide/parameters) — `AudioParam`-backed controls.
- [Subgraphs](/guide/subgraphs) — reusable DSP with per-instance state.
