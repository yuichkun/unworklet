# 07 — Vite plugin (`@unworklet/vite-plugin`)

The integration package that invokes the `compile` function exposed from `@unworklet/core` for each processor source, resolves their assets, emits source maps + analysis artifacts, and contributes the one DevTools panel (build errors) that unworklet itself ships. unworklet has no CLI; `vite build` and `vite` are the user-facing entry points. Hot module reload orchestration, live-coding glue, and richer DevTools panels are explicitly **out of scope** — they are user-land recipes built on the `replaceProcessor` primitive (`05-client.md` §8) plus the analysis artifacts this plugin emits.

## Status

skeleton (scope-level shape fixed per Q23 + Q24 + Q25; per-section detail filled incrementally)

## 1. Plugin scope

The plugin owns five responsibilities:

| Responsibility                                                                                                                                                        | Section |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| WASM compile invocation (= call `@unworklet/core`'s `compile` function to obtain `.wasm` + worklet JS template + typed `.d.ts`)                                       | §2      |
| Asset resolution (= `?worklet` query for processor URL)                                                                                                               | §3      |
| HMR boundary (= make `?worklet` imports hot-acceptable so user-land code can call `replaceProcessor`)                                                                 | §4      |
| Source maps (= `.ts` → AST → `.wasm` position propagation)                                                                                                            | §5      |
| DevTools panels + analysis JSON output (= first-party DX surface — opinionated by design, because every unworklet author needs the same view into the same machinery) | §6      |

The plugin is the only first-party bundler integration in v1.0.0. Other bundlers (Webpack, Rollup, esbuild) are out of v1.0.0 scope and may be added additively in v1.x.0 when consumer demand materializes. Authoritative rationale: `decisions-log.md` Q23+Q24+Q25.

## 2. WASM compile invocation

<!-- The compile pipeline itself lives in `@unworklet/core` as a public compile
     API; this plugin is responsible for invocation + source-change detection +
     asset pipeline integration. Pipeline: detect `defineProcessor` in `.ts` /
     `.tsx` files → call `@unworklet/core`'s `compile` function (03-compiler
     §1) → emit the full artifact set below + the sidecar `.wasm.map` source
     map (§5).

     Build artifacts (per processor) split into two phases:

     User-runtime artifacts (= shipped to the browser at runtime):
       - `.wasm` binary
       - worklet JS template (= `AudioWorkletProcessor` subclass wrapping the
         WASM; loaded via `audioWorklet.addModule(processorUrl)`)
       - typed client `.d.ts` (= `UnworkletNode<C>` shape for consumer TS code)

     Build-time metadata artifacts (= dev DX surface + public extension surface,
     authoritative shape in §6.3):
       - `dist/<processor>.graph.json`        — AST DAG view
       - `dist/<processor>.memory.json`       — per-declaration byte counts (Q30)
       - `dist/<processor>.diagnostics.json`  — 3-layer error / warning list with
                                                 stable IDs (03-compiler §2.5 / §2.6)
       - `dist/<processor>.schema-hash.json`  — snapshot migration anchor
                                                 (01-dsl §8.3 / §6.3 below)

     Per-artifact byte-layout / JSON schema detail is impl-phase fill per Q61. -->

## 3. Asset resolution

<!-- - `import processorUrl from './my.processor.ts?worklet'` resolves to the built WASM + worklet glue URL.
     - Vite asset pipeline integration: file hashing, public path, base URL respect.
     - Worklet module loading via `audioContext.audioWorklet.addModule(processorUrl)`. -->

## 4. HMR boundary

The plugin does **not** orchestrate hot-reload. The Web Audio spec offers no `removeModule()`, `registerProcessor()` rejects duplicate names, and `AudioWorkletGlobalScope` registrations live as long as the `AudioContext` — meaning any "auto-swap on file change" pattern is fundamentally a user-land choice with trade-offs the framework should not bake in. The dynamic-swap primitive itself (`replaceProcessor`) lives in `@unworklet/core` (`05-client.md` §8); this plugin only ensures that a `?worklet` import is a valid Vite HMR boundary so user-land code can wire it up.

What the plugin does at §4 level:

- Marks `import processorUrl from './my.processor.ts?worklet'` as an HMR-accepting boundary, so a source edit to `my.processor.ts` triggers a Vite HMR update for any module importing it (rather than a full-page reload).
- Recompiles WASM on file change by re-invoking `@unworklet/core`'s `compile` function, then delivers the rebuilt module to subscribed `import.meta.hot.accept` callbacks; what those callbacks do with the new module is user-land.

What user-land does on top:

