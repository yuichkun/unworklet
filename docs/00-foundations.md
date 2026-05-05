# 00 — Foundations

Common ground every implementer reads before touching any component. Defines vocabulary, the type system, and the cross-cutting invariants that all components must honor.

## Status

skeleton

## 1. What is being built

`unworklet` is a TypeScript-first framework for authoring realtime audio DSP that runs inside any spec-compliant `AudioWorkletGlobalScope`. The user declares a processor; the framework produces the WebAssembly binary, the `AudioWorkletProcessor` glue, and a typed main-thread client.

The framework is **runtime-agnostic.** unworklet targets the Web Audio API as specified for browsers and is published as an ordinary npm library. Because it produces only standards-compliant Audio Worklet artifacts and contains no host-specific code, the resulting processors will run on any host that implements the spec — but anything beyond producing those standards-compliant artifacts is outside unworklet's scope.

## 2. Goals and non-goals

### Goals

- **Realtime-safe by construction.** All compiled `process` paths are statically guaranteed allocation-free, with no GC pressure and no unbounded loops on the audio thread.
- **TypeScript-native.** The full TS type system applies to user code; IDE tooling, refactoring, and type inference work without compromise.
- **Runtime-agnostic.** Produces standards-only Audio Worklet artifacts that run in any spec-compliant host. No browser-only APIs, no host-specific code paths in the core.
- **Testable without a browser.** A pure-JS backend lets every processor render under Vitest in Node.
- **Typed bidirectional messaging,** including sample-accurate MIDI-event ingestion at the processor boundary (see `11-midi.md`).
- **Deterministic memory footprint.** All state and buffers bounded at compile time.

### Non-goals

- **Not a DSP standard library.** unworklet provides primitives (`add`, `mul`, `sin`, `select`, …); high-level building blocks (filters, oscillators, envelopes, FFT helpers, …) are intentionally left to third-party packages. unworklet's job is to make those packages easy to author and consume.
- **Not a host-format adapter.** VST/AU/CLAP packaging, plugin-metadata schemas, latency compensation reporting, preset banks, and similar host-format concerns are out of scope. unworklet produces only standards-compliant Audio Worklet artifacts and does not expose host-shaped APIs.
- **Not a music-making framework.** Sequencers, pattern editors, scale-theory libraries, and song-structure abstractions are application-level. unworklet *receives* MIDI events at the audio thread; it does not provide tools to *generate* or compose them.
- **Not a replacement for hand-written WASM.** Users with extreme optimization needs should write WASM directly; unworklet targets the 90% case.
- **Not a Faust replacement.** Faust's mathematical-DSP abstraction level is intentionally out of scope.

## 3. Vocabulary

Authoritative definitions of terms used across all component docs.

### Processor

A unit declared by `defineProcessor((ctx) => { ... })` and compiled to a single AudioWorkletProcessor. Each instantiation has its own state and parameter values.

### Subgraph

A reusable, stateful DSP block declared by `defineSubgraph((args) => { ... })`. Instantiated zero or more times inside a parent `defineProcessor` or another `defineSubgraph`. See `01-dsl.md` §5.6.

### `Node<T>`

A handle to a value computed during per-sample iteration. `T` is one of `'f32'`, `'f64'`, `'i32'`, `'i64'`, `'bool'` for scalars; `'f32x4'` and (post-v1.0.0) other vector tags for SIMD. `Node<T>` is a branded type — JavaScript operators (`+`, `*`, `===`, `if (...)`, etc.) are TypeScript type errors against `Node<T>` operands, directing authors to unworklet primitives (`add`, `mul`, `eq`, `select`).

### Primitive

A function that takes `Node<T>` arguments (and possibly other compile-time constants) and returns a `Node<T>`. Examples: `add`, `mul`, `tanh`, `select`, `loadVec`. Primitives execute at *graph capture time* (build time), constructing AST nodes; they do not run per sample.

### Declaration scope

The body of `defineProcessor` and `defineSubgraph`, before the returned `process` lambda. The only place where new `state.*`, `buffer.*`, `param.*`, `audioInput`, `audioOutput`, and `defineSubgraph` instantiations are created. Each declaration registers a slot in the graph and a region in WASM linear memory.

