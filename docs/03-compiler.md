# 03 — Compiler (`@unworklet/compiler`)

The build-time pipeline that turns a `defineProcessor` definition into the artifacts consumed by the worklet runtime, the main-thread client, and the test backend.

## Status

skeleton

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
- proxy implementations of all primitives in `@unworklet/dsp` (and `@unworklet/core/simd` if imported) that, when called with `Node<T>` arguments, return new `Node<T>` instances representing AST nodes rather than computing values;
- a `forSample` proxy that, when called, accepts a callback, executes it once with a fresh `Node<'i32'>` proxy bound as `i`, and records the resulting AST as a per-sample loop body.

Build-time JavaScript continues to behave like ordinary JavaScript: literals, `Math.*`, build-time `if` / `for`, build-time arithmetic on `number` values are all evaluated normally. The proxies only intercept operations on `Node<T>` (and other framework-managed values). This is the boundary that lets users write loop unrolling, debug-flag pruning, and constant precomputation without framework involvement — see `decisions-log.md` Q22 (Q22-a).

### 2.2 Phase walk

The body executes top-to-bottom; the framework recognises four phase boundaries:

1. **Declaration scope** — the top of the `defineProcessor` body, before `return { process: ... }`. New `state.*`, `buffer.*`, `param.*`, `audioInput`, `audioOutput`, and `defineSubgraph` instantiations are recorded as graph slots. Each declaration registers a `name` (when supplied) for later snapshot identity (see `01-dsl.md` §8).

2. **Expression scope (`process` body)** — the framework calls the returned `process` lambda. If the body contains zero `forSample` calls and uses sugar primitives directly, the framework wraps the entire body in an implicit `forSample` and treats it as a single per-sample loop body. If the body contains explicit `forSample(...)` calls, each call is recorded as a separate phase; phases run in declared order.

3. **`forSample` callback** — the callback is invoked once with a `Node<'i32'>` proxy bound as `i`. Primitive calls inside the callback construct AST nodes. The resulting AST is the per-sample loop body for that phase. `forSample.byN(stride, callback)` is identical except that the recorded AST is tagged with the stride for emission as a `stride`-step loop.

4. **Sub-rate callback (`everyNSamples`)** — same as `forSample`, but tagged with the divisor `N` for sub-block emission (see `01-dsl.md` §9).

### 2.3 What the proxy captures

For each primitive call:

- **Arithmetic / math / control / type conversion**: a typed AST node with the operator and operand handles, returning a fresh `Node<T>` of the inferred output type.
- **`load` / `store`**: a memory-access AST node referencing the corresponding slot.
- **Buffer access (`readBuffer` / `writeBuffer` / `readBufferInterpolated`)**: an indexed access AST node; the index argument is itself a `Node<'i32'>` (typically a ring-buffer write head).
- **Audio I/O (`audioIn.read(c)` / `audioIn.at(c, i)` / `audioOut.write([...])` / `audioOut.set(c, i, v)`)**: a sample-position-aware AST node carrying the channel index, the sample-offset (`i` for explicit form, the surrounding iteration counter for sugar form), and (for `set` / `write`) the value to write.
- **Param access (`param()` / `param.at(i)`)**: an AST node carrying the param slot reference and the sample-offset.
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
- *Required-call violations*: a declared `audioOutput` whose `write(...)` / `set(c, i, v)` is never called on any code path; a snapshot-using processor with a declaration missing a required `name`.
- *Duplicate writes*: the same channel × same sample-offset written twice within one phase.
- *Constraint violations*: `forSample.byN` called with a non-constant stride; `lane(vec, i)` called with a non-constant `i`; out-of-block sample-offset arithmetic (`add(i, lookahead)` exceeding the render quantum) when statically detectable; etc.

Errors carry the source location (TypeScript file + line + column when source maps are in scope — see §7) and a refactor hint pointing at the legal pattern.

#### Layer 3 — Static-analysis error (post-capture, before WASM emission)

The compiler runs analysis passes over the captured DAG (see §3); violations detected at this layer are reported with the same source-location format as Layer 2.

- *Allocation check*: an AST pattern that would require heap allocation on the audio thread.
- *Loop boundedness*: a build-time loop that captured non-statically-bounded iteration.
- *Memory budget*: total `state` + `buffer` size exceeds the configured limit.
- *Type inference inconsistency*: a `Node<T>` whose inferred type conflicts with its expected use.

### 2.5 Open: Q22-d (error message format)

The exact format of error messages for each layer (heading, refactor-hint structure, source-location formatting, follow-up-link convention) is not yet resolved. Tracked as Q22-d — see `decisions-log.md` Q22.

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
