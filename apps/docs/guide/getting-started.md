<script setup>
const tryItCode0 = `import {
  defineProcessor, audioInput, audioOutput, param, forSample,
} from "@unworklet/core";

export const gain = defineProcessor(() => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const g = param({ name: "gain", default: 0.5, min: 0, max: 2, automationRate: "a-rate" });

  return {
    process: () => {
      forSample((i) => {
        const gain = g.at(i);
        out.left.set(i,  main.left.at(i).mul(gain));
        out.right.set(i, main.right.at(i).mul(gain));
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

## Hello, gain

Try the canonical hello-world. **Hit Run** below — your code, your browser, real WASM in a real AudioWorklet:

<TryIt label="quickstart" :code="tryItCode0" />

In a real app you'd boot it like this:

```ts
import { createWasmNode } from "@unworklet/worklet";
import { gain } from "./my-processor";

const ctx = new AudioContext();
const node = await createWasmNode(ctx, gain, "gain");

// Connect a source
const osc = ctx.createOscillator();
osc.connect(node.inputs.main.node, 0, 0);
osc.start();

// Connect to speakers
node.outputs.main.connect(ctx.destination);

// Drive the param
node.params.gain.value = 0.8;
```

That's it. No `AudioWorkletProcessor` subclass. No `addModule()`. No `postMessage`. The `createWasmNode` helper compiles the processor to WASM, installs the worklet module, and returns a node-shaped object you connect like any other Web Audio node.

## What's next

- [Your first processor (5-min walkthrough)](/guide/your-first-processor) — line-by-line breakdown.
- [Audio I/O + forSample](/guide/audio-io) — the per-sample loop in detail.
- [State + buffers](/guide/state-and-buffers) — declaring memory.
- [Parameters](/guide/parameters) — `AudioParam`-backed controls.
