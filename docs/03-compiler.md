# 03 — Compiler

The build-time pipeline that turns a `defineProcessor` definition into the artifacts consumed by the worklet runtime, the main-thread client, and the test backend. This is an internal module of `@unworklet/core` — the user invokes it implicitly through `@unworklet/vite-plugin`; there is no direct `import` surface.

## Status

partial (§1 pipeline overview + §2 graph capture + §2.4 three-layer error written; §3–§8 placeholder per Q61)

## 1. Pipeline overview

The compiler runs 5 stages end-to-end for each `defineProcessor`:

1. **Graph capture** (§2) — evaluate the body once at build time with proxy primitives, producing an AST DAG of `Node<T>` operations + declarations.
2. **Static analysis** (§3) — walk the DAG to verify realtime-safety invariants (allocation check, loop boundedness, memory budget per Q30, type consistency); errors flow through the Layer 1-3 enforcement model (§2.4) with the stable error ID inventory (§2.6).
3. **WASM emission** (§4) — emit the WASM binary with the `process(...)` entry point, the pre-sized linear memory layout, and inlined polynomial-approximation math primitives per Q17 (no `memory.grow`, no FFI per-sample crossings).
4. **Worklet JS codegen** (§5) — emit the `AudioWorkletProcessor` subclass that wraps the WASM and marshals per-block I/O (see `04-worklet-runtime.md`).
5. **Client TS codegen** (§6) — emit the typed `.d.ts` for `UnworkletNode<C>`, plus build-time metadata artifacts emitted by `@unworklet/vite-plugin`: `dist/<processor>.graph.json` (= AST DAG view), `.memory.json` (= per-declaration byte counts), `.diagnostics.json` (= 3-layer error / warning list with stable IDs), `.schema-hash.json` (= snapshot migration anchor). See `07-vite-plugin.md` §6.3 for the artifact contract.

Source maps thread `.ts` → AST → `.wasm` positions across all 5 stages and are emitted as a sidecar `.wasm.map` by `@unworklet/vite-plugin` (§7 + Q23+Q24+Q25). Per-section detail of stages §3 / §4 / §5 / §6 / §7 / §8 is impl-phase fill per Q61.

## 2. Graph capture phase

The compiler obtains the user's processor as an AST DAG by invoking the `defineProcessor` body once at build time, with proxy objects standing in for `Node<T>` values, declaration handles, and built-in primitives.

### 2.1 Build-time evaluation

The `defineProcessor` body is ordinary JavaScript / TypeScript code, executed once. The framework supplies:

- a `ctx` proxy exposing the compile-time `sampleRate` constant (= host AudioContext's sample rate, fixed for the processor's lifetime; canonical examples use `ctx.sampleRate` for build-time coefficient precomputation). Declaration helpers (`audioInput`, `audioOutput`, `state`, `buffer`, `param`, `defineSubgraph`, `createSubgraph`, `migrations`) are imported directly from `@unworklet/core` — they are not `ctx` members.
- proxy implementations of all primitives exported from `@unworklet/core` (and `@unworklet/core/simd` if imported) that, when called with `Node<T>` arguments, return new `Node<T>` instances representing AST nodes rather than computing values;
- a `forSample` proxy that, when called, accepts a callback, executes it once with a fresh `Node<'i32'>` proxy bound as `i`, and records the resulting AST as a per-sample loop body.

Build-time JavaScript continues to behave like ordinary JavaScript: literals, `Math.*`, build-time `if` / `for`, build-time arithmetic on `number` values are all evaluated normally. The proxies only intercept operations on `Node<T>` (and other framework-managed values). This is the boundary that lets users write loop unrolling, debug-flag pruning, and constant precomputation without framework involvement — see `decisions-log.md` Q22 (Q22-a).

### 2.2 Phase walk

The body executes top-to-bottom; the framework recognises four phase boundaries:

