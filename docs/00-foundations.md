# 00 — Foundations

Common ground every implementer reads before touching any component. Defines vocabulary, the type system, and the cross-cutting invariants that all components must honor.

## Status

partial (§§1–5 written; §6 cross-cutting still placeholder)

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

A function that takes `Node<T>` arguments (and possibly other compile-time constants) and returns a `Node<T>`. Examples: `add`, `mul`, `tanh`, `select`, `splat`. Primitives execute at *graph capture time* (build time), constructing AST nodes; they do not run per sample. Primitives appear both as free functions (`add(a, b)`) and as methods on handle types (`buf.loadVec(offset)`, `vec.lane(i)`); both shapes obey the same graph-capture-time semantics.

### Declaration scope

The body of `defineProcessor` and `defineSubgraph`, before the returned `process` lambda. The only place where new declarations are created: `state.*`, `buffer.*`, `param.*`, `audioInput`, `audioOutput`, `event<T>`, `message<T>`, `midiInput`, `midiOutput`, and subgraph instantiations via `createSubgraph(...)`. Each declaration registers a slot in the graph and a region in WASM linear memory.

### Expression scope

The body of `process` lambdas, `forSample` / `forSample.byN` callbacks, L1 helper bodies, subgraph method bodies, `messageDecl.onReceive(...)` handler bodies, and `midiInput().onEvent(...)` handler bodies. Per-sample and per-block expressions live here. New declarations are forbidden in expression scope.

### Process body

The function returned in the `process` field of `defineProcessor`'s and `defineSubgraph`'s return record. Runs once at build time as a meta-program; constructs an AST DAG that the framework emits as a per-block runtime program (per-block code + zero or more per-sample loops) in WebAssembly. The audio thread executes the WASM; user TypeScript is not re-entered per sample or per block. See `decisions-log.md` Q22 (Q22-a, Q22-aprime).

**Mental model — same as JUCE / AudioWorklet `process`.** The `process` body is read top-to-bottom: code at the top of the body runs first, then any subsequent statement runs in source order, until the end. There is no fixed phase boundary that the author has to put their code on either side of, no global ordering rule beyond source order, and no restriction on how many `forSample` loops the body contains. Authors write zero, one, or many `forSample` invocations; per-block computation freely interleaves with them; the same output sample can be written multiple times (last write wins per Q37); the same input sample can be read in per-block code and again inside a `forSample` callback. This is the **AudioWorkletProcessor.process / JUCE AudioProcessor::processBlock** mental model — `forSample` is just a loop primitive over the block, not a phase the framework reorders or constrains. The only structural rule is **declarations live in declaration scope** (= the top of the body, before the returned record): per-block / per-sample code shares the body, both run top-to-bottom, and the author orchestrates them as they see fit (Q37, Q22-aprime).

### Sample-offset (`i`)

A `Node<'i32'>` that, at WASM-emission time, binds to the loop counter of a `forSample` iteration. `i` is the callback parameter of `forSample(callback)` or `forSample.byN(stride, callback)`. The value spans `[0, SAMPLES_PER_BLOCK - 1]`. Outside any `forSample`, the `Node<'i32'>` `i` variable is not in scope — using it there is a standard TypeScript reference error. Sample-position primitives themselves (`audioIn.at(c, i)`, `param.at(i)`, `audioOut.set(c, i, v)`) accept `Node<'i32'> | number` (Q36-a), so they can still be called per-block with a JS literal sample-offset (e.g. `audioIn.at(0, 0)`, `audioOut.set(0, 0, v)`, `param.at(0)`) — only the loop-counter alias is forSample-scoped.

### Per-block code / per-sample code

The two kinds of code in a `process` body, distinguished by **lexical position**:

- **Per-block code** — statements at the top level of the `process` body (= outside any `forSample`). Run once at the start of every render quantum on the audio thread. Sample-position primitives accept JS-literal sample-offsets here (e.g. `param.at(0)` for block-start param value, `audioIn.at(0, 0)` for block-start input sample, `audioOut.set(0, 0, v)` for block-start output write) per Q36-a + Q51; the forSample-callback `Node<'i32'>` `i` alias is not available here, but the literal `0` (or any compile-time-constant offset) is. Otherwise per-block code uses `state.load/store`, buffer access, arithmetic, and SIMD primitives (for block-level bulk init).
- **Per-sample code** — statements inside a `forSample(callback)` (or `forSample.byN(stride, callback)`) invocation. The callback body runs once per sample (or once per `stride` samples) of the render quantum, with `i` bound to the loop counter.

