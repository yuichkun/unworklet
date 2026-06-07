# @unworklet/vite-plugin

The Vite plugin for unworklet. It turns a `?worklet` import into a ready-to-run
AudioWorklet processor (compiles the graph to WASM, wires up the module URLs),
lowers `.uwk.ts` sugar on the fly, emits analysis JSON on build, and hosts a
DevTools panel (audio graph / live state / signals / MIDI) in dev.

```bash
npm install -D @unworklet/vite-plugin
npm install @unworklet/core
```

## Setup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import unworklet from "@unworklet/vite-plugin";

export default defineConfig({
  plugins: [unworklet()],
});
```

Type the `?worklet` import with one line in your `vite-env.d.ts` (alongside
Vite's own client types):

```ts
// vite-env.d.ts
/// <reference types="vite/client" />
/// <reference types="@unworklet/vite-plugin/client" />
```

## Usage: loading a processor

Import the processor source with the **`?worklet` query** — this is what the
plugin intercepts. The **default export** of that virtual module is a compiled
processor ready for `createNode`.

```ts
import { createNode } from "@unworklet/core";
import stereoGain from "./processor.ts?worklet";

const ctx = new AudioContext();
const node = await createNode(ctx, stereoGain);
node.outputs.main.connect(ctx.destination);
```

A `.uwk.ts` processor is imported the same way (`./processor.uwk.ts?worklet`);
the plugin lowers the sugar before compiling.

## Cross-origin isolation (SharedArrayBuffer)

unworklet shares audio data between the main thread and the worklet through a
`SharedArrayBuffer` — no copies, no postMessage round-trips, realtime-safe. The
browser only exposes `SharedArrayBuffer` on a **cross-origin isolated** page,
which takes two response headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

The plugin sets these on the **dev server** for you, so `vite dev` just works.
`credentialless` is the least-breaking level — cross-origin subresources still
load, just without credentials. Opt out with `unworklet({ crossOriginIsolation:
false })` if you serve your own headers (an app that already sets either header
is left untouched).

**Production is your server's job.** The plugin can't set headers on your
production host — serve the same two headers there, or `SharedArrayBuffer` is
unavailable and unworklet falls back to a slower `postMessage` transport (with a
one-time console warning). `vite preview` deliberately does **not** inject the
headers, so it mirrors that production behavior.

## Options

```ts
unworklet({
  emitAnalysisArtifacts: true, // default — emit <name>.graph/memory/diagnostics/schema-hash.json on build
  crossOriginIsolation: true, // default — set COOP/COEP on the dev server so SharedArrayBuffer works
  include: ["src/**/*.processor.ts", "src/**/*.uwk.ts"], // optional globs
  exclude: [], // optional globs
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
