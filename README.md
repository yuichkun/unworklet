<p align="center">
  <img src="./assets/unworklet-logo-chain.svg" alt="unworklet" width="420" />
</p>

<p align="center">
  Write an AudioWorklet as a declarative TypeScript graph — compiled to WebAssembly that runs on the audio thread.
</p>

---

No hand-written `AudioWorkletProcessor`, no `postMessage` plumbing, no manual WASM.
You describe the DSP with typed primitives; unworklet compiles it to WebAssembly,
loads it into an `AudioWorklet`, and hands you a typed main-thread node. A
processor that compiles is realtime-safe — the compiler enforces the audio-thread
contract (no allocation, no unbounded loops, no GC) at build time.

> **Status:** v1.0.0 implementation in progress (see [`docs/10-roadmap.md`](./docs/10-roadmap.md)).

## Quick start

```bash
npm install @unworklet/core
npm install -D @unworklet/vite-plugin   # loads processors via the ?worklet query
```

```ts
// processor.ts — runs on the audio thread, compiled to WASM
import { audioInput, audioOutput, defineProcessor, forSample, param } from "@unworklet/core";

export const gain = defineProcessor(() => {
  const input = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const g = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" }).named("gain");
  return {
    process: () =>
      forSample((i) => {
        out.left.at(i).write(input.left.at(i).mul(g.at(i)));
        out.right.at(i).write(input.right.at(i).mul(g.at(i)));
      }),
  };
});
```

```ts
// main.ts — the typed main-thread handle
import { createNode } from "@unworklet/core";
import { gain } from "./processor.ts?worklet"; // the ?worklet query is required

const ctx = new AudioContext();
const node = await createNode(ctx, gain);
source.connect(node.inputs.main);
node.outputs.main.connect(ctx.destination);
node.params.gain.value = 2;
```

Prefer infix math? Write the same processor in `.uwk.ts` sugar with
[`@unworklet/lang`](./packages/lang/README.md) — `out.left[i] = input.left[i] * gain[i]`.

## Packages

| package                                                      | what it does                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| [`@unworklet/core`](./packages/core/README.md)               | The DSL surface, the WASM compiler, the worklet runtime, and the typed main-thread node. |
| [`@unworklet/vite-plugin`](./packages/vite-plugin/README.md) | Loads `.processor.ts` / `.uwk.ts` via `?worklet`; hosts the DevTools panel.              |
| [`@unworklet/lang`](./packages/lang/README.md)               | `.uwk.ts` authoring sugar (infix operators, index access) that lowers to core.           |
| [`@unworklet/offline`](./packages/offline/README.md)         | Render a processor to PCM headlessly in Node / Bun / Deno.                               |
| [`@unworklet/test`](./packages/test/README.md)               | Audio / event / MIDI assertions and signal generators for Vitest.                        |

## Docs

- **Specification:** [`docs/`](./docs/) — start at [`docs/00-foundations.md`](./docs/00-foundations.md); every decision is logged in [`docs/decisions-log.md`](./docs/decisions-log.md).
- **Canonical examples:** [`docs/12-canonical-examples.md`](./docs/12-canonical-examples.md).
- **For AI agents / LLMs:** [`llms.txt`](./llms.txt) is the install-time entry point; the per-package READMEs above carry the exact call forms.

## Contributing

This is a pnpm monorepo driven entirely through the Vite+ CLI (`vp`).

```bash
vp install        # install dependencies
vp check          # lint + format + typecheck (vp check --fix to auto-fix)
vp test           # vitest aggregation (node-side + browser SAB / postMessage)
```

Packages have a build cycle (`core` ↔ `vite-plugin`), so the build runs in an
explicit order rather than `vp run -r build`:

```bash
vp run --filter @unworklet/lang build && \
vp run --filter @unworklet/vite-plugin build && \
vp run --filter @unworklet/core build && \
vp run --filter @unworklet/offline build && \
vp run --filter @unworklet/test build
```

Implementation conventions and AI-agent guidance: [`AGENTS.md`](./AGENTS.md).

License: MIT.