1. **Declaration scope** — the top of the `defineProcessor` body, before `return { process: ... }`. New `state.*`, `buffer.*`, `param.*`, `audioInput`, `audioOutput`, `event<T>`, `message<T>`, `midiInput`, `midiOutput`, and `createSubgraph(...)` instantiations are recorded as graph slots. (`defineSubgraph` itself is the module-level subgraph constructor — it produces a subgraph value at module scope; only `createSubgraph(subgraph, ...args)` calls inside the processor body create per-processor instances.) Each declaration registers a `name` (when supplied) for later snapshot identity (see `01-dsl.md` §8).

2. **Process body (top level)** — the framework calls the returned `process` lambda. Statements at the top level of the body emit code that runs once at the start of every render quantum. `forSample(...)` invocations within the body capture a per-sample sub-loop in the AST. Source order is preserved at the AST and at runtime — top-level statements and `forSample` invocations execute in declared order within the render quantum, with no separate phase-segmentation step (see `00-foundations.md` §3 "Process body" for the JUCE / AudioWorklet mental model).

3. **`forSample` callback (per-sample sub-loop)** — the callback is invoked once during graph capture with a `Node<'i32'>` proxy bound as `i`. Primitive calls inside the callback construct AST nodes. The resulting AST is the per-sample loop body for that sub-loop. `forSample.byN(stride, callback)` is identical except that the recorded AST is tagged with the stride for emission as a `stride`-step loop.

4. **Sub-rate callback (`everyNSamples`)** — invoked from inside a `forSample` callback. Recorded as a sub-block tagged with the divisor `N` for sub-rate emission (see `01-dsl.md` §9).

### 2.3 What the proxy captures

For each primitive call:

- **Arithmetic / math / control / type conversion**: a typed AST node with the operator and operand handles, returning a fresh `Node<T>` of the inferred output type.
- **`load` / `store`**: a memory-access AST node referencing the corresponding slot.
- **Buffer access (`buf.read` / `buf.write` / `buf.readInterpolated`)**: an indexed access AST node; the index argument is itself a `Node<'i32'>` (typically a ring-buffer write head).
- **Audio I/O (`audioIn.at(c, i)` / `audioOut.set(c, i, v)`)**: a sample-offset-aware AST node carrying the channel index, the sample-offset `i`, and (for `set`) the value to write. The sample-offset is `Node<'i32'> | number`: the `Node<'i32'>` form binds the surrounding `forSample` callback's loop counter, and JS-literal offsets (Q36-a) accept the primitive at any lexical position — at the per-block top level this uses literal `0` for block-start access (Q51).
- **Param access (`param.at(i)` / `param.at(0)`)**: an AST node carrying the param slot reference and the sample-offset. `param.at(i)` is used inside `forSample` callbacks; `param.at(0)` at the per-block top level reads the block-start value.
- **`select(cond, whenTrue, whenFalse)`**: a control-flow AST node; both branches are evaluated as graph nodes (no JS control flow over `Node<'bool'>`).
- **L1 helper calls**: inlined at the call site; the helper body executes with the same proxies, contributing AST nodes to the parent graph.
- **L2 subgraph instantiations**: recorded as a state-bearing inline expansion; each instantiation gets its own state slots, but the per-sample work is inlined into the parent's WASM module (no per-instance function-call boundary at audio rate).

### 2.4 Three error layers

Errors detected during graph capture and the surrounding compilation pipeline fall into three layers, ordered by detection time. Earlier detection is preferred — see `decisions-log.md` Q22 (Q22-c).

#### Layer 1 — TypeScript type error (IDE level, before any build)

The branded `Node<T>` type rejects JavaScript operators. The IDE surfaces these as type errors immediately, with no framework runtime involved:

- `nodeA + nodeB` — TS error: `+` is not applicable to operands of type `Node<'f32'>`.
- `if (nodeBool) { ... }` — TS error: `Node<'bool'>` is not assignable to `boolean`.
- `for (... ; nodeCmp ; ...)` — TS error: same as above, on the loop condition.
- `audioIn.at(0, i)` outside any `forSample` — TS error: `i` is undefined (standard TS scoping).

#### Layer 2 — Graph-capture-time error (build-time, during proxy evaluation)

The framework throws structured errors when proxy evaluation reaches a violation that the type system cannot express:

