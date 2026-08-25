# @unworklet/unplugin

The Vite plugin for unworklet. It turns a `?worklet` import into a ready-to-run
AudioWorklet processor (compiles the graph to WASM, wires up the module URLs),
lowers `.uwk.ts` sugar on the fly, emits analysis JSON on build, and hosts a
DevTools panel (audio graph / live state / signals / MIDI) in dev.

```bash
npm install -D @unworklet/unplugin
npm install @unworklet/core
```

## Setup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import unworklet from "@unworklet/unplugin";

export default defineConfig({
  plugins: [unworklet()],
});
```

Type the `?worklet` import with one line in your `tsconfig.json` — no
`vite-env.d.ts`:

```jsonc
// tsconfig.json
{ "extends": "./.unworklet/tsconfig.json" }
```

On `vite dev` / `vite build` the plugin writes `.unworklet/` — that `tsconfig.json`
plus a `worklets.d.ts` of per-processor types — so `node.params.<name>` completes
and an undeclared name (or a wrong-typed assignment) is a type error, refreshed as
you edit. Adding processors only regrows `worklets.d.ts`; the tsconfig never
changes. `extends` doesn't merge `include`, so don't declare your own on this
tsconfig. Add `.unworklet/` to `.gitignore`; it's a generated artifact (the same
shape as Nuxt's `.nuxt/` or Prisma's client).

The extended config also carries `@unworklet/lang`'s editor plugin, so `.uwk.ts`
sugar type-checks with no `// @ts-nocheck`. **Can't extend** (an existing tsconfig
you can't restructure)? Write the same settings directly instead:
`compilerOptions.types: ["@unworklet/unplugin/client"]`, `compilerOptions.plugins:
[{ name: "@unworklet/lang/typescript-plugin" }]`, and list `.unworklet/worklets.d.ts`
in `include` (a `**/*` glob skips the dot-folder).

## Usage: loading a processor

Import the processor source with the **`?worklet` query** — this is what the
plugin intercepts. It takes the file's single `defineProcessor` export (you write
`export const stereoGain = …`; don't add `export default`) and re-exposes it as
that virtual module's **default export**, a compiled processor ready for
`createNode`.

```ts
import { createNode } from "@unworklet/core";
import stereoGain from "./processor.ts?worklet";

const ctx = new AudioContext();
const node = await createNode(ctx, stereoGain);
node.outputs.main.connect(ctx.destination);
```

A `.uwk.ts` processor is imported the same way (`./processor.uwk.ts?worklet`);
the plugin lowers the sugar before compiling.

That snippet is the unworklet wiring; the rest is a normal Vite app — an
`index.html` that loads your entry module, and a user gesture (a click) that calls
`ctx.resume()`, since an `AudioContext` starts suspended and otherwise stays
silent.

## Cross-origin isolation (SharedArrayBuffer)

unworklet shares audio data between the main thread and the worklet through a
`SharedArrayBuffer` — no copies, no postMessage round-trips, realtime-safe. The
browser only exposes `SharedArrayBuffer` on a **cross-origin isolated** page,
which takes two response headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

The plugin sets these on the **dev and preview servers** for you, so `vite dev`
and `vite preview` both just work (SAB behaves the same while you iterate and when
you check the build). `credentialless` is the least-breaking level — cross-origin
subresources still load, just without credentials. Opt out with `unworklet({
crossOriginIsolation: false })` if you serve your own headers (an app that already
sets either header is left untouched).

**Production is your server's job.** The plugin can't set headers on your
production host — serve the same two headers there, or `SharedArrayBuffer` is
unavailable and unworklet falls back to a slower `postMessage` transport (with a
one-time console warning).

## Options

```ts
unworklet({
  emitAnalysisArtifacts: true, // default false — opt in to emit <name>.graph/memory/diagnostics/schema-hash.json on build (a loop-heavy graph DAG can reach 100s of MB in dist/; artifacts past ~8 MB are skipped with a warning)
  crossOriginIsolation: true, // default — set COOP/COEP on the dev server so SharedArrayBuffer works
});
```

## DevTools

In `vite dev`, the plugin registers an "unworklet" panel in the Vite DevTools
dock and injects a zero-config page bridge — your app writes no DevTools code.
The panels read live data from every running node:

- **Audio graph** — the real Web-Audio topology + a per-node detail pane.
- **Live state** — each node's WASM slots (scalars + buffers), X-rayed live.
- **Signals** — a scope / spectrogram / level meter per output (AnalyserNode
  taps), declared memory, and the AudioContext's reported latency.
- **MIDI** — real outbound events, port overflow counters, and a virtual
  keyboard that injects into the running worklet.

## Related packages

- `@unworklet/core` — the processors this plugin loads (`defineProcessor`, `createNode`).
- `@unworklet/lang` — the `.uwk.ts` sugar this plugin lowers on the fly.
- `@unworklet/offline` — render a processor to PCM in Node/Bun/Deno.
- `@unworklet/test` — audio/event/MIDI assertions for Vitest.

License: MIT.