A `process` body is read **top-to-bottom**; each statement (per-block direct code or `forSample` invocation) executes in declared (source) order. Per-block code can interleave freely with `forSample` invocations: per-block setup → per-sample work → more per-block code → another `forSample` → … — all valid.

There is no sugar form. Every per-sample access uses `at` / `set` / `param.at(...)` with explicit `i`.

See `decisions-log.md` Q22 (Q22-aprime, Q22-b).

### `forSample` / `forSample.byN`

The only sample-loop primitive (see `01-dsl.md` §10). `forSample(callback)` runs `callback` for each sample of the current render quantum (stride 1). `forSample.byN(stride, callback)` runs `callback` once per `stride` samples (typical use: `stride = 4` for SIMD bulk operations paired with `buf.loadVec` / `buf.storeVec`). The presence of a `forSample` invocation in a `process` body marks per-sample code; its absence at any given lexical position marks per-block code.

### `everyNSamples`

The sub-rate computation primitive (see `01-dsl.md` §9). `everyNSamples(N, callback)` evaluates `callback` once during graph capture; the framework emits the resulting AST as a sub-block that runs once every `N` samples (counter-modulo gating). State slots updated inside the callback hold their value (zero-order hold) on intermediate samples.

### Render quantum

The block size of an Audio Worklet's `process` invocation. The Web Audio specification fixes this at 128 samples and unworklet ships this value as the build-time constant `SAMPLES_PER_BLOCK` exported from the package top level (see `decisions-log.md` Q35 and `01-dsl.md` §1.7). User code refers to the block length by importing this constant rather than writing the literal `128`.

### Block

Synonym for "render quantum's worth of samples" — the unit of work for one Audio Worklet `process` callback invocation.

### `state` / `buffer` / `param`

Three declaration kinds for sample-offset-independent slots:

- **`state.<type>(initial, options?)`** — scalar slot. `load()` / `store(v)`. Persists across render quanta.
- **`buffer.<type>({ size, name, ... })`** — fixed-size array. `buf.read(idx)` / `buf.write(idx, v)` / `buf.readInterpolated(pos)` for scalar access; `buf.copyFrom(typedArrayField)` for bulk transfer from a `message<T>` / `event<T>` typed-array payload field (single `memory.copy` instruction; see `01-dsl.md` §3.2); `buf.loadVec(offset)` / `buf.storeVec(offset, value)` for SIMD bulk access (under `@unworklet/core/simd`). Lives in WASM linear memory.
- **`param({ default, min, max, automationRate, ... })`** — bound to a Web Audio `AudioParam`. Single access form: `param.at(i)` (inside `forSample`, per-sample value at offset `i`) / `param.at(0)` (per-block, block-start value). No callable `param()` form, no `param.value` / `param.now()` property.

See `01-dsl.md` §3.

### `AudioWorkletGlobalScope`

The global scope inside which an `AudioWorkletProcessor` instance executes. Hosts the WASM module, the marshalling glue, and the message / event queue endpoints.

### Emission boundary

The compile-time / runtime boundary that defines what unworklet normalizes and what stays under consumer control. Everything **inside the boundary** is fixed by unworklet at build time and is identical across runtime environments: the emitted WASM binary (render-quantum size, channel count, `parameters[name]` array marshalling, subnormal flush) and the messaging glue (SAB / `postMessage` transport selection, MIDI ringbuffer policy). Everything **outside the boundary** is raw web platform under consumer control: `AudioContext` lifecycle and `sampleRate`, Web MIDI device permission / hotplug / port enumeration, COOP/COEP HTTP header configuration. unworklet exposes typed APIs (`createNode`, `node.midi.<name>.connectFromWebMIDI`, `node.onError`) to support consumer-driven boundary crossings, but it does not own the outside-the-boundary surface.

The full quirk catalog (A1–A7 inside, B1–B3 outside) and rationale live in `decisions-log.md` Q11. The compatibility matrix lives in `08-deployment.md` §2.

