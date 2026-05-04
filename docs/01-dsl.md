# 01 — DSL (`@unworklet/core` + `@unworklet/dsp`)

The surface the user authors against. Defines `defineProcessor`, primitives, declarations (`state`, `buffer`, `param`), and authoring patterns for reusable DSP blocks.

## Status

skeleton

## 1. `defineProcessor` and I/O declarations

`defineProcessor` is the entry point. The body is a single lambda: declarations at the top, a `process` lambda inside the returned record. Audio inputs and outputs are declared explicitly via `audioInput()` / `audioOutput()` helpers — the same declaration-scope pattern as `state` / `buffer` / `param`.

```typescript
const splitter = defineProcessor((ctx) => {
  // Declaration scope — audio I/O, state, params.
  const main = audioInput({ channels: 2, name: 'main' });
  const sc   = audioInput({ channels: 1, name: 'sidechain' });

  const low  = audioOutput({ channels: 2, name: 'low' });
  const mid  = audioOutput({ channels: 2, name: 'mid' });
  const high = audioOutput({ channels: 2, name: 'high' });

  // ... state / param declarations ...

  return {
    process: () => {
      // Expression scope — per-sample DSP.
      const l   = main.read(0);
      const r   = main.read(1);
      const scv = sc.read(0);
      // ... 3-band split with sidechain ducking ...
      low.write([lowL, lowR]);
      mid.write([midL, midR]);
      high.write([highL, highR]);
    },
  };
});
```

### 1.1 `audioInput` and `audioOutput`

Both helpers live in declaration scope only. Calling them inside a `process` lambda or any other expression scope is a graph-capture-time error.

```typescript
audioInput <C extends number>(options: { channels: C, name: string }): AudioInputHandle<C>;
audioOutput<C extends number>(options: { channels: C, name: string }): AudioOutputHandle<C>;
```

Options:

- **`channels: number`** — fixed channel count for that port, set at compile time. Maps directly to Web Audio's `outputChannelCount[i]` for outputs and is the input-side expectation for `read()`.
- **`name: string`** — required. Used as the key in main-thread `node.inputs.<name>` / `node.outputs.<name>` access (see `05-client.md` §1) and as the slot identity for that I/O port. There is no default; explicit naming is uniform with state/buffer/param `name` and avoids index-based mental models in tooling and main-thread code.

### 1.2 Reading from inputs

`AudioInputHandle<C>.read(channelIndex)` returns a `Node<'f32'>` representing the current-sample value of that channel. The `channelIndex` argument is narrowed by TypeScript to the legal range for the declared channel count (`channels: 2` → `0 | 1`); out-of-range indices are TypeScript errors at the call site.

```typescript
const stereo = audioInput({ channels: 2, name: 'main' });
const l = stereo.read(0);   // Node<'f32'>, channel 0
const r = stereo.read(1);   // Node<'f32'>, channel 1
const x = stereo.read(2);   // ❌ Type error: 2 is not assignable to 0 | 1
```

The actual channel count of the connected source is normalized by Web Audio's standard up-mix / down-mix rules (`channelInterpretation`, `channelCountMode`) before the worklet sees it; the framework does not intervene in this layer.

### 1.3 Writing to outputs

`AudioOutputHandle<C>.write(values)` accepts a tuple of `Node<'f32'>` values whose length must equal the declared `channels`. Tuple-length mismatch is a TypeScript error at the call site.

```typescript
const stereoOut = audioOutput({ channels: 2, name: 'main' });
stereoOut.write([leftNode, rightNode]);    // ✓
stereoOut.write([leftNode]);               // ❌ Tuple length mismatch
stereoOut.write([leftNode, r, extra]);     // ❌ Tuple length mismatch
```

`write()` must be called exactly once per `process` invocation for each declared output, on every code path. Missing writes (output never written) and duplicate writes (output written twice in the same `process`) are graph-capture-time errors with refactor-hint messages.

### 1.4 Multiple inputs / outputs

There is no implicit cap on the number of `audioInput` / `audioOutput` declarations beyond Web Audio's `numberOfInputs` / `numberOfOutputs` (which are set from the declaration count). Each port is independent; channel counts can differ.

