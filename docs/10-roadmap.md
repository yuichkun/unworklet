# 10 — Roadmap

Milestone scoping for v1.0.0, with the smallest possible footprint of forward-looking commitments.

This doc is independent of the component docs and can be picked up at any time.

## Status

partial (§1 written at Q62; §2 implementation phases written; §3.1 mandatory deferred mitigations written; §3.2 placeholder)

## 1. v1.0.0 acceptance criteria

A checklist that lets an impl AI agent make a single, unambiguous ship/no-ship call. Any item that fails blocks the release; all items passing clears it. Q62 (`decisions-log.md`).

### A. Build / compile

- **A1** — `vp build` passes (exit 0) for all 4 public packages and internal modules.
- **A2** — WASM emission succeeds for canonical Ex 1–8 (graph capture + WASM generation for each `defineProcessor` body).
- **A3** — `vp check` passes (exit 0): tsgo typecheck + oxlint + oxfmt.

### B. Functional

- **B1** — Expected output for canonical Ex 1–8 is reproduced by `@unworklet/offline` with bit-exact agreement against the reference audio / event sequence.

### C. Safety

- **C1** — All 5 realtime-safety invariants (no heap alloc / no unbounded loops / no throw / no blocking I/O / no GC, `00-foundations.md` §5.1) are detected via the layered enforcement defined in `00-foundations.md` §5.2 (L1 / L2 / L3 / Emission / Runtime guard). A violation test is written for each invariant, and each enforcement layer is verified to reject violations as specified.

### D. Browser matrix