## 4. Type system

unworklet primitives are statically typed `Node<T>` where `T` is one of `'f32'`, `'f64'`, `'i32'`, `'i64'`, `'bool'`.

### Literal lift (context-dependent inside primitive and method arguments)

A JavaScript `number` or `boolean` literal appearing as a **primitive argument** lifts to `Node<T>`, where `T` is inferred from the surrounding primitive signature (context-dependent lift):

```typescript
mul(meterL.load(), 0.95)           // meterL: Node<'f32'> → 0.95 lifts to Node<'f32'>
mod(add(head, i), HISTORY_LEN)     // head: Node<'i32'> → HISTORY_LEN lifts to Node<'i32'>
select(isMe, true, gate.load())    // gate: Node<'bool'> → true lifts to Node<'bool'>
```

When all primitive arguments are literals (e.g. `add(0, 0)`), TypeScript falls back to **`'f32'`** as the default — audio-rate DSP overwhelmingly uses `f32` and AudioWorklet I/O (`inputs`, `outputs`, `parameters[name]`) is `Float32Array`-typed end-to-end.

**method arguments follow the same rule** (Q36 拡 張): if a method's declared argument type is `Node<X>`, a JS literal passed in that position lifts to `Node<X>`. This covers `param.at(0)`, `samples.at(s)`, `emitIf(true, ...)`, `audioIn.at(0, i)`, `buf.read(idx)`, etc. — all canonical method-argument literal usages.

```typescript
lowF.at(0)                         // param.at(i: Node<'i32'> | number) → 0 lifts to Node<'i32'>
notePlayed.emitIf(true, payload)   // emitIf(cond: Node<'bool'> | boolean, ...) → true lifts to Node<'bool'>
samples.at(s)                      // s = JS number → build-time folded read
samples.at(idx)                    // idx = Node<'i32'> → runtime read
```

Implicit lift covers `'f32'` / `'f64'` / `'i32'` / `'bool'`. **`'i64'` requires explicit construction** (see "Scalar constructors" below) because JavaScript `number` cannot safely represent integers beyond `2^53 - 1`.

Range constraints that the type system cannot express (channel index must be a non-negative integer, `buf.read` index must be non-negative, etc.) are enforced at graph-capture time and produce build-time errors with refactor hints (authoritative: `decisions-log.md` Q36-a).

### Scalar constructors (explicit lift outside primitive arguments)

Five scalar constructors lift JS values to `Node<T>` explicitly. They are required wherever the implicit lift does not apply — variable declarations, ambiguous-call disambiguation, i64 construction, and cross-precision conversion:

```typescript
f32(v: number): Node<'f32'>;
f64(v: number): Node<'f64'>;
i32(v: number): Node<'i32'>;
i64(v: bigint): Node<'i64'>;
bool(v: boolean): Node<'bool'>;
```

```typescript
let count = i32(0);                          // declaration: explicit constructor required
let lSum  = f32(0);                          // declaration: explicit constructor required
add(i32(0), i32(0))                          // all-literal call: i32 constructor pins T = 'i32'
add(state.i64.load(), i64(BigInt(123)))      // i64: BigInt-required, no implicit lift

const acc    = state.f64(0);                 // explicit f64 state declaration
const wide   = f64(f32node);                 // explicit widen  f32 → f64
const narrow = f32(f64node);                 // explicit narrow f64 → f32
const idx    = i32(f32node);                 // explicit truncate f32 → i32
```

The constructor convention mirrors GLSL (`vec3(0.0)` / `float(0)`) and WGSL (`f32(0)`) — author mental from audio / graphics DSL transfers directly.

### No implicit widening between Node types

Operations whose operands disagree on precision are a compile-time type error:

```typescript
add(f32node, f64node);          // ❌ Type error: precision mismatch
add(f32node, f32(f64node));     // ✓ Explicit narrow at the boundary
add(f64(f32node), f64node);     // ✓ Explicit widen at the boundary
```

The constraint is enforced both by the TypeScript types of the primitive operators (see `01-dsl.md` §2) and by the static-analysis pass during compilation (see `03-compiler.md` §3).

### Integer and boolean conversions