```typescript
const drumBus = defineProcessor((ctx) => {
  const dry  = audioInput ({ channels: 2, name: 'dry'  });
  const send = audioOutput({ channels: 2, name: 'send' });   // pre-fader to reverb
  const main = audioOutput({ channels: 2, name: 'main' });   // dry mix
  // ...
});
```

### 1.5 No default I/O sugar

A processor must declare every audio port it uses. There is no implicit "default mono in / default mono out" generated when `audioInput` / `audioOutput` are absent — a processor with zero I/O declarations has zero audio I/O on the resulting AudioWorkletNode.

This is intentional: a single declaration pattern across all processor sizes (minimal sine generator → multi-band splitter) keeps the mental model uniform with state/buffer/param. The few extra lines on the smallest example are paid back the moment the processor grows.

```typescript
const sin440 = defineProcessor((ctx) => {
  const out   = audioOutput({ channels: 1, name: 'main' });
  const phase = state.f32(0, { name: 'phase' });
  return {
    process: () => {
      const inc = 2 * Math.PI * 440 / ctx.sampleRate;
      phase.store(add(phase.load(), inc));
      out.write([sin(phase.load())]);
    },
  };
});
```

### 1.6 Main-thread access

The compiled `UnworkletNode<C>` exposes `node.inputs.<name>` and `node.outputs.<name>` typed accessors that wrap the underlying `AudioWorkletNode`'s indexed `connect()` calls. The raw `AudioWorkletNode` is always reachable as `node.node` for graph topologies the typed surface does not cover. See `05-client.md` §1 for the full main-thread surface.

Authoritative rationale and rejected alternatives: see `decisions-log.md` Q6.

## 2. Primitive operators

<!-- Full inventory: arithmetic (add/sub/mul/div/mod/neg), comparison (eq/lt/gt/lte/gte),
     math (sin/cos/tan/tanh/exp/log/sqrt/abs/floor/ceil/frac/min/max/clamp),
     control (select), memory (load/store/readBuffer/writeBuffer/readBufferInterpolated),
     type conversions (f32/f64/i32/i64).
     Q14 (math precision: default vs `/precise` vs `/table` import paths). Lands here. -->

## 3. State, buffer, param declarations

The three primitive declaration kinds — scalar `state`, fixed-size `buffer`, and `AudioParam`-backed `param` — are the only places where new memory slots enter the graph. Each declaration accepts an optional `name` field for snapshot identity (see §8.1) and an optional `snapshot` field controlling persistence behavior (see §8.2).

### 3.1 `state` — scalar slots

```typescript
const z1   = state.f32(0);                                    // f32 scalar, snapshot 'persistent' by default
const acc  = state.f64(0, { name: 'accumulator' });           // explicit identity for snapshot()
const tmp  = state.f32(0, { snapshot: 'transient' });         // excluded from all snapshot profiles
const fl   = state.bool(false);
const idx  = state.i32(0);
```

`state.<type>(initial, options?)` declares a scalar slot. `load()` reads the current value; `store(node)` writes a `Node<T>` value back. The slot is inlined into the WASM linear memory at compile time.

Options:

- **`name?: string`** — slot identity. Required when the parent processor calls `snapshot()` (graph-capture-time error otherwise). Used as the slot key in snapshot blobs.
- **`snapshot?: 'persistent' | 'transient' | { [profile: string]: 'persistent' | 'transient' }`** — snapshot inclusion. Default is `'persistent'`. See §8.2.

### 3.2 `buffer` — fixed-size arrays

```typescript
const ring = buffer.f32({ size: 44100, name: 'delayLine' });                          // default 'transient'
const wave = buffer.f32({ size: 256,   name: 'wavetable', snapshot: 'persistent' });  // explicit include
```

Access goes through dedicated primitives (`readBuffer`, `writeBuffer`, `readBufferInterpolated`); bounds and interpolation behavior are explicit at each call site.

Options:

- **`size: number`** — element count, fixed at compile time. The buffer occupies `size × sizeof(type)` bytes in linear memory.
- **`name?: string`** — slot identity (same rules as `state`).
- **`snapshot?: 'persistent' | 'transient' | { ... }`** — default is `'transient'`. Most buffers are accumulation regions (delay lines, scratch buffers) whose contents lose meaning across preset boundaries; include explicitly when the contents *are* the slot's identity (wavetables, lookup tables).

### 3.3 `param` — AudioParam-backed