- *Scope violations*: a declaration call (`state.f32(...)`, `audioInput(...)`, `defineSubgraph(...)`) inside expression scope (a `process` body, a `forSample` callback, or an L1 helper).
- *Missing `name`*: a snapshot-using processor with a declaration missing a required `name`. (Output coverage and duplicate-write are not enforced — unwritten samples are silence, duplicate writes use source-order semantics, both legal; see Q37.)
- *Constraint violations*: `forSample.byN` called with a non-constant stride; `vec.lane(i)` called with a non-constant `i`; etc.

Errors carry the source location (TypeScript file + line + column when source maps are in scope — see §7) and a refactor hint pointing at the legal pattern.

#### Layer 3 — Static-analysis error (post-capture, before WASM emission)

The compiler runs analysis passes over the captured DAG (see §3); violations detected at this layer are reported with the same source-location format as Layer 2.

- *Allocation check*: an AST pattern that would require heap allocation on the audio thread.
- *Loop boundedness*: a build-time loop that captured non-statically-bounded iteration. Applies to all audio-thread contexts — `forSample` callback bodies, `everyNSamples` sub-blocks, subgraph method bodies, and `messageDecl.onReceive(...)` / `midiInput().onEvent(...)` handler bodies (Q31-b).
- *Memory budget*: the compiler auto-sums every declaration (`state` / `buffer` / `event` + `message` payload content / MIDI ringbuffer) into a single WASM linear-memory allocation. There is no user-side `memoryLimit` option (Q30, `decisions-log.md`). The compiler emits a build-time **warning** when the total exceeds 64 MB (= low-end-device load-time concern) and a build-time **error** when it exceeds the WASM 32-bit linear-memory ceiling (= 4 GB). Runtime `memory.grow` on the audio thread is permanently excluded (= would block the audio thread for milliseconds, violating realtime safety).
- *Out-of-block sample-offset arithmetic*: `add(i, lookahead)` exceeding `[0, SAMPLES_PER_BLOCK - 1]` when statically detectable.
- *Illegal `forSample.byN` stride*: a non-constant stride, or a stride that does not divide `SAMPLES_PER_BLOCK` (= 128). Allowed: 1, 2, 4, 8, 16, 32, 64, 128 (Q37-b, `decisions-log.md`).
- *Constant-truthy `emitIf` cond inside `forSample`*: an `emitIf(cond, payload)` whose `cond` folds to a build-time-constant truthy value (e.g. `emitIf(true, ...)` or `emitIf(FORCE_FLAG, ...)` where `FORCE_FLAG` is a build-time `true`) is rejected when the call site is inside a `forSample` / `forSample.byN` / `everyNSamples` callback. Handler / per-block-top-level contexts are exempt because their natural rate is per-block, not per-sample (Q32-c, `decisions-log.md`).
- *Type inference inconsistency*: a `Node<T>` whose inferred type conflicts with its expected use.

Output coverage is **not** enforced by static analysis: `audioOut.set(c, i, v)` follows the host (AudioWorklet / JUCE) `process` mental model — write freely, duplicates use source-order semantics, sample-offsets that no phase writes are emitted as silence (Q37, `decisions-log.md`).

### 2.5 Error message format

Layer 2 (graph-capture-time) and Layer 3 (static-analysis) errors share a single Rust-style template (Q22-d, `decisions-log.md`):

```text
error[unworklet/<stable-id>]: <one-sentence summary>
  --> <file>:<line>:<col>
   |
<line> |       <code excerpt>
   |       <caret range>
   |

help: <1–3 sentence rationale and refactor direction>

      <corrected code snippet, 1–3 lines>

note: see `decisions-log.md` <Q-ref> for the underlying rule.
```

Concrete example (Layer 3, Q32-c constant-truthy `emitIf` rule):

