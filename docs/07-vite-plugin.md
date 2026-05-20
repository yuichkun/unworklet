# 07 — Vite plugin (`@unworklet/vite-plugin`)

The integration package that compiles processors, resolves their assets, emits source maps + analysis artifacts, and contributes the one DevTools panel (build errors) that unworklet itself ships. unworklet has no CLI; `vite build` and `vite` are the user-facing entry points. Hot module reload orchestration, live-coding glue, and richer DevTools panels are explicitly **out of scope** — they are user-land recipes built on the `replaceProcessor` primitive (`05-client.md` §8) plus the analysis artifacts this plugin emits.

## Status

skeleton (scope-level shape fixed per Q23 + Q24 + Q25; per-section detail filled incrementally)

## 1. Plugin scope

The plugin owns five responsibilities:

| Responsibility | Section |
|---|---|
| WASM build (= compile `defineProcessor` to `.wasm` + worklet JS template + typed `.d.ts`) | §2 |
| Asset resolution (= `?worklet` query for processor URL) | §3 |
| HMR boundary (= make `?worklet` imports hot-acceptable so user-land code can call `replaceProcessor`) | §4 |
| Source maps (= `.ts` → AST → `.wasm` position propagation) | §5 |
| DevTools panels + analysis JSON output (= first-party DX surface — opinionated by design, because every unworklet author needs the same view into the same machinery) | §6 |

The plugin is the only first-party bundler integration in v1.0.0. Other bundlers (Webpack, Rollup, esbuild) are out of v1.0.0 scope and may be added additively in v1.x.0 when consumer demand materializes. Authoritative rationale: `decisions-log.md` Q23+Q24+Q25.

## 2. WASM build

<!-- - Detects `defineProcessor` declarations in `.ts` files (extensible to `.tsx`).
     - Invokes the compiler pipeline (= internal module of `@unworklet/core`, see `03-compiler.md`): AST capture → static analysis → multi-target emission.
     - Outputs per processor: `.wasm` binary, worklet JS template, typed `.d.ts`, `dist/schema-hash.json` (snapshot/migration anchor — see `01-dsl.md` §8.3).
     - Runs as a Vite plugin transform; participates in `vite build` and the dev server pipeline. -->

## 3. Asset resolution

<!-- - `import processorUrl from './my.processor.ts?worklet'` resolves to the built WASM + worklet glue URL.
     - Vite asset pipeline integration: file hashing, public path, base URL respect.
     - Worklet module loading via `audioContext.audioWorklet.addModule(processorUrl)`. -->

## 4. HMR boundary

The plugin does **not** orchestrate hot-reload. The Web Audio spec offers no `removeModule()`, `registerProcessor()` rejects duplicate names, and `AudioWorkletGlobalScope` registrations live as long as the `AudioContext` — meaning any "auto-swap on file change" pattern is fundamentally a user-land choice with trade-offs the framework should not bake in. The dynamic-swap primitive itself (`replaceProcessor`) lives in `@unworklet/core` (`05-client.md` §8); this plugin only ensures that a `?worklet` import is a valid Vite HMR boundary so user-land code can wire it up.

What the plugin does at §4 level:

- Marks `import processorUrl from './my.processor.ts?worklet'` as an HMR-accepting boundary, so a source edit to `my.processor.ts` triggers a Vite HMR update for any module importing it (rather than a full-page reload).
- Recompiles WASM on file change and delivers the rebuilt module to subscribed `import.meta.hot.accept` callbacks; what those callbacks do with the new module is user-land.

What user-land does on top:

```typescript
import { createNode, replaceProcessor } from '@unworklet/core';
import MyProcessor from './my.processor.ts?worklet';

const audioCtx = new AudioContext();
let current = await createNode(audioCtx, MyProcessor);
current.connect(audioCtx.destination);

if (import.meta.hot) {
  import.meta.hot.accept('./my.processor.ts?worklet', async (mod) => {
    const result = await replaceProcessor(current, mod.default);
    result.node.connect(audioCtx.destination);
    current.disconnect();
    current = result.node;
  });
}
```

`replaceProcessor`'s contract — what it does, what it does not do, how schema drift surfaces in the typed wrapper, what accumulates across repeated calls — is fully covered in `05-client.md` §8 and `decisions-log.md` Q50. Live-coding REPLs and visual-programming editors compose the same primitive without `import.meta.hot`.

In production builds the plugin emits no HMR boundary code and the runtime has no swap-related overhead.

<!-- TODO §4.x: exact `?worklet` HMR payload shape (new module export?), interaction with Vite's standard HMR API for non-worklet modules in the same file. -->

## 5. Source maps

<!-- - `.ts` → AST DAG → `.wasm` source position propagation through the compiler.
     - Output: sidecar `.wasm.map` alongside `.wasm`.
     - Consumed by: DevTools error diagnostics, Live latency monitor (sample-level attribution), browser DevTools when stepping through worklet code.
     - Authoritative rationale: `decisions-log.md` Q23+Q24+Q25. -->

## 6. DevTools panels + analysis JSON

The plugin contributes a first-party panel set to Vite DevTools Kit. These panels are the unworklet developer's DX surface — they are not visible to the end consumer of an audio app built on unworklet, only to the author of that app at dev time. Because every unworklet author looks into the same machinery (the same graph capture, the same memory budget, the same state slots, the same MIDI ringbuffers), shipping default panels is the right level of opinionation: leaving each author to wire up their own debug UI from raw JSON would force the entire ecosystem to rediscover the same set of views.