```typescript
const cutoff = param({
  default: 1000, min: 20, max: 20000,
  automationRate: 'a-rate',
  name: 'cutoff',
});
const route = param({
  default: 0, min: 0, max: 7,
  automationRate: 'k-rate',
  name: 'route',
  snapshot: 'transient',         // excluded — UI-only routing flag
});
```

`param()` declares a slot bound to the standard Web Audio `AudioParam`. `.at(i)` reads the value at sample-offset `i` within the current render quantum (uniform for k-rate length-1 and a-rate length-128 arrays).

Options:

- **`default`, `min`, `max`** — initial value and clamp range.
- **`automationRate: 'a-rate' | 'k-rate'`** — Web Audio automation rate.
- **`unit?: string`** — display hint passed through to `AudioParamDescriptor` metadata.
- **`name?: string`** — slot identity.
- **`snapshot?: 'persistent' | 'transient' | { ... }`** — default is `'persistent'` (param values are typically the user-controlled state of a preset). Snapshots include only the **current value**; AudioParam automation queues (`setValueAtTime`, `linearRampToValueAtTime`, etc.) are not preserved.

Authoritative rationale for the snapshot defaults: `decisions-log.md` Q5 (Q5-b).

## 4. Messages and events declarations

<!-- message({...}) and event({...}) declaration shape (the runtime contract lives in 02-messaging.md;
     this section only covers DSL surface — how the user *declares* them). -->

## 5. Third-party DSP integration

unworklet exposes two integration layers for reusable DSP authored as either user code or third-party libraries. The split is the cleanest rule for choosing between them: **does the helper own internal state?**

### 5.1 L1 — pure TS function

A plain TypeScript function over `Node<T>` values. Inlined into the parent processor at compile time, so there is no per-call overhead.

```typescript
function softclip(x: Node<'f32'>): Node<'f32'> {
  return tanh(mul(x, 1.5));
}

function lerp(a: Node<'f32'>, b: Node<'f32'>, t: Node<'f32'>): Node<'f32'> {
  return add(a, mul(sub(b, a), t));
}
```

Whether L1 helpers can also write to `state.*` references owned by the caller — and the typing rules for that — is settled in §5.5 (TBD, Q2-b).

### 5.2 L2 — `defineSubgraph`

A reusable DSP block that owns its internal state. Declares its own `state.*`, `buffer.*`, and `param.*` slots; instantiated zero or more times inside a parent `defineProcessor`. Each instantiation gets its own state, but every instance is inlined into the parent's WASM module — there is no per-instance function-call boundary at audio rate.

```typescript
const onepole = defineSubgraph((input: Node<'f32'>, coef: Node<'f32'>) => {
  const z1 = state.f32(0);
  const y = add(z1.load(), mul(coef, sub(input, z1.load())));
  z1.store(y);
  return y;
});
```

Instantiation API, parameter declaration rules, and capture-time analysis are settled in §5.6 (TBD, Q2-c).

### 5.3 Why two layers, not one

A single layer that auto-promotes to a subgraph based on the presence of `state.*` calls inside the function body was rejected. Implicit promotion blurs the responsibility boundary between graph capture (`03-compiler.md` §3) and TypeScript type inference: whether a callsite is "an inlined expression" or "an instance of a stateful block" would depend on what the function happened to call. Explicit separation gives the static analyzer a clean rule and gives users a clear mental model for what they are authoring.

### 5.4 No L3

unworklet does not provide a "separate processor + connect" integration layer. The existing Web Audio mechanism — instantiating two `AudioWorkletNode`s and calling `.connect()` on the main thread — already covers this case and lives outside unworklet's API surface. Wrapping it would add weight without value.

Rationale and rejected alternatives: see `decisions-log.md` Q2.

### 5.5 L1 surface details

L1 helpers are pure TypeScript functions that compose `Node<T>` values into new `Node<T>` values, inlined at the call site. The following rules govern what such a function can take, return, and contain.

#### 5.5.1 Two scopes (cross-cutting context)

unworklet code lives in two graph-capture-time scopes:

- **Declaration scope** — the body of `defineProcessor` and `defineSubgraph` directly. New `state.*`, `buffer.*`, `param.*` declarations live here. Each declaration registers a slot in the graph (and ultimately a region in WASM linear memory).
- **Expression scope** — the body of `process` lambdas and L1 helpers. Per-sample expressions live here. Already-declared `State<T>` and similar handles can be `load`/`store`d, but **no new declarations** are allowed.