### Expression scope

The body of `process` lambdas, `forSample` callbacks, L1 helper bodies, `defineSubgraph` `process` lambdas, and `everyNSamples` callbacks. Per-sample expressions live here. New declarations are forbidden in expression scope.

### Process body

The function returned in the `process` field of `defineProcessor`'s and `defineSubgraph`'s return record. Runs once at build time as a meta-program; constructs an AST DAG that the framework emits as a per-block runtime program (per-block phase + zero or more per-sample phases) in WebAssembly. The audio thread executes the WASM; user TypeScript is not re-entered per sample or per block. See `decisions-log.md` Q22 (Q22-a, Q22-aprime).

### Sample-offset (`i`)

A `Node<'i32'>` that, at WASM-emission time, binds to the loop counter of a `forSample` iteration. `i` is the callback parameter of `forSample(callback)` or `forSample.byN(stride, callback)`. The value spans `[0, renderQuantum - 1]`. Outside any `forSample`, no `i` variable is in scope — sample-position primitives (`audioIn.at(c, i)`, `param.at(i)`, `audioOut.set(c, i, v)`) cannot be called there, enforced by standard TypeScript scoping. There is no sugar form that hides `i`.

### Per-block phase / per-sample phase

The two execution phases of a `process` body, distinguished by **lexical position**:

- **Per-block phase** — statements at the top level of the `process` body (= outside any `forSample`). Run once at the start of every render quantum on the audio thread. Sample-position primitives (`audioIn.at`, `audioOut.set`, `param.at(i)`) cannot appear here because `i` is not in scope; the per-block phase uses `state.load/store`, buffer access, `param.at(0)` (for block-start param values), arithmetic, and SIMD primitives (for block-level bulk init).
- **Per-sample phase** — statements inside a `forSample(callback)` (or `forSample.byN(stride, callback)`) invocation. The callback body runs once per sample (or once per `stride` samples) of the render quantum, with `i` bound to the loop counter.

A `process` body is read **top-to-bottom**; each statement (per-block direct code or `forSample` invocation) executes in declared (source) order. Per-block code can interleave freely with `forSample` invocations: per-block setup → per-sample work → more per-block code → another `forSample` → … — all valid.

There is no sugar form. Every per-sample access uses `at` / `set` / `param.at(...)` with explicit `i`.

See `decisions-log.md` Q22 (Q22-aprime, Q22-b).

### `forSample` / `forSample.byN`

The only sample-loop primitive (see `01-dsl.md` §10). `forSample(callback)` runs `callback` for each sample of the current render quantum (stride 1). `forSample.byN(stride, callback)` runs `callback` once per `stride` samples (typical use: `stride = 4` for SIMD bulk operations paired with `loadVec` / `storeVec`). The presence of a `forSample` invocation in a `process` body marks the per-sample phase; its absence at any given lexical position marks the per-block phase.

### `everyNSamples`

The sub-rate computation primitive (see `01-dsl.md` §9). `everyNSamples(N, callback)` evaluates `callback` once during graph capture; the framework emits the resulting AST as a sub-block that runs once every `N` samples (counter-modulo gating). State slots updated inside the callback hold their value (zero-order hold) on intermediate samples.

### Render quantum

The block size of an Audio Worklet's `process` invocation. The current Web Audio specification fixes this at 128 samples; future spec revisions may change it. unworklet treats render quantum as a runtime constant, not a compile-time-baked literal — see `04-worklet-runtime.md` §3.

### Block

Synonym for "render quantum's worth of samples" — the unit of work for one Audio Worklet `process` callback invocation.

### `state` / `buffer` / `param`

Three declaration kinds for sample-position-independent slots:

