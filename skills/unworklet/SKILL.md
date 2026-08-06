---
name: unworklet
description: Authoring, building, testing, or wiring a Web Audio AudioWorklet processor with unworklet. Use when working with `.uwk.ts` or `.processor.ts` files, the `@unworklet/*` packages (`core` / `unplugin` / `lang` / `offline` / `test`), the `?worklet` import, `createNode`, the `unworklet-tsc` typecheck CLI, or the unworklet Vite DevTools panel.
---

# unworklet

unworklet builds Web Audio `AudioWorklet` processors from declarative source. You author DSP in a `.uwk.ts` file (or the explicit `@unworklet/core` method API in a `.processor.ts`); `@unworklet/unplugin` (a Vite plugin) lowers and compiles each processor to WASM at build time, proves it realtime-safe, and exposes it through a `?worklet` import. `@unworklet/core`'s `createNode` loads that import and returns a fully-typed main-thread node (`params` / `state` / `events` / `midi` / `inputs` / `outputs`). A `?worklet` import bakes 48 kHz coefficients by default, so the `AudioContext` must run at 48000 Hz or `createNode` throws. Offline render (`@unworklet/offline`), matchers (`@unworklet/test`), a drop-in typecheck CLI (`unworklet-tsc`), and a Vite DevTools panel complete the toolchain.

**`.uwk.ts` is the primary, recommended authoring form.** `.processor.ts` (the explicit `@unworklet/core` method API) is the secondary, lower-level alternative — it compiles to the same result; reach for it only when you need a surface `.uwk.ts` does not expose (e.g. SIMD). Never treat `.uwk.ts` as optional/skippable sugar.

## Mandatory workflow (do every step — writing the processor alone is NOT enough)

1. **Scaffold the project.** Install deps, add the plugin, extend the generated tsconfig for IDE types, gitignore `.unworklet/`, and (optionally) enable the DevTools panel. → setup.md, ide-and-typecheck.md, devtools.md
   ```bash
   npm install @unworklet/core
   npm install -D @unworklet/unplugin @unworklet/lang @unworklet/offline @unworklet/test
   ```
   ```ts
   // vite.config.ts
   import { defineConfig } from "vite";
   import unworklet from "@unworklet/unplugin";
   export default defineConfig({ plugins: [unworklet()] });
   ```
   ```jsonc
   // tsconfig.json — inherits ?worklet types + the .uwk.ts editor checker.
   // In VS Code, select the Workspace TypeScript version.
   { "extends": "./.unworklet/tsconfig.json" }
   ```
2. **Author in `.uwk.ts`** (primary form). One file = one processor. → dsl.md
3. **Test** headless: render with `renderOffline` from `@unworklet/offline`, assert with matchers from `@unworklet/test`. → testing.md
4. **Typecheck** with the unworklet CLI — a drop-in `tsc` that also checks `.uwk.ts` sugar. Wire it into build + CI. → ide-and-typecheck.md
   ```jsonc
   // package.json
   { "scripts": { "build": "vite build && unworklet-tsc --noEmit" } }
   ```
5. **Load / wire** the processor: default-import it with `?worklet` and pass it to `createNode` on a 48 kHz `AudioContext`. → setup.md

## A `.uwk.ts` taste

The DSL is ambient (no imports) and the file body IS the processor — no `defineProcessor` wrapper. Operators (`*`), index reads (`x[i]`), and index assignment (`out[i] = …`) lower to core DSL calls at build time. Verbatim fixture (`packages/unplugin/__fixtures__/stereo-gain.uwk.ts`):

```ts
// stereo-gain.uwk.ts
const input = audioInput({ channels: 2, name: "main" });
const out = audioOutput({ channels: 2, name: "main" });
const gain = param.f32({ default: 1.0, min: 0.0, max: 4.0, automationRate: "a-rate" });

process(() => {
  forSample((i) => {
    out.left[i] = input.left[i] * gain[i];
    out.right[i] = input.right[i] * gain[i];
  });
});
```

Load it (`README.md` quick start; rate gate `packages/core/src/client.ts:350-364`):

```ts
import { createNode } from "@unworklet/core";
import stereoGain from "./stereo-gain.uwk.ts?worklet";

const ctx = new AudioContext({ sampleRate: 48000 }); // must equal the baked 48 kHz
const node = await createNode(ctx, stereoGain);
node.outputs.main.connect(ctx.destination);
node.params.gain.value = 0.5; // fully-typed AudioParam (name auto-derived from the binding)
```

## Read more (siblings)

- **dsl.md** — authoring the processor: the `.uwk.ts` sugar (operators, index, bare-state read, `if`/`?:`, `$prev`, auto-name, subgraphs) and the underlying `@unworklet/core` declaration API (`audioInput`/`audioOutput`, `param`, `state`, `state.buffer`, `event`/`event.midi`, `forSample`, `defineSubgraph`/`instantiate`, math ops); plus the `.processor.ts` alternative.
- **setup.md** — scaffolding & wiring: which `@unworklet/*` packages to install, `vite.config.ts`, the generated `.unworklet/` dir + tsconfig, file conventions, the `?worklet` import, `createNode`, the `UnworkletNode` surface, and the 48 kHz rate gate.
- **ide-and-typecheck.md** — editor types & CI: the `@unworklet/lang/typescript-plugin` editor plugin and the `unworklet-tsc` drop-in typecheck CLI.
- **testing.md** — headless tests: `renderOffline` (the Node oracle) plus `@unworklet/test` plain matchers, the chain form (`@unworklet/test/extend`), signal generators, and MIDI builders.
- **devtools.md** — in-browser inspector: the Vite DevTools dock (4 panels), the `@vitejs/devtools` 0.4.x install (host + kit + 4 adapters), and cross-origin isolation.