L1 helpers exist purely in expression scope.

(Authoritative scope and graph-capture-model definitions land in `00-foundations.md` §3 Vocabulary — TBD.)

#### 5.5.2 Parameters

L1 helpers can receive:

- `Node<T>` values (the most common case),
- `State<T>` references owned by the caller, including their `load` / `store` methods,
- `Param` references owned by the caller, including `param.at(...)`,
- non-`Node` literals where statically appropriate (e.g. compile-time constants).

The caller-owned `State<T>` form lets a parent processor own state and delegate per-sample logic to a shared helper:

```typescript
function smoothFollow(
  x: Node<'f32'>,
  prev: State<'f32'>,
  alpha: Node<'f32'>
): Node<'f32'> {
  const y = add(prev.load(), mul(alpha, sub(x, prev.load())));
  prev.store(y);
  return y;
}
```

#### 5.5.3 Return shape

L1 helpers can return:

- a single `Node<T>`,
- a tuple `[Node<...>, Node<...>, ...]`,
- a record `{ key: Node<...>, ... }`,
- `void` (when the helper exists for its store-only side effects).

Each returned `Node` is captured as an independent terminal in the parent graph; multi-output returns carry no extra runtime cost.

#### 5.5.4 Precision-generic helpers

Helpers may be generic over precision via TypeScript generics:

```typescript
function softclip<P extends 'f32' | 'f64'>(x: Node<P>): Node<P> {
  return tanh(mul(x, 1.5));
}

const y32 = softclip(f32node);  // P = 'f32', returns Node<'f32'>
const y64 = softclip(f64node);  // P = 'f64', returns Node<'f64'>
```

The Q1 "no implicit widening" rule still applies inside the body: mixed-precision operands within a generic body produce a TypeScript type error at the call site or the definition.

#### 5.5.5 Body constraints

Inside an L1 body, the following are **forbidden** and produce a graph-capture-time error:

- New `state.*` / `buffer.*` / `param.*` declarations.
- New `defineSubgraph(...)` declarations or instantiations of an existing `defineSubgraph` result.
- `message` / `event` declarations.

The following are **allowed**:

- Primitive operators (`add`, `mul`, `tanh`, `select`, …).
- `load` / `store` on `State<T>` references received as parameters.
- `param.at(...)` on `Param` references received as parameters.
- Calls to other L1 helpers.

#### 5.5.6 Error UX

Violations are caught at compile time (during graph capture or static analysis — see `03-compiler.md` §3) and surfaced as build errors before the WASM is emitted, never at runtime. Error messages include a concrete refactor hint pointing at one of the legal patterns. Example:

```text
error: L1 helper 'badHelper' cannot declare state.
  Either:
    (a) accept State<'f32'> as a parameter from the caller, or
    (b) refactor as a defineSubgraph (L2).
  See docs/01-dsl.md §5.2 for the L1 vs L2 boundary.
```

Detailed error-UX policy is settled in `03-compiler.md` §2 (Q22, TBD).

### 5.6 L2 surface details

L2 subgraphs are reusable, stateful DSP blocks defined with `defineSubgraph`. Each instantiation gets its own state slots, and every instance is inlined into the parent's WASM module.

#### 5.6.1 Body structure (mirrors `defineProcessor`)

A subgraph body has the same two-scope structure as `defineProcessor`: a declaration scope at the top and an expression scope inside a `process` lambda. The symmetry is intentional — L2 and root processors share one mental model.

```typescript
const onepole = defineSubgraph((input: Node<'f32'>, coef: Node<'f32'>) => {
  // ━━━ Declaration scope ━━━
  // Per-instantiation state slots; declared once per call site.
  const z = state.f32(0);

  return {
    process: () => {
      // ━━━ Expression scope ━━━
      // Per-sample expression; evaluated each render quantum.
      const y = add(z.load(), mul(coef, sub(input, z.load())));
      z.store(y);
      return y;
    },
  };
});
```

#### 5.6.2 Instantiation syntax

A `defineSubgraph` result is directly callable; the call instantiates a fresh subgraph with its own state slots.

```typescript
const yL = onepole(inputL, cutoff);  // instance #1: independent state
const yR = onepole(inputR, cutoff);  // instance #2: independent state
```