```text
error[unworklet/constant-truthy-emitif]: constant-truthy `cond` in `emitIf` inside `forSample` would emit at audio rate and overflow the event ringbuffer.
  --> audio-plugins/limiter.ts:42:8
   |
42 |       overshoot.emitIf(true, { atSample: i, level: 0 });
   |                        ^^^^
   |

help: gate emission on a state-edge expression, move it into a handler
      context, or use `everyNSamples` for periodic emission:

      forSample((i, everyNSamples) => {
        everyNSamples(48, () => overshoot.emitIf(cond, payload));
      });

note: see `decisions-log.md` Q32-c for the constant-truthy rule.
```

Components:

- **heading** — `error[unworklet/<stable-id>]: <summary>`. `<stable-id>` is a kebab-case error identifier (e.g. `constant-truthy-emitif`, `scope-violation`, `illegal-stride`, `bounded-loop`, `memory-budget`) usable for grep, IDE filtering, and doc lookup.
- **source location** — `--> <file>:<line>:<col>` followed by a 1–3 line excerpt with caret/tilde markers indicating the offending span.
- **help section** — `help:` prefix + a 1–3 sentence direction + a corrected code snippet (1–3 lines).
- **note section** — `note: see <decisions-log Q-ref>` linking to the underlying ratified rule.

Layer 1 (= TypeScript-native type errors) is delegated to the TypeScript compiler / IDE; unworklet does not reformat or wrap those.

Stable error IDs are listed in §2.6 (inventory) and grow additively with each new check landed in §2.2–§2.4.

### 2.6 Stable error ID inventory

Each `<stable-id>` is a kebab-case identifier used as the `error[unworklet/<stable-id>]` heading (§2.5). IDs are stable across versions — once shipped, they are not renamed; new checks introduce additional IDs. Consumers may grep / filter on them in CI / IDE / build-log pipelines.

| Stable ID | Layer | Rule | Q-ref |
|---|---|---|---|
| `scope-violation` | 2 | a declaration call (`state.*` / `buffer.*` / `param.*` / `audioInput` / `audioOutput` / `event<T>` / `message<T>` / `midiInput` / `midiOutput` / `createSubgraph(...)`) appears inside expression scope (= `process` body, `forSample` callback, handler body, or L1 helper) | Q22-c |
| `declaration-inside-forsample` | 2 | a declaration appears inside a `forSample` callback body (= scope-violation sub-case; the per-sample loop body cannot allocate new graph slots) | Q22-c |
| `missing-name` | 2 | a snapshot-using processor declares a `state.*` / `buffer.*` / `param.*` slot without the required `name` field | Q5-b |
| `illegal-stride` | 2 | `forSample.byN(stride, callback)` is called with a non-build-time-constant `stride`, or a `stride` that does not divide `SAMPLES_PER_BLOCK` (= 128) — allowed values: `1`, `2`, `4`, `8`, `16`, `32`, `64`, `128` | Q37-b |
| `non-constant-lane` | 2 | `vec.lane(i)` is called with a non-build-time-constant lane index `i` (SIMD lane access must fold at graph capture) | Q3 |
| `audio-sample-offset-out-of-range` | 2 | `audioIn.at(c, k)` / `audioOut.set(c, k, v)` / `param.at(k)` is called with a JS-literal sample-offset `k` outside `[0, SAMPLES_PER_BLOCK - 1]` (= `0`〜`127`) | Q68 |
| `payload-element-type-mismatch` | 2 | `buf.copyFrom(payloadField)` is called with a typed-array payload whose element type does not match the buffer's `<T>` (e.g. `Float32Array` → `buffer.i32`) | Q31-c |
| `migrations-unreachable` | 2 | a `migrations: [...]` chain does not cover a path from a known `from` `schemaHash` to the current `schemaHash` (reported as warning by default; promoted to error under `migrationsStrict: true`) | Q5-e |
| `constant-truthy-emitif` | 3 | `emitIf(cond, payload)` inside a `forSample` / `forSample.byN` callback receives a `cond` expression that folds to a build-time-constant truthy value (would emit at audio rate and saturate the event ringbuffer) | Q32-c |
| `bounded-loop` | 3 | an audio-thread loop (in a `forSample` callback, `onReceive` handler, `midiInput().onEvent` handler, `everyNSamples` callback, or subgraph method) has an upper bound that does not fold to a build-time constant | Q31-b |
| `allocation-on-audio-thread` | 3 | an AST pattern reachable from a `process` body or any audio-thread handler would imply heap allocation (e.g. `new Uint8Array(...)`, array literals, object spread) | Q22-c, §5.1 |
| `memory-budget` | 3 | the sum of all declarations in a processor exceeds the WASM linear-memory upper bound (= 4 GB hard error); a lower threshold (= 64 MB) emits a build-time warning under the same family | Q30 |

