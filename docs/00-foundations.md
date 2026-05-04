# 00 — Foundations

Common ground every implementer reads before touching any component. Defines vocabulary, the type system, and the cross-cutting invariants that all components must honor.

## Status

skeleton

## 1. What is being built

`unworklet` is a TypeScript-first framework for authoring realtime audio DSP that runs inside any spec-compliant `AudioWorkletGlobalScope`. The user declares a processor; the framework produces the WebAssembly binary, the `AudioWorkletProcessor` glue, and a typed main-thread client.

The framework is **runtime-agnostic.** `AudioWorkletGlobalScope` originated in the Web Audio API for browsers, but the same surface is available wherever a host implements the spec — for example, the sibling project `unaudio` ships a Chromium-derived runtime that lets unworklet processors run inside VST hosts. unworklet itself contains no host-specific code: it produces processors that any spec-compliant Audio Worklet host can run.

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
- **Not a host-format adapter.** VST/AU/CLAP packaging, plugin-metadata schemas, latency compensation reporting, preset banks, and similar host-format concerns belong to a separate layer (e.g. `unaudio` for the VST case). unworklet does not produce host-specific binaries or expose host-shaped APIs.
- **Not a music-making framework.** Sequencers, pattern editors, scale-theory libraries, and song-structure abstractions are application-level. unworklet *receives* MIDI events at the audio thread; it does not provide tools to *generate* or compose them.
- **Not a replacement for hand-written WASM.** Users with extreme optimization needs should write WASM directly; unworklet targets the 90% case.
- **Not a Faust replacement.** Faust's mathematical-DSP abstraction level is intentionally out of scope.

## 3. Vocabulary

<!-- Authoritative definitions of terms used across all component docs:
     Processor, Node<T>, primitive, state, buffer, param, message, event,
     `process` phase, `publish` phase, block, render quantum, AudioWorkletGlobalScope. -->

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

## 5. Realtime-safety invariants

<!-- The hard rules every component honors:
     - no heap allocation on the audio thread,
     - no unbounded loops,
     - no I/O / postMessage on the audio thread,
     - no GC-triggering operations.
     These are non-negotiable. Components that appear to require violating them must surface the conflict, not work around it. -->

## 6. Cross-cutting conventions

<!-- Module layout, package naming, import paths, file structure conventions referenced from every component doc. Settled in 09-repo-structure.md; cross-referenced here for the lookup. -->