The call signature mirrors L1 helpers (`onepole(args)`), so subgraphs and L1 helpers compose interchangeably from the consumer side.

#### 5.6.3 Return shape

The `process` lambda's return value becomes the subgraph's per-sample output, with the same shapes allowed for L1 helpers (§5.5.3):

- single `Node<T>` — typical filter / oscillator,
- tuple `[Node<...>, Node<...>, ...]` — multi-output (stereo, SVF low/band/high),
- record `{ key: Node<...>, ... }` — named multi-output,
- `void` — side-effect-only (e.g. accumulator bus).

The instantiation expression's type is inferred from the `process` return.

#### 5.6.4 Where subgraphs can be instantiated

`defineSubgraph` results may only be **instantiated in declaration scope** — the body of `defineProcessor` or another `defineSubgraph`, before its `process` lambda. Instantiation inside an expression scope (a `process` lambda or an L1 helper body) is forbidden.

Each instantiation is a *declaration of an independent state slot*; placing it in declaration scope keeps graph structure predictable (the number of instances is statically determined at compile time) and prevents the misread that subgraphs are runtime-allocated.

Conditional output between configurations is expressed by instantiating both and choosing with `select`:

```typescript
const myProcessor = defineProcessor((ctx) => {
  const lpfA = onepole(ctx.inputs[0][0], coefA);  // instance #1
  const lpfB = onepole(ctx.inputs[0][0], coefB);  // instance #2
  const useA = param({ default: 1, min: 0, max: 1, automationRate: 'k-rate' });

  return {
    process: () => {
      return select(useA.at(0), lpfA, lpfB);
      // Both instances evaluate every sample; select chooses one.
    },
  };
});
```

#### 5.6.5 Body constraints

Inside a subgraph body:

- **Declaration scope** (top of the body, before `return { process }`) allows new `state.*` / `buffer.*` / `param.*` declarations and L2 instantiations of other subgraphs.
- **Expression scope** (inside `process`) follows the same rules as L1 helpers (§5.5.5): no new declarations, no L2 instantiations; primitives and `load` / `store` on declared state are allowed.

Violations are caught at graph-capture / static-analysis time with refactor-hint error messages, mirroring §5.5.6. Example:

```text
error: defineSubgraph 'onepole' must be instantiated in declaration scope
       (defineProcessor or defineSubgraph body), not inside a process lambda.
  Move the call to the parent body, or refactor the helper as an L1 function
  if it does not need its own state.
```

## 6. The two phases

<!-- `process(({ inputs, outputs, params, ctx })) => sample => ...` shape;
     `publish(({ state, emit, every }))` shape;
     scheduling and constraints of each. -->

## 7. Opt-in SIMD

unworklet exposes WASM SIMD as a separate, opt-in surface via the import path `@unworklet/core/simd`. Code that does not import this path never encounters vector types or vector primitives — the scalar surface is unchanged.

### 7.1 Philosophy

- **Opt-in**: importing `@unworklet/core/simd` is the only way to bring vector concepts into scope. Scalar-only authors and consumers never see `f32x4`, `splat`, or any vec primitive.
- **Parallel families**: scalar primitives (`add`, `mul`, …) and vec primitives (`addVec`, `mulVec`, …) are distinct functions over distinct types. Scalar `Node<'f32'>` and vector `Node<'f32x4'>` cannot be combined in one operation; conversion is explicit (`splat`, `lane`).

```typescript
// Scalar-only author — never imports SIMD
import { defineProcessor, state, add, mul } from '@unworklet/core';

// SIMD-using author — separate import path
import { vec4, splat, addVec, mulVec, loadVec, storeVec, lane } from '@unworklet/core/simd';
```

### 7.2 v1.0.0 surface (Minimal MVP)

The v1.0.0 SIMD surface is the smallest set of primitives that lets DSP authors hand-vectorize hot paths (4-channel mixers, 4-tap filters, parallel-lane oscillators). Subsequent v1.x.0 releases extend the surface additively (see Q14, `10-roadmap.md`).

#### Vector types

- `Node<'f32x4'>` — four 32-bit floats packed into a v128.

#### Construction

- `vec4(a: Node<'f32'>, b: Node<'f32'>, c: Node<'f32'>, d: Node<'f32'>): Node<'f32x4'>` — pack 4 scalars into a vec.
- `splat(x: Node<'f32'>): Node<'f32x4'>` — broadcast a scalar to all four lanes.