Where opinionation **does** end: the panels never look at user-authored DSP logic or app UI. They visualize unworklet's own structures (graph DAG, declared slots, ringbuffer counters, error inventory). Anything specific to a particular processor's domain (spectrum, oscilloscope, custom dashboards) stays user-land.

### 6.1 Panel catalog (v1.0.0)

Each panel is a thin presentation layer over an already-ratified unworklet mechanism. The mapping is 1-to-1:

| Panel | Dock entry type | unworklet mechanism | DevTools Kit primitive |
|---|---|---|---|
| Build errors / warnings | Structured Diagnostics | 3-layer error model (`error[unworklet/<id>]`, `03-compiler.md` §2.5) with `decisions-log.md` cross-refs | `ctx.diagnostics.defineDiagnostics()` (code prefix `UWK`, `docsBase` → unworklet docs URL) |
| Graph viewer | iframe | per-block code + `forSample` loops + declaration scope + subgraph instantiation (`00-foundations.md` §3, `01-dsl.md` §1) | Shared State (reactive on rebuild) |
| Memory budget | json-render | per-declaration auto-sum (Q30, `03-compiler.md` §2.4) | Shared State |
| Live state inspector | iframe | named `state` slot + `state.publish` (Q27, `01-dsl.md` §3) | Shared State (audio thread → main reactive sync) |
| Live latency monitor | iframe | render-quantum cost measurement on the audio thread | Streaming (P50 / P95 / P99 / Max) |
| MIDI flow / overflow | json-render | `node.midi.<name>.diagnostics` (Q4-c, `11-midi.md` §4) | Shared State |
| Snapshot inspector | iframe | `snapshot()` + `inspect(blob)` (Q5 + Q48, `05-client.md` §2.6) | RPC (panel → server-side `inspect`) |
| Swap history | json-render | `replaceProcessor` invocations + their `ReplaceResult` (Q50, `05-client.md` §8) | Shared State |

### 6.2 Command palette entries (v1.0.0)

- `unworklet:show-errors` — focus the Structured Diagnostics panel
- `unworklet:show-graph` — open the Graph viewer
- `unworklet:show-state` — open the Live state inspector
- `unworklet:show-memory` — open the Memory budget panel
- `unworklet:show-latency` — open the Live latency monitor
- `unworklet:show-midi` — open the MIDI flow / overflow panel
- `unworklet:show-snapshot` — open the Snapshot inspector
- `unworklet:show-swaps` — open the Swap history panel

### 6.3 Analysis JSON artifacts

The panels above all read their data from a stable set of artifacts that the plugin emits at build time and mirrors over the DevTools Kit's Shared State / Streaming channels at dev time. The same artifacts are documented as a public extension surface — third-party panels, CI integrations, and alternate tooling read the same files / channels and stay forward-compatible:

| Artifact | Source | Consumed by (first-party panels) |
|---|---|---|
| `dist/<processor>.graph.json` | AST DAG: per-block code + `forSample` loops, declaration list, subgraph instantiations | Graph viewer |
| `dist/<processor>.memory.json` | Per-declaration byte counts (Q30) + total + thresholds | Memory budget |
| `dist/<processor>.diagnostics.json` | Full 3-layer error / warning list with stable IDs | Build errors / warnings |
| `dist/<processor>.schema-hash.json` | Migration anchors (`01-dsl.md` §8.3) | Snapshot inspector, Swap history |

Dev-time live channels (= Shared State + Streaming over the DevTools Kit RPC) carry the runtime side: `state.publish` values (Q27), MIDI overflow counters (Q4-c), per-quantum latency samples, and `replaceProcessor` invocation events. The exact channel names and payload shapes are documented as part of the public extension surface.

### 6.4 Why this split — not the inverse

DevTools panels are a DX surface, not consumer-visible UI; every unworklet author needs the same set of views into the same machinery, so the framework ships default panels for that universal set. An alternative split — shipping one panel (Build errors) and emitting JSON for everything else, on the theory that "richer panels are UI decisions and should be third-party" — is rejected: it forces each author (or each downstream plugin) to rebuild the universal set. The line is: ship default panels for everything that visualizes unworklet's own structures, and document the underlying artifacts + channels as a stable extension surface so third parties can compose their own panels (visual programming editors, dashboards, alternate inspectors) on top. Authoritative rationale: `decisions-log.md` Q23+Q24+Q25.

What stays user-land remains user-land: HMR orchestration (= file-watch + auto-swap + auto-reconnect), live-coding REPLs, visual-programming editors, anything that touches the consumer's audio graph or DSP semantics. The dynamic-swap primitive `replaceProcessor` (`05-client.md` §8, Q50) is what those user-land tools build on; the plugin itself never calls it.

### 6.5 Deferred to v1.x.0

- Cycle / instruction estimate panel (= static-analysis-driven cost prediction, gated on estimation precision work).
- Plugins for other bundlers (Webpack, Rollup, esbuild) — same panel set + analysis surface, different host integration.

<!-- TODO §6.x: exact JSON schemas for each artifact, Shared State channel names, RPC method signatures for inspector-style panels, screenshot references. -->
