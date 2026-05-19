# 03 — Compiler

The build-time pipeline that turns a `defineProcessor` definition into the artifacts consumed by the worklet runtime, the main-thread client, and the test backend. This is an internal module of `@unworklet/core` — the user invokes it implicitly through `@unworklet/vite-plugin`; there is no direct `import` surface.

## Status

partial (§2 graph capture + §2.4 three-layer error written; §1, §3–§8 placeholder)

## 1. Pipeline overview

<!-- processor.ts → AST (DAG of primitive calls) → static analysis → multi-target emission:
       - WASM binary (production)
       - pure-JS interpreter (testing)
       - worklet JS template
       - typed client TS .d.ts
       - metadata JSON. -->

## 2. Graph capture phase

The compiler obtains the user's processor as an AST DAG by invoking the `defineProcessor` body once at build time, with proxy objects standing in for `Node<T>` values, declaration handles, and built-in primitives.

### 2.1 Build-time evaluation

The `defineProcessor` body is ordinary JavaScript / TypeScript code, executed once. The framework supplies:

- a `ctx` proxy carrying compile-time constants (`sampleRate`, etc.) and meta primitives (`audioInput`, `audioOutput`, `state`, `buffer`, `param`, `defineSubgraph`, `migrations`, ...);
- proxy implementations of all primitives exported from `@unworklet/core` (and `@unworklet/core/simd` if imported) that, when called with `Node<T>` arguments, return new `Node<T>` instances representing AST nodes rather than computing values;
- a `forSample` proxy that, when called, accepts a callback, executes it once with a fresh `Node<'i32'>` proxy bound as `i`, and records the resulting AST as a per-sample loop body.

Build-time JavaScript continues to behave like ordinary JavaScript: literals, `Math.*`, build-time `if` / `for`, build-time arithmetic on `number` values are all evaluated normally. The proxies only intercept operations on `Node<T>` (and other framework-managed values). This is the boundary that lets users write loop unrolling, debug-flag pruning, and constant precomputation without framework involvement — see `decisions-log.md` Q22 (Q22-a).

### 2.2 Phase walk

The body executes top-to-bottom; the framework recognises four phase boundaries:

1. **Declaration scope** — the top of the `defineProcessor` body, before `return { process: ... }`. New `state.*`, `buffer.*`, `param.*`, `audioInput`, `audioOutput`, and `defineSubgraph` instantiations are recorded as graph slots. Each declaration registers a `name` (when supplied) for later snapshot identity (see `01-dsl.md` §8).

2. **Process body (top level)** — the framework calls the returned `process` lambda. Statements at the top level of the body emit code that runs once at the start of every render quantum. `forSample(...)` invocations within the body capture a per-sample sub-loop in the AST. Source order is preserved at the AST and at runtime — top-level statements and `forSample` invocations execute in declared order within the render quantum, with no separate phase-segmentation step (see `00-foundations.md` §3 "Process body" for the JUCE / AudioWorklet mental model).

3. **`forSample` callback (per-sample sub-loop)** — the callback is invoked once during graph capture with a `Node<'i32'>` proxy bound as `i`. Primitive calls inside the callback construct AST nodes. The resulting AST is the per-sample loop body for that sub-loop. `forSample.byN(stride, callback)` is identical except that the recorded AST is tagged with the stride for emission as a `stride`-step loop.

4. **Sub-rate callback (`everyNSamples`)** — invoked from inside a `forSample` callback. Recorded as a sub-block tagged with the divisor `N` for sub-rate emission (see `01-dsl.md` §9).

### 2.3 What the proxy captures

For each primitive call:

- **Arithmetic / math / control / type conversion**: a typed AST node with the operator and operand handles, returning a fresh `Node<T>` of the inferred output type.
- **`load` / `store`**: a memory-access AST node referencing the corresponding slot.
- **Buffer access (`buf.read` / `buf.write` / `buf.readInterpolated`)**: an indexed access AST node; the index argument is itself a `Node<'i32'>` (typically a ring-buffer write head).
- **Audio I/O (`audioIn.at(c, i)` / `audioOut.set(c, i, v)`)**: a sample-position-aware AST node carrying the channel index, the sample-offset `i`, and (for `set`) the value to write. The sample-offset is `Node<'i32'> | number`: the `Node<'i32'>` form binds the surrounding `forSample` callback's loop counter, and JS-literal offsets (Q36-a) accept the primitive at any lexical position — at the per-block top level this uses literal `0` for block-start access (Q51).
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
- *Missing `name`*: a snapshot-using processor with a declaration missing a required `name` (output coverage and duplicate-write checks were retired per Q37 — unwritten samples are silence, duplicate writes use source-order semantics, both legal).
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

The list of stable error IDs is maintained as a separate inventory and grows additively with each new check landed in §2.2–§2.4.

## 3. Static analysis phase

<!-- - Allocation check (verify by-construction invariant)
     - Loop boundedness (all loops statically bounded)
     - Memory sizing (sum of state + buffer declarations)
     - Type inference and consistency check
     - Parameter reachability
     - Cycle / instruction-count estimation -->

## 4. WASM emission phase

<!-- binaryen.js (or custom emitter):
     - exported function `process(blockPtr, paramPtrs, messagePtr) -> void`
     - linear memory layout (state | buffers | I/O scratch | queue regions)
     - no memory.grow
     - math intrinsics inlined or imported per Q14 (resolution lives in 01-dsl.md §2). -->

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
