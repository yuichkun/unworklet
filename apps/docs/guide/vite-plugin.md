# @unworklet/vite-plugin

Resolves a `?unworklet` import suffix to a precompiled worklet asset.

## Setup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import unworkletPlugin from "@unworklet/vite-plugin";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue(), unworkletPlugin({ sampleRate: 48000 })],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
```

## Use

```ts
import workletURL, { processorName } from "./my-processor.ts?unworklet";

const ctx = new AudioContext();
await ctx.audioWorklet.addModule(workletURL);
const node = new AudioWorkletNode(ctx, processorName);
```

The plugin:

1. Resolves the `?unworklet`-suffixed import.
2. Imports the underlying TS module to obtain the `CompiledProcessor`.
3. Calls `compileToWasm(...)` + `generateWorkletModule(...)` at build time.
4. In production: emits the worklet JS as an asset, returns the asset URL.
5. In dev: returns a Blob-URL builder that constructs the URL at module evaluation time.

This is the **production path** — the WASM binary is precompiled, the worklet JS is tree-shake-friendly, and `addModule` loads at module-graph speed.

## Comparison: vite-plugin vs createWasmNode

| | vite-plugin | createWasmNode |
|---|---|---|
| Compile timing | Build time | Runtime (lazy) |
| Bundle size | Single asset per processor | binaryen.js bundled into client (~3 MB) |
| Hot reload | Via `unworklet dev` | Manual |
| Best for | Production / static apps | Dev tooling, code playgrounds |

Both produce identical AudioWorklet behaviour. The TryIt blocks on this site use `createWasmNode` because they recompile arbitrary user-typed source.