A separate runtime check (not graph-capture / static-analysis) fires when the worklet observes `outputs[0][0].length !== SAMPLES_PER_BLOCK` at the start of a render quantum (= `block-length-mismatch`); this surfaces as a `node.onError` event on the main side rather than a build-time `error[unworklet/...]` heading. See `04-worklet-runtime.md` §3 and Q18.

## 3. Static analysis phase

<!-- §2.4 (Layer 3 — Static-analysis error) already canonically lists the 4 checks
     for v1.0.0:
       1. allocation-on-audio-thread (Q22-c, §5.1)
       2. bounded-loop (Q31-b — applies across forSample / forSample.byN /
          everyNSamples / handler / subgraph method bodies)
       3. memory-budget (Q30 — auto-sum, 64MB warn / 4GB error)
       4. type inference inconsistency
     §2.6 holds the stable error ID inventory for these. Per-check rule detail
     (= exact AST patterns matched, error-message-level disambiguation) is
     impl-phase fill per Q61. "Parameter reachability" and "cycle /
     instruction-count estimation" are NOT v1.0.0 scope (= no ratified rule,
     no acceptance criterion in Q62); if a need surfaces they land additively
     in v1.x.0 with their own Q ratify + stable error ID. -->

## 4. WASM emission phase

<!-- Emission target (binaryen.js or custom emitter).

     Exported entry — the signature reflects the 4 per-block I/O paths the
     runtime marshals (04-worklet-runtime §2):
       process(inputChannelsPtr, outputChannelsPtr, paramArraysPtr, messageQueuePtr) -> void

     Linear memory layout — sized at build time from auto-summed declarations
     (Q30); all sub-regions pre-allocated at instantiation. Sub-region set:
       1. state slots (Q5 — scalar `state.<T>` persisted across quanta)
       2. buffer slots (Q5 — fixed-size arrays persisted across quanta)
       3. I/O scratch (per-quantum input / output channel + param array views)
       4. event<T> / message<T> ringbuffers (Q27-d — SAB when available)
       5. event<T> / message<T> payload content buffers (Q27-e — variable-length)
       6. MIDI ringbuffer (Q4-c — uniform with event<T> ringbuffer)
       7. sysex content buffer (Q4-c-iii — paired with MIDI ringbuffer)
       8. state.publish / buffer.publish shared regions (Q27-a — SAB per slot)
       9. per-slot publish counters (§7 — initialized to 0 at instantiation)
       10. snapshot region (Q5 — block-atomic memcpy target for `node.snapshot()`)

     Realtime-safety contracts:
       - `memory.grow` opcode never emitted into the worklet's WASM (§2.6 Emission)
       - math intrinsics inlined per Q17 (polynomial approximation, WASM-only,
         no FFI / JS-WASM per-sample boundary crossings)

     Per-sub-region byte layout, emit ordering, and emitter IR shape detail is
     impl-phase fill per Q61. -->

## 5. Worklet JS codegen

<!-- AudioWorkletProcessor subclass + parameterDescriptors + queue wiring + registerProcessor. -->

## 6. Client TS codegen

<!-- Typed node wrapper with .params / .messages / .events; .d.ts emission for end-user consumption. -->

## 7. Source maps

<!-- Q22 — TS source → AST → WASM line/column propagation; sidecar vs embedded;
     consumed by error diagnostics and bench / analyze tooling. Lands here. -->

## 8. Pure-JS backend

<!-- Same AST interpreted in JS for the test backend (06-testing.md). Cross-validation rules
     (bit-identical output modulo documented FP differences). -->