#### Arithmetic

- `addVec`, `subVec`, `mulVec`, `divVec`: `(Node<'f32x4'>, Node<'f32x4'>) → Node<'f32x4'>`.

#### Lane access

- `lane(vec: Node<'f32x4'>, i: 0 | 1 | 2 | 3): Node<'f32'>` — extract one lane. The index `i` must be a compile-time constant; non-constant indices are a graph-capture-time error.

#### Memory

- `loadVec(buffer: Buffer<'f32'>, offset: Node<'i32'>): Node<'f32x4'>` — load four contiguous f32 lanes from a buffer (offset in element units).
- `storeVec(buffer: Buffer<'f32'>, offset: Node<'i32'>, value: Node<'f32x4'>): void` — store four contiguous f32 lanes into a buffer.

### 7.3 Beyond v1.0.0 (deferred to v1.x.0, additive)

Adding any of the following does not change the v1.0.0 surface:

- `Node<'f64x2'>` and `Node<'i32x4'>` types and their arithmetic.
- Boolean / mask vectors and `selectVec`.
- `shuffle` / `swizzle` lane permutations.
- Comparison primitives (`ltVec`, `eqVec`, …).
- Gather / scatter (load from non-contiguous offsets).

Rollout order is settled by Q14 once early DSP packages report which extensions they need first.

### 7.4 Use within L1 / L2 / processors

Vec primitives are usable inside any expression scope (`process` lambdas, L1 helper bodies, subgraph `process` lambdas). They count as primitive operators for §5.5.5 / §5.6.5 purposes — bodies are still forbidden from declaring new state / buffer / param.

L1 helpers can be precision-generic over scalar precisions (§5.5.4) but **not** generic over scalar / vec width. A helper that needs to support both widths is written as two helpers:

```typescript
// Scalar version — visible to @unworklet/core users only
function softclip(x: Node<'f32'>): Node<'f32'> {
  return tanh(mul(x, 1.5));
}

// Vec version — visible to @unworklet/core/simd users only
function gainVec(x: Node<'f32x4'>, g: Node<'f32'>): Node<'f32x4'> {
  return mulVec(x, splat(g));
}
```

The duplication is intentional: it keeps the scalar API surface untouched and signals at the call site that the vec version is a deliberate choice.

## 8. Snapshot / restore declaration

Processors that need preset save/load, session restore, or AB compare declare snapshot/restore behavior in two places: per-slot `snapshot` flags (§3) and an optional `migrations` array on the processor itself.

### 8.1 Slot identity rules

Every slot reachable from a `defineProcessor` body that calls `snapshot()` must carry a unique `name`. Names are used as keys in snapshot blobs. Subgraph instances must also carry a `name` option:

```typescript
const onepole = defineSubgraph((input: Node<'f32'>, coef: Node<'f32'>) => {
  const z = state.f32(0, { name: 'z' });
  return { process: () => { /* ... */ } };
});

const synth = defineProcessor((ctx) => {
  const lpfL = onepole(inputL, cutoff, { name: 'lpfL' });   // slot path 'lpfL/z'
  const lpfR = onepole(inputR, cutoff, { name: 'lpfR' });   // slot path 'lpfR/z'
  // ...
});
```

Slot path is the slash-joined chain from the root processor (`'lpfL/z'`, `'fxBus/reverb/tail'`, etc.). Graph capture validates uniqueness; missing `name` on any reachable slot or subgraph instance is a graph-capture-time error.

### 8.2 Snapshot profiles

The `snapshot` option on each declaration is one of:

- `'persistent'` — included in every profile; included in `snapshot()` (no profile arg).
- `'transient'` — excluded from every profile; excluded from `snapshot()` (no profile arg).
- `{ [profile: string]: 'persistent' | 'transient' }` — per-profile flag; included in `snapshot({ profile })` only when that profile maps to `'persistent'`. `snapshot()` (no arg) includes the slot if **any** profile maps to `'persistent'`.

Profile names are user-defined — `'preset'` and `'session'` are conventional examples but the framework reserves no names. The set of profiles a processor supports is the union of profile keys appearing across all declarations, computed at graph-capture time.

### 8.3 `migrations` — declarative schema upgrades