```typescript
import { createNode, replaceProcessor } from "@unworklet/core";
import MyProcessor from "./my.processor.ts?worklet";

const audioCtx = new AudioContext();
let current = await createNode(audioCtx, MyProcessor);
current.connect(audioCtx.destination);

if (import.meta.hot) {
  import.meta.hot.accept("./my.processor.ts?worklet", async (mod) => {
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

The plugin contributes a first-party panel surface to Vite DevTools Kit. The surface is the unworklet developer's DX path — it is not visible to the end consumer of an audio app built on unworklet, only to the author of that app at dev time. Because every unworklet author looks into the same machinery (the same graph capture, the same memory budget, the same state slots, the same MIDI ringbuffers), shipping a default panel set is the right level of opinionation: leaving each author to wire up their own debug UI from raw JSON would force the entire ecosystem to rediscover the same set of views.

Where opinionation **does** end: panels never interpret user-authored DSP logic or app UI. They visualize unworklet's declared surfaces (graph DAG, declared slots, ringbuffer counters, error inventory, recorded audio). Anything tied to a particular processor's domain (synth voice grid, EQ band visualization, custom dashboards) stays user-land. The framework writes type-driven representations + a switchable dropdown so an `f32` buffer can default to waveform but be flipped to a bar chart or list when the author's intent says so.

### 6.1 Panel inventory (= 1 dock entry, sidebar with 4 panels + 1 secondary)

The plugin registers a single dock entry titled `unworklet`. The iframe inside hosts a Vue SPA whose sidebar switches between 4 panels. A 5th surface (Snapshot inspector) lives inside the Audio graph panel as a tab — invoked rarely (= preset / save-load debugging), so it does not warrant a top-level sidebar slot.

| Panel                    | Dev use case                                                                                                       | Mechanism                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Audio graph           | Verify wiring of all `AudioNode`s in the live context; drill into an unworklet node for declared shape + build errors + snapshot | `AudioNode.prototype.connect/disconnect` monkey patch (dev only, opt-out) + `UnworkletNode` WeakSet auto-registry; click → 3 detail tabs (= Declared shape / Build errors / Snapshot) |
| 2. Live state            | Observe every `publish` slot across every unworklet node; verify the audio thread is moving + slots are not stuck  | `state.<type>.expose({ publish })` + `buffer.<type>.expose({ publish })` (= `01-dsl.md` §3); type-driven representation (= `f32`/`i32` scalar = value + sparkline, `bool` scalar = on/off color, `f32`/`f64` buffer = waveform, `i32`/`i64` buffer = bar chart, `bool` buffer = grid, `u8` buffer = hex dump) + user-switchable dropdown |
| 3. Signals & performance | Confirm audio output, record short windows for bug reports, watch realtime budget                                  | 3 sub-tabs: Audio (= AnalyserNode auto-attach via signal probe opt-in method, ring buffer 10 s, 16-bit PCM WAV encoder + JSZip multi-port export), Latency (= worklet-thread `currentFrame`/`sampleRate` measurement → SAB → streaming, P50/P95/P99/Max + budget line), Memory (= `compile()` `result.memory` per-declaration roll-up + 64 MB warn / 4 GB error lines) |
| 4. MIDI                  | Inspect declared MIDI ports + overflow counts; inject from a virtual keyboard when no hardware controller is on hand | `node.midi.<name>.diagnostics.overflowCount()` (= `11-midi.md` §4) per port + virtual keyboard inject path that routes through `client.call('unworklet:midi:send', ...)` → server RPC → `node.midi.<name>.send(...)` |
| Audio graph — Snapshot tab (= secondary) | Inspect captured snapshot blob; replay / verify what `restore(blob)` would see                                     | `node.snapshot()` + `inspect(blob)` (= `05-client.md` §2.6); accessed via the Audio graph node click, not the sidebar                                              |

### 6.1.1 Reject list (= permanently out of the panel surface)

These designs were considered and rejected for v1.0.0; they do not appear in the inventory. Same list lives in `AGENTS.md` under "DevTools panel — recurring violations to avoid" — see there for rationale per entry.

- **MediaRecorder for audio capture** — WebM is browser-internal; the panel records via AnalyserNode + ring buffer + in-house 16-bit PCM WAV encode so output opens in any DAW.
- **Domain-specific layout baked into the framework UI** (voice grid, envelope chips, etc.) — type-driven representations + dropdown switching covers the surface without claiming to understand user domain.
- **Jump-to-source button in Build errors** — the modal already carries source snippet + Why + Fix.
- **Swap history panel** — `ReplaceResult` is synchronous and Q63 emits a one-time warning; history is not a panel.
- **Time-travel debugging** — incompatible with realtime invariants + IIR state cannot be deterministically rewound. Recorded windows from the Audio sub-tab cover the offline-analysis case.

### 6.2 Command palette entries (v1.0.0)

- `unworklet:show-audio-graph` — focus the Audio graph panel
- `unworklet:show-live-state` — focus the Live state panel
- `unworklet:show-signals` — focus the Signals & performance panel
- `unworklet:show-midi` — focus the MIDI panel
- `unworklet:midi-send` — server RPC; invoked by the panel's virtual keyboard, not by the user directly (= panel inject path)

### 6.3 Analysis JSON artifacts

The panels above read their data from a stable set of artifacts. The four JSON files in the table below are produced by `@unworklet/core`'s `compile` function and emitted to disk by this plugin at build time; the same data is mirrored over the DevTools Kit's Shared State / Streaming channels at dev time. The artifacts are documented as a public extension surface — third-party panels, CI integrations, and alternate tooling read the same files / channels and stay forward-compatible:

| Artifact                            | Source                                                                                 | Consumed by                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `dist/<processor>.graph.json`       | AST DAG: per-block code + `forSample` loops, declaration list, subgraph instantiations | Audio graph / Declared shape tab                                  |
| `dist/<processor>.memory.json`      | Per-declaration byte counts (Q30) + total + thresholds                                 | Signals & performance / Memory sub-tab                            |
| `dist/<processor>.diagnostics.json` | Full 3-layer error / warning list with stable IDs                                      | Audio graph / Build errors tab                                    |
| `dist/<processor>.schema-hash.json` | Migration anchors (`01-dsl.md` §8.3)                                                   | Audio graph / Snapshot tab                                        |

Dev-time live channels (= Shared State + Streaming over the DevTools Kit RPC) carry the runtime side: `state.publish` / `buffer.publish` values (Q27), MIDI overflow counters (Q4-c), per-quantum latency samples, AnalyserNode time-domain / frequency-domain frames per unworklet output port. The exact channel names and payload shapes are documented as part of the public extension surface.

### 6.4 New surface declared alongside the panel set

The panel set depends on a small set of new public surfaces. Each entry below is the spec-side contract; the runtime fill lands in Phase 6 末 尾 (see `10-roadmap.md`).

- **`AudioNode.prototype.connect/disconnect` monkey patch** (dev-only, opt-out via `unworklet({ devtools: { observeAudioGraph: false } })`). Wraps all 5 connect overloads + all 5 disconnect overloads, preserves return values via `.apply(this, arguments)`, records edge changes into a Shared State channel so the Audio graph panel can render the live AudioContext graph. Production builds emit no patch.
- **`UnworkletNode` auto-registry** (= internal WeakSet inside `@unworklet/core`). `createNode(...)` registers the produced wrapper; `dispose()` removes it. Panels discover live unworklet nodes through a server RPC against this set without exposing it as a public consumer surface.
- **`node.<signal-probe-method>()` opt-in** (= the exact name lands when its grill closes — candidates: `attachSignalProbe()` / `enableProbes()` / `tapForDev()`). When called in a dev build, the wrapper inserts a pass-through `AnalyserNode` between every declared output port and its downstream connections. Production builds compile the method down to a no-op so consumer bundles pay zero cost.
- **MIDI inject RPC `unworklet:midi:send`** (= `defineRpcFunction({ name: 'unworklet:midi:send', type: 'action', handler })` inside `setupDevtools`). The panel's virtual keyboard calls it with `{ nodeId, portName, event }`; the handler looks the node up through the WeakSet registry and forwards the event to `node.midi.<portName>.send(...)`.

### 6.5 Why this split — not the inverse

DevTools panels are a DX surface, not consumer-visible UI; every unworklet author needs the same set of views into the same machinery, so the framework ships default panels for that universal set. An alternative split — shipping one panel (Build errors) and emitting JSON for everything else, on the theory that "richer panels are UI decisions and should be third-party" — is rejected: it forces each author (or each downstream plugin) to rebuild the universal set. The line is: ship default panels for everything that visualizes unworklet's own declared surfaces, and document the underlying artifacts + channels as a stable extension surface so third parties can compose their own panels (visual programming editors, dashboards, alternate inspectors) on top. Authoritative rationale: `decisions-log.md` Q23+Q24+Q25.

What stays user-land remains user-land: HMR orchestration (= file-watch + auto-swap + auto-reconnect), live-coding REPLs, visual-programming editors, anything that touches the consumer's audio graph or DSP semantics. The dynamic-swap primitive `replaceProcessor` (`05-client.md` §8, Q50) is what those user-land tools build on; the plugin itself never calls it.

### 6.6 Deferred to v1.x.0

- Cycle / instruction estimate panel (= static-analysis-driven cost prediction, gated on estimation precision work).
- Plugins for other bundlers (Webpack, Rollup, esbuild) — same panel set + analysis surface, different host integration.

<!-- TODO §6.x: exact JSON schemas for each artifact, Shared State channel names, RPC method signatures for inspector-style panels, screenshot references. -->