- **`state.<type>(initial, options?)`** — scalar slot. `load()` / `store(v)`. Persists across render quanta.
- **`buffer.<type>({ size, name, ... })`** — fixed-size array. `readBuffer(buf, idx)` / `writeBuffer(buf, idx, v)` / `readBufferInterpolated(buf, pos)`. Lives in WASM linear memory.
- **`param({ default, min, max, automationRate, ... })`** — bound to a Web Audio `AudioParam`. Sugar form: `param()` (callable). Explicit form: `param.at(i)`.

See `01-dsl.md` §3.

### `process` phase / `publish` phase

Two execution phases of a processor:

- **`process`** — runs every render quantum on the audio thread. Mapped to the compiled WASM. Hard realtime constraints apply (no allocation, no unbounded loops, no I/O).
- **`publish`** — runs on a separate scheduler. Reads state, emits events. Compiled to plain JavaScript; not realtime-critical.

See `01-dsl.md` §6.

### `AudioWorkletGlobalScope`

The global scope inside which an `AudioWorkletProcessor` instance executes. Hosts the WASM module, the marshalling glue, and the message / event queue endpoints.

## 4. Type system

unworklet primitives are statically typed `Node<T>` where `T` is one of `'f32'`, `'f64'`, `'i32'`, `'i64'`, `'bool'`.

### Numeric literal default

A JavaScript number literal (e.g. `0.4`, `1`, `42`) appearing where a `Node<T>` is expected lifts to `Node<'f32'>`. Audio-rate DSP overwhelmingly uses `f32`, and AudioWorklet I/O (`inputs`, `outputs`, `parameters[name]`) is `Float32Array`-typed end-to-end — so defaulting to `f32` keeps user-side DSP aligned with the underlying buffer types and avoids per-sample boundary conversions.

### Explicit precision

Non-default precision is always declared explicitly:

```typescript
const acc    = state.f64(0);   // explicit f64 state
const x      = f64(0.5);       // explicit f64 literal
const wide   = f64(f32node);   // explicit widen  f32 → f64
const narrow = f32(f64node);   // explicit narrow f64 → f32
```

### No implicit widening

Operations whose operands disagree on precision are a compile-time type error:

```typescript
add(f32node, f64node);          // ❌ Type error: precision mismatch
add(f32node, f32(f64node));     // ✓ Explicit narrow at the boundary
add(f64(f32node), f64node);     // ✓ Explicit widen at the boundary
```

The constraint is enforced both by the TypeScript types of the primitive operators in `@unworklet/dsp` (see `01-dsl.md` §2) and by the static-analysis pass during compilation (see `03-compiler.md` §3).

### Integer and boolean conversions

`i32(node)`, `i64(node)`, and the comparison primitives (`eq`, `lt`, `gt`, …) returning `Node<'bool'>` follow the same explicit-only rule. There is no implicit numeric ↔ boolean coercion; control flow over a `Node<'bool'>` must use `select`, never a JavaScript `if`.

Rationale and rejected alternatives: see `decisions-log.md` Q1.

### Vector types (opt-in SIMD)

In addition to the scalar precision tags, unworklet exposes vector type tags — `'f32x4'` (in v1.0.0), with `'f64x2'`, `'i32x4'`, and others rolling out additively across v1.x.0 — for SIMD-width values backed by WASM v128. These appear only when the user opts into the SIMD subset by importing from `@unworklet/core/simd`; scalar-only code never references them.

The "no implicit widening" rule extends to vec ↔ scalar: a `Node<'f32'>` and a `Node<'f32x4'>` cannot be combined directly. Conversion is explicit (`splat(scalarNode)` to broadcast, `lane(vecNode, i)` to extract).

Authoritative SIMD surface: `01-dsl.md` §7. Rationale and rejected alternatives: see `decisions-log.md` Q3.

## 5. Realtime-safety invariants

<!-- The hard rules every component honors:
     - no heap allocation on the audio thread,
     - no unbounded loops,
     - no I/O / postMessage on the audio thread,
     - no GC-triggering operations.
     These are non-negotiable. Components that appear to require violating them must surface the conflict, not work around it. -->

## 6. Cross-cutting conventions

<!-- Module layout, package naming, import paths, file structure conventions referenced from every component doc. Settled in 09-repo-structure.md; cross-referenced here for the lookup. -->