`i32(node)`, `i64(node)`, `bool(node)` and the comparison primitives (`eq`, `lt`, `gt`, …) returning `Node<'bool'>` follow the explicit-only rule for **type narrowing / widening between `Node` types**. There is no implicit numeric ↔ boolean coercion; control flow over a `Node<'bool'>` must use `select`, never a JavaScript `if`.

Rationale and rejected alternatives: see `decisions-log.md` Q1 + Q33.

### Vector types (opt-in SIMD)

In addition to the scalar precision tags, unworklet exposes vector type tags — `'f32x4'` (in v1.0.0), with `'f64x2'`, `'i32x4'`, and others rolling out additively across v1.x.0 — for SIMD-width values backed by WASM v128. These appear only when the user opts into the SIMD subset by importing from `@unworklet/core/simd`; scalar-only code never references them.

The "no implicit widening" rule extends to vec ↔ scalar: a `Node<'f32'>` and a `Node<'f32x4'>` cannot be combined directly. Conversion is explicit (`splat(scalarNode)` to broadcast, `vecNode.lane(i)` to extract).

Authoritative SIMD surface: `01-dsl.md` §7. Rationale and rejected alternatives: see `decisions-log.md` Q3.

## 5. Realtime-safety invariants

These are the hard rules every audio-thread code path honors. They are non-negotiable: components or features that appear to require violating them surface the conflict — they do not work around it. Each invariant is enforced at the earliest layer where it can be detected; runtime guards exist only as last-resort safety nets (`03-compiler.md` §2.4 layered error model).

### 5.1 The invariants

1. **No heap allocation on the audio thread.** All `state`, `buffer`, `param`, message / event payload regions, and MIDI ringbuffer regions are pre-allocated at processor instantiation. WASM linear memory is sized at compile time from the auto-summed declarations (Q30); `memory.grow` is never emitted into the worklet's WASM. JavaScript-side allocation expressions (`new Uint8Array(...)`, object/array literals as audio-rate values) never appear on the audio thread because user TypeScript is not re-entered per sample — the `process` body is a build-time meta-program (see §3 "Process body").

2. **No unbounded loops on the audio thread.** Every loop emitted into WASM has a build-time-known upper bound: `forSample` and `forSample.byN` iterate exactly `SAMPLES_PER_BLOCK` / `SAMPLES_PER_BLOCK / stride` times; `everyNSamples` is gated by a counter-modulo with a build-time-constant divisor; build-time `for` loops in the meta-program are unrolled at graph capture. Runtime-bounded iteration (`forSamplesUntil`, runtime-variable stride, payload-length-driven loops in `onReceive`) is not part of the surface; bulk transfer uses `buf.copyFrom(payloadField)`, which lowers to a single `memory.copy` WASM instruction (Q31).

3. **No throw on the audio thread.** The audio thread never raises an exception. User-authored `throw` cannot reach the WASM module because the user's TypeScript runs only at build time during graph capture. Framework paths that could otherwise propagate exceptions to audio code degrade to non-throwing fallback: `migrate` throws are caught on construction and surfaced via the main-side `restore(blob)` discriminated-union result (Q45); MIDI ringbuffer overflow is drop-and-report through the main-side diagnostics surface, never a throw (Q4-c); WASM traps emit silence and signal main via the error path rather than propagating (`04-worklet-runtime.md` §8).

4. **No blocking I/O on the audio thread.** The audio thread never waits on a main-thread response, the file system, the network, or any synchronous boundary. State publish writes use `Atomics.store` into a pre-allocated SAB region; in the SAB-unavailable fallback, the audio thread enqueues at the render-quantum boundary into a pre-allocated `postMessage` buffer. Both paths are non-blocking and constant-time per published slot (`04-worklet-runtime.md` §7). `console.*`, `fetch`, file APIs, and synchronous main-thread RPC are not exposed by any audio-thread primitive.

5. **No GC-triggering operations on the audio thread.** WASM execution is GC-free by construction. The user's TypeScript closure executes only at build time during graph capture; once the WASM module is instantiated, no JavaScript runs per sample or per block. Marshalling at the WASM ↔ JS boundary (channel buffers in/out, param arrays in) uses pre-allocated typed-array views — no per-quantum object allocation in the worklet's `process` shim.

### 5.2 Where each invariant is enforced