Schema changes between versions of a published processor (slot rename, type widening, buffer resize, profile rename, etc.) are handled by a chain of `migrations`. The framework walks the chain to bridge the blob's source schema to the current schema; the developer writes adjacent `from → to` steps only.

```typescript
const synth = defineProcessor((ctx) => {
  // ...declarations...

  migrations([
    {
      from: 'a3f2c1d0...',         // schema hash before this migration
      to:   'b8c14fe2...',         // schema hash after this migration
      migrate: (oldBlob, helpers) => {
        // rename: 'lpfZ1' → 'lpfPoleZ1'
        const v = helpers.parseSlot(oldBlob, 'lpfZ1', 'f32');
        if (v !== undefined) helpers.writeSlot('lpfPoleZ1', 'f32', v);
      },
    },
    {
      from: 'b8c14fe2...',
      to:   'd7e3a991...',
      migrate: (oldBlob, helpers) => {
        // resize delay buffer 44100 → 88200, copy old content into prefix
        const old = helpers.parseBuffer(oldBlob, 'delayLine', 'f32');
        const fresh = new Float32Array(88200);
        if (old) fresh.set(old.subarray(0, Math.min(old.length, fresh.length)));
        helpers.writeBuffer('delayLine', 'f32', fresh);
      },
    },
  ]);

  return { process: () => { /* ... */ } };
});
```

Each entry's `from` and `to` are schema hashes emitted by `unworklet build` into `dist/schema-hash.json` (see `07-tooling.md`). The framework constructs a directed graph from the entries and finds the path `blob.schemaHash → currentSchemaHash`; entries are applied in order, with each step's output hash verified against its declared `to`.

#### 8.3.1 `helpers` API

```typescript
type MigrationHelpers = {
  // Read from old blob.
  parseSlot:   <T extends ScalarType>(blob: Uint8Array, name: string, type: T) => ScalarOf<T> | undefined;
  parseBuffer: <T extends ScalarType>(blob: Uint8Array, name: string, type: T) => TypedArrayOf<T> | undefined;
  parseParam:  (blob: Uint8Array, name: string) => number | undefined;

  // Profile-scoped read (used when migrating across profile renames).
  parseSlotInProfile: <T extends ScalarType>(blob: Uint8Array, name: string, type: T, profile: string) => ScalarOf<T> | undefined;

  // Write into the migration's output blob (= new schema's slot layout).
  writeSlot:   <T extends ScalarType>(name: string, type: T, value: ScalarOf<T>) => void;
  writeBuffer: <T extends ScalarType>(name: string, type: T, data: TypedArrayOf<T>) => void;
  writeParam:  (name: string, value: number) => void;

  // Profile-scoped write.
  writeSlotInProfile: <T extends ScalarType>(name: string, type: T, value: ScalarOf<T>, profile: string) => void;

  // Metadata about the input blob.
  oldSchemaHash:  string;
  oldProfileName: string | null;
};
```

Slots not written by `migrate` are auto-carried from the old blob to the new blob whenever a slot of the same name and compatible type exists in the new schema. **Most migration entries are short** — only the slots that actually change need explicit handling.

#### 8.3.2 Compile-time validation

The migration array is validated at build time:

- `from` / `to` hash format (lower-case hex, fixed length).
- No duplicate `from` values; no cycles; no self-loops.
- The current schema hash must be reachable from at least one entry's `from` chain.

If the current schema is unreachable (i.e. the developer changed the schema but did not write a migration), the build emits a **warning by default** — name-match partial restore (§8.3.3) covers many cases without explicit migration. Pass `{ strict: true }` to `migrations()` to elevate this to an error.

#### 8.3.3 Restore-time fallback

When `restore(blob)` runs:

1. If the blob's schema hash matches the current hash, slots are written back directly.
2. If not, the framework searches the migration graph for a path `blob.schemaHash → currentSchemaHash`. If found, migrations are applied in order with hash verification at each step.
3. If no migration path exists (or a step's hash check fails), the framework falls back to **name-match partial restore**: slots that share name and compatible type with the new schema are written back; the rest are reset to declaration defaults.

The result of `restore(blob)` reports `{ restored, skipped, missing }` so the consumer can surface "preset partially loaded" UX (see `05-client.md` §2.6 / §6).

Authoritative rationale and rejected alternatives: see `decisions-log.md` Q5.