- **D1** — Browser smoke pass across the full matrix: `Chromium × Firefox × Safari` × `{COOP/COEP cross-origin isolated, not isolated}` — 6 cells total, each running canonical Ex 1–3 with successful startup and audio output.

  **Smoke test scope**: `connectFromWebMIDI` (the standard Web MIDI wrapper) is excluded from the test (it sits outside the emission boundary and is the consumer's responsibility; see `08-deployment.md` §2 B1). MIDI behavior is verified uniformly across all browser cells via source-agnostic injection through `node.midi.<name>.send(event)` (`11-midi.md` §3).

### E. Integrity

- **E1** — `open-questions.md` is empty: every question has been moved to `decisions-log.md`, leaving zero open items in this file.

### F. Public surface integrity

- **F1** — The `.d.ts` public surface is consistent with all entries in `decisions-log.md` Q1–Q77 (Q28 is excluded as an unassigned numbering artifact), meaning every ratified decision is reflected in the public surface.

## 2. Implementation phases

14 phases targeting v1.0.0 ship, each completing within a few conversation units with a commit + diff review pause cadence. Detailed step-level plans for each phase (files touched, build order, verification method) are fixed in plan mode at the start of each phase; only phase scope and completion criteria are declared here.

Phase ordering is determined by dependency: later phases depend on the outputs of earlier ones. The guiding axis is "ship a working unit as early as possible"; getting the foundation perfect before moving on is not the priority.

### Implementation invariant (HARD CONTRACT)

**Minimal / vertical-slice implementations within a phase are acceptable by design**, but the following are **absolutely prohibited** (aligned with `AGENTS.md` "Implementation invariant"):

1. **Ad hoc implementations that diverge from docs** — The public API surface (public types / argument shapes / return shapes, as specified in `09-repo-structure.md` §2.1 + §2.2 and each component doc) must be kept in sync with the docs. "Ship it in a different shape now and fix it later" is not allowed within a phase.
2. **Implementations that break forward compatibility** — Any design that conflicts with surfaces added in later phases (additional declaration kinds / new primitives / main-side method extensions / messaging surface extensions, etc.) is prohibited. Everything implemented within a phase must be a **subset** of the final architecture, expanding to a **superset** as later phases build on top.

At the start of each phase, consult the docs covering the surfaces being touched (`00-foundations.md` / `01-dsl.md` / each component doc / the relevant Q entries in `decisions-log.md`) and implement as a subset of the final design. "Minimal = just enough to work" is acceptable; "ad hoc = needs a major rewrite later" is not — the latter is a phase-completion violation subject to retraction.

At the skeleton stage (Phase 2), **public types are declared in their final form; the bodies are stub implementations** (e.g. `throw new Error('not implemented')`). Later phases fill in the declared surfaces one by one. This keeps the project in a "all public surfaces declared, some implemented" state that advances without backtracking.

### Phase 1 — WASM emit verification

Foundation phase for the WASM emission pipeline. Using binaryen (a JS package for building WASM IR and emitting WASM binaries at build time), progressively build, run, and inspect `.wat` output (the human-readable text format of WASM) for minimal WASM modules from host JS (Node.js / Bun / Deno).

binaryen is the confirmed WASM emission path for v1.0.0 — this phase is not a feasibility evaluation. The goal is to incrementally verify that the required opcodes emit correctly through the binaryen IR API and that the emitted WASM runs under `WebAssembly.instantiate()` in host JS, while gaining hands-on understanding of WASM behavior (memory model / function signatures / instruction set).

Each step follows the loop: build with binaryen → emit `.wat` → `instantiate` + run in Node → verify output. The PoC lives in a dedicated directory inside the repo and is self-contained (independent of the monorepo structure; not imported by later phases directly). binaryen is placed as a dependency of `@unworklet/core` and used exclusively inside the `compile` function exposed from `@unworklet/core` (exposed in Phase 3), loaded via dynamic import so it is excluded from the production runtime bundle of static-path consumers (not included in the consumer's shipped bundle; aligned with `09-repo-structure.md` §2.4).

Completion criteria: minimal WASM variants (constant output / passthrough / scalar multiply / runtime-param multiply / bounded loop equivalent to `forSample`) are each emitted via binaryen and confirmed running in Node. The `.wat` output for each step has been read and understood, leaving WASM behavior fully internalized before entering Phase 2.

### Phase 2 — Foundation: repo + 4-package skeleton

pnpm workspace + `vp` CLI gate + MIT license + TS 5.5+ + vitest configuration (per `09-repo-structure.md` §1 / §3 / §4 / §5). Empty entry points for all 4 public packages + `/simd` subpath + dependency edges (per `09-repo-structure.md` §2.4). Each package gets `package.json` + `tsconfig.json` + `src/index.ts` (empty exports).

Completion criteria: `vp install` + `vp check` + `vp test` exit 0 across all packages; workspace refs between the 4 packages resolve correctly; **all public named exports and public types specified in `09-repo-structure.md` §2.1 + §2.2 and each component doc are declared (stub implementations acceptable; bodies may be `throw new Error('not implemented')`), with the codebase in a state where an external consumer can type-check against the full surface in TypeScript** (the "public surface skeleton declared first" path of the implementation invariant).

### Phase 3 — Vertical slice: stereo gain (no meter) running under `renderOffline`

Run the minimum vertical slice — a meter-less version of canonical Ex 1 — end-to-end. Scope:

- `Node<T>` proxy (branded type + AST node construction base)
- Minimal declaration helpers (`audioInput` / `audioOutput` / `param.f32.named`)
- `defineProcessor` graph capture (builds the AST DAG via the proxy)
- `forSample` + minimal primitives (`mul`, including method form `.mul`)
- WASM emission core path (literal / mul / audio I/O marshalling / param marshalling / `forSample` loop)
- `compile(processor)` exported from `@unworklet/core` (argument: the return value of `defineProcessor()`, a graph-captured AST; return value: `{ wasm, graph, memory, diagnostics, schemaHash }` all at once, async. Internally calls binaryen via dynamic import — the binaryen path validated in the Phase 1 PoC is placed inside the core compile module)
- `renderOffline()` WASM-driven path (internally invokes `compile`, then `WebAssembly.instantiate()`, feeds input PCM to WASM in render-quantum chunks, and collects output PCM — `renderOffline` is self-contained: graph capture + compile + execution all happen inside it, with no dependency on the Vite plugin)

The meter portion (`state.publish`) is designed to be added in Phase 6 (messaging) and is omitted here. The binaryen experience from Phase 1 informs the WASM emission module placed inside `@unworklet/core`.

Completion criteria: Ex 1 minus meter runs under `renderOffline()`, with the input × param gain reflected in the output PCM.

### Phase 4 — Test infrastructure

Mount all 43 declared surface items + chain form from `@unworklet/test` (per `06-testing.md` §2–§6) on top of `renderOffline`:

- 20 matchers (audio 3 / sample-level 10 / event 3 / MIDI 2 / state 2)
- 7 signal utilities (sine / silence / impulse / sineSweep / whiteNoise / dc / ramp)
- 10 MIDI utilities (`midi` namespace + `sequence`)
- 6 sample/time utilities (samplesToMs / msToSamples / samplesToSec / secToSamples / bpmToSamples / bpmToMs)
- Chain form (`@unworklet/test/extend` side-effect import registers all matchers via vitest `expect.extend(...)`; TS-only `WhenResult<T, M>` guard makes chain methods `never` on anything other than `RenderOfflineResult`)

vitest snapshot-based wav auto-write + bit-exact comparison (`expectAudioMatchesSnapshot` / `expectAudioMatchesGolden`) captures reference PCM for canonical Ex 1 (meter-less version) and guards against regression. `expectStateValue` depends on upstream `inspect` (`05-client.md` §2.6) and ships together with Phase 11.

Because `renderOffline` is self-contained for compile + execution (established in Phase 3), tests run without the Vite plugin (standard Vitest environment only; build pipeline integration is the Vite plugin's responsibility in Phase 5).

Completion criteria: Vitest reports the audio output of Ex 1 (meter-less) matching the reference at tolerance=0; CI passes stably.

### Phase 5 — Vite plugin (core functionality + DevTools panel visuals)

Ship the bundler integration features of `@unworklet/unplugin` and the visual shell of the DevTools panel, putting later vertical-slice verification on a dev server immediately. Scope:

- `?worklet` query resolution (`import processorUrl from './x.processor.ts?worklet'` resolved by Vite; plugin calls `compile` from `@unworklet/core`)
- Source-change detection + build pipeline integration (invoke `compile` in dev server and production build)
- Metadata artifact emission (`dist/<processor>.graph.json` / `.memory.json` / `.diagnostics.json` / `.schema-hash.json`, per `07-unplugin.md` §6.3)
- DevTools Kit integration path (register 1 dock entry + bundle the Vue 3 SPA sub-project `packages/unplugin/devtools-ui/` into `<unplugin>/dist/ui/`) + ship 4 panels + 1 secondary driven by mock data: Audio graph / Live state / Signals & performance / MIDI + Snapshot tab inside Audio graph (per `07-unplugin.md` §6.1)
- Mock data must be realistic, diverse, and integrated (per `AGENTS.md` "Mock data rule"). Audio chain mock: arpeggiator → polysynth → limiter → reverb → master → destination (4 unworklet nodes + 2 standard nodes); each unworklet node's publish slots are borrowed from canonical examples Ex 1–10, covering all types (scalar f32/i32/bool + buffer f32/i32/bool/u8); value changes simulate real chain causality (polysynth meter rising → limiter applying GR → reverb tail appearing)

HMR boundary (depends on `replaceProcessor`) and source maps (`.ts` → AST → `.wasm` position propagation, sidecar `.wasm.map`) are split out to Phase 12. **Real panel wiring** (AudioNode.prototype hook / UnworkletNode WeakSet / signal probe opt-in method / latency measurement / MIDI inject RPC / diagnostics push) is deferred to the phase where each dependency becomes available (Phase 7 messaging / Phase 9 MIDI / Phase 12 HMR + source maps), replacing mock composables with real ones in a single swap with no UI revisions.

Completion criteria: `?worklet` import works in a real Vite project; 4 metadata artifact JSONs are emitted; 1 dock entry appears in Vite DevTools; 4 panels + 1 secondary are visually confirmed with mock data (waveform / spectrogram / latency rolling chart / memory budget / virtual keyboard inject all animate).

### Phase 6 — AudioWorklet integration (real audio thread)

Worklet runtime template (`AudioWorkletProcessor` subclass, instantiating the WASM module on the audio thread and calling WASM from `process()`) + minimal main-thread `UnworkletNode<C>` surface (`createNode` / `node.node` raw / `dispose` / `node.params.<name>` / `node.inputs.<name>` / `node.outputs.<name>`). Additionally, wiring skeleton for `node.onError(handler)` to observe init failure / WASM trap / block-length-mismatch / queue-overflow / sab-unavailable / worklet-initialize-not-called (queue-overflow and sab-unavailable are wired when their respective transports come up in later phases; the remaining 3 codes are filled in Phase 6).

**Real DevTools panel wiring** (AudioNode.prototype hook / UnworkletNode WeakSet / signal probe opt-in method / latency measurement / memory streaming / diagnostics push / MIDI inject RPC) is carried over to the phases where messaging and MIDI surfaces are ready. Each sub-step is zipped to the relevant surface phase (Phase 7 messaging / Phase 9 MIDI / Phase 12 HMR + source maps) and swapped from mock to real data in one operation with no UI revisions (confirmed in plan).

Completion criteria:

- Canonical Ex 1 (meter-less) plays audio in the browser
- Smoke test passes in Vitest browser mode
- `vp check` + `vp test` pass across all packages
- 98% coverage gate maintained

### Phase 7 — Messaging

- `state.publish` (per-slot rate-gated copy + version counter + shared region, per `04-worklet-runtime.md` §7)
- Main-side `.state.<name>.subscribe()` / `.value`
- SAB Atomics path
- postMessage fallback (for environments where SAB is unavailable)
- `event<T>({ to: "main" })` (worklet → main ringbuffer, `emitIf` + `atSample`)
- `event<T>({ from: "main" })` (main → worklet, `onReceive` handler, block-boundary drain)

Completion criteria: canonical Ex 1 runs in full (meter included), meter streams to the UI in the browser at 30 fps, and the DevTools panel "Live state inspector" (named state slots + live values from `state.publish`, per `07-unplugin.md` §6.1) is functional.

### Phase 9 — MIDI

- `event.midi({ from: "main" })` / `event.midi({ to: "main" })` declarations (per `11-midi.md` §1)
- `.onEvent(type, handler)` on the worklet side (type-discriminated, per `11-midi.md` §2)
- Ringbuffer + `atSample` (same protocol as `02-messaging.md` §5.5)
- Main-side `.midi.<name>.send()` / `.onEvent()` / `.diagnostics.overflowCount()`
- `connectFromWebMIDI` (Web MIDI bridge, source-agnostic injection)
- Sysex (`state.buffer.u8` + variable-length content buffer, Q49)

Completion criteria: canonical Ex 5 (granular sampler, MIDI note in), Ex 6 (MIDI arpeggiator), Ex 8 (polyphonic synth), and Ex 9 (sysex bridge) are functional; the DevTools panel "MIDI flow / overflow" (`node.midi.<name>.diagnostics`, per `07-unplugin.md` §6.1) is functional.

### Phase 10 — SIMD subpath

The opt-in `@unworklet/core/simd` surface (`vec4` / `splat` / `addVec`–`divVec` / `sumLanes` / `lane` / `buffer.loadVec` / `storeVec` + method form `a.mul(b)` for f32x4 + `forSample.byN(4, ...)`) is implemented. The opt-in design that keeps scalar-only imports unaffected is also in place. Remaining work:

- `Node<'f32x4'>` method surface constraint: scalar methods other than `add` / `sub` / `mul` / `div` (i.e. `sin` / `cos` / `tan` / `tanh` / `exp` / `log` / `sqrt` / `abs` / `floor` / `ceil` / `frac` / `mod` / `neg` / comparisons / `min` / `max` / `clamp`) must be excluded from the `f32x4` tag via conditional method types (`T extends ScalarType ? … : never`) or overload splitting. Currently, the scalar method merge uses `T extends ScalarType | 'f32x4'`, exposing all scalar methods on f32x4 as well — meaning `splat(g).sin()` / `.clamp(...)` **type-check but throw at capture time** ("types pass but it doesn't work"). Only the documented vector ops (`.add` / `.sub` / `.mul` / `.div`, per `01-dsl.md` §7.2) should be exposed on the vector tag.

Completion criteria: canonical Ex 3 (linear-phase EQ partitioned convolution) runs on the SIMD path.

### Phase 11 — Snapshot / restore + migration

Snapshot/restore, the migration chain, and `replaceProcessor` are placed late in the sequence because their value — persisting state and migrating across versions — is only meaningful once the other phases (core DSL / messaging / MIDI / SIMD) are in place. Scope:

- Schema hash computation (structural AST hash derived from declarations)
- Blob format (version + schemaHash + slot records, Uint8Array)
- `snapshot()` / `restore()` API + block-atomic memcpy (per `05-client.md` §6.1)
- Migration chain executor + `MigrationHelpers` API (per `01-dsl.md` §8.3)
- Transient vs. persistent profile (per-slot snapshot flag, per `01-dsl.md` §3 + §8.2)
- `inspect(blob)` free function (Q48)
- `replaceProcessor` raw primitive (per `05-client.md` §8, Q50)

Completion criteria: the snapshot/restore + migration path works for canonical Ex 7 (convolution reverb with snapshot/restore migration) and Ex 10 (live coding REPL bridge, with the HMR boundary filled in Phase 12); the cumulative-swap warning surface from Q63 is in place (a single `console.warn` emitted on the 51st swap); the DevTools panel "Snapshot inspector" (`snapshot()` + `inspect(blob)` as a panel UI) and "Swap history" (`replaceProcessor` invocations + `ReplaceResult` log, per `07-unplugin.md` §6.1) are functional.

### Phase 12 — HMR boundary + source maps + remaining Vite plugin features

Phase 5 ships core functionality (`?worklet` resolution + metadata artifacts + DevTools panel visuals); real panel wiring is filled at the end of Phase 6. Once `replaceProcessor` raw primitive is in place after Phase 11, Phase 12 fills the HMR-dependent parts + source map propagation:

- HMR boundary (`replaceProcessor` callable from user-land; `?worklet` import marked as hot-acceptable, per `07-unplugin.md` §4)
- HMR recipe sketch (user-land orchestration path via `import.meta.hot.accept`, per `07-unplugin.md` §4)
- Cumulative swap warning surface (Q63: a single `console.warn` emitted on the 51st swap)
- Source maps (`.ts` → AST → `.wasm` position propagation, sidecar `.wasm.map`, per `07-unplugin.md` §5)

Completion criteria: in a real Vite project, editing a source file and accepting the update via `import.meta.hot.accept` allows `replaceProcessor` to be called from user-land; canonical Ex 10 (live coding REPL bridge) works end-to-end on the HMR path; the 51st swap triggers a console warning; source maps are readable in browser DevTools with source code linkage. The wav encoder for the Record sub-tab was shipped in Phase 5 as a self-contained 16-bit PCM encoder (ring buffer + hand-written RIFF/WAVE) — the MediaRecorder path is not adopted in any phase (per `AGENTS.md` "DevTools panel — recurring violations to avoid").

### Phase 13 — Alignment verification across remaining canonical examples

By the end of earlier phases: Ex 1 (meter-less) in Phase 3, Ex 1 (full) in Phase 7, Ex 5/6/8/9 in Phase 9, Ex 3 in Phase 10, Ex 7/10 (Ex 10 HMR path completed in Phase 12) in Phase 11. Phase 13 runs the remaining Ex 2 (3-band biquad EQ) and Ex 4 (lookahead limiter) end-to-end alongside all previously passing examples, verifying compatibility. Any example that fails triggers targeted repairs to the required primitives or surface areas.

Completion criteria: all of canonical Ex 1–10 produce bit-exact output against reference PCM under `renderOffline` and play audio correctly in the browser.

### Phase 14 — Acceptance criteria full verification + ship

All §1 items (A1–A3 / B1 / C1 / D1 / E1 / F1) receive a single, unambiguous pass/fail determination from the impl AI agent. Any item that fails blocks the release; all items passing clears v1.0.0 for ship.

Completion criteria: v1.0.0 release tag + npm publish; all 4 packages are consistent with the public dependency graph (per `09-repo-structure.md` §2.4).

## 3. Explicitly deferred

The following items are intentionally postponed past v1.0.0. Each has a forward-compatible API surface — consumer code does not change when the upgrade lands.

### 3.1 Mandatory mitigations (must ship in v1.x.0)

- **Double-buffered `buffer.publish` regions** — eliminates torn reads on multi-byte published regions and variable-length `event<T>` payloads (both directions). v1.0.0 ships single-buffered (acknowledged limitation in `decisions-log.md` Q27-f and `02-messaging.md` §5.4). v1.x.0 introduces 2× region per published slot with atomic index switch from the audio thread; main-side readers consume the most-recent-completed region. **Mandatory, not optional** — the v1.0.0 surface explicitly promises this upgrade.

### 3.2 Additive surface extensions (no v1.0.0 promise; rolled out as demand surfaces)

- **Standard MIDI File loader for `@unworklet/test`** — adds `loadSmf(path, opts)` / `parseSmf(bytes, opts)` to `@unworklet/test`, converting `.mid` files to `OfflineEvent[]` for passing to `renderOffline`. Intended for verifying synth / arp audio output against a known reference song or MIDI sequence. Whether to use a third-party SMF parser (e.g. `midi-file`) as an internal dependency or to hand-write the emitter is a separate decision deferred to adoption time. Excluded from the v1.0.0 scope; added additively when demand arises.

<!-- Other candidates (to be filled in as additional resolutions settle in decisions-log.md):
       - Variable-rate iteration (`forSampleRange(start, end, callback)`)
       - rAF-driven `state.publish` rate variants
       - SIMD f64x2 / i32x4 / shuffle / gather-scatter
       - Time-unit sub-rate primitives (`everyTimeMs`)
     -->