The four enforcement layers, ordered earliest-first (per `03-compiler.md` §2.4):

- **L1 — TypeScript type error** (IDE level, before any build, no framework runtime involved).
- **L2 — Graph-capture-time error** (build-time, during proxy evaluation of the `defineProcessor` body).
- **L3 — Static-analysis error** (build-time, post-capture pass over the DAG).
- **Emission** — the violating pattern is structurally not emittable; the WASM module that ships cannot express it.
- **Runtime guard** — last-resort runtime check, falling back to silence + a main-side error event (never to a throw on the audio thread).

| Invariant | Enforcement layer(s) | Authoritative section(s) |
|-----------|---------------------|--------------------------|
| No heap alloc | L2 (declaration-scope check rejects `state.*` / `buffer.*` / `audioInput` / `defineSubgraph` / `createSubgraph` outside declaration scope) · L3 (allocation check; memory-budget sum; runtime `memory.grow` permanently excluded) · Emission (linear memory pre-sized; no allocation primitive in the audio-thread surface) | `03-compiler.md` §2.2 + §2.4 (Layer 2 scope violations, Layer 3 allocation check + memory budget); `01-dsl.md` §3 (`state` / `buffer` / `param` shape); `04-worklet-runtime.md` §1 (startup pre-allocates queues); `decisions-log.md` Q30 |
| No unbounded loops | L2 (`forSample.byN` non-constant-stride rejected) · L3 (loop-boundedness check across `forSample` / `everyNSamples` / subgraph methods / `onReceive` / `midiInput().onEvent` handler bodies) · Emission (no `forSamplesUntil`, no runtime-stride loop primitive in the surface; bulk transfer uses `copyFrom` → single `memory.copy`) | `03-compiler.md` §2.4 (Layer 3 loop-boundedness, illegal stride); `01-dsl.md` §3 (bulk copy) + §10 (`forSample`); `decisions-log.md` Q29, Q31 |
| No throw on audio thread | Emission (user TS runs at build time only; `throw` in process / handler / forSample body throws at graph-capture, never at audio time) · Runtime guard (migration catch on construction, MIDI overflow drop-and-report, WASM trap → silence + main-side error event) | `01-dsl.md` §8.3.3 + `decisions-log.md` Q45 (migration catch); `11-midi.md` §4 + `decisions-log.md` Q4-c (overflow drop-and-report); `04-worklet-runtime.md` §8 (trap handling) |
| No blocking I/O | Emission (no `postMessage` / `fetch` / `console` / sync-RPC primitive in the audio-thread surface) · Runtime contract (publish path: `Atomics.store` into SAB, or pre-allocated `postMessage` buffer enqueue at quantum boundary — both non-blocking, constant-time per slot) | `04-worklet-runtime.md` §7 (publish scheduling); `02-messaging.md` (SAB Atomics vs postMessage fallback); `decisions-log.md` Q27 |
| No GC | Emission (WASM is GC-free; user TS never re-entered per sample / per block) · Runtime contract (per-block boundary marshalling uses pre-allocated typed-array views) | §3 "Process body" (build-time meta-program); `04-worklet-runtime.md` §2 (per-block execution); `decisions-log.md` Q22 (Q22-a, Q22-aprime) |

### 5.3 Earliest detection is cheapest detection

Audio-thread errors cannot be recovered safely — a `throw` or a stall on the audio thread is an audible glitch, not a debugger pause. The layered model exists so that every realtime-safety violation is rejected at the highest layer that can see it: type errors in the IDE, scope and shape violations during graph capture, structural violations during static analysis, and only as a last resort, runtime guards that degrade to silence rather than propagate. Runtime guards exist to defend the invariant when an unmodeled boundary changes underneath the compiled artifact (the render-quantum size assertion in `04-worklet-runtime.md` §3 is the canonical example) — not to catch user mistakes that the build pipeline should have caught.

This layering is what makes "realtime-safe by construction" (§2 Goals) more than a slogan: the WASM module that ships is the *only* code that runs on the audio thread, and every property that matters about it is fixed before instantiation.

## 6. Cross-cutting conventions

<!-- Module layout, package naming, import paths, file structure conventions referenced from every component doc. Settled in 09-repo-structure.md; cross-referenced here for the lookup. -->
