# 01 — DSL (`@unworklet/core` + `@unworklet/dsp`)

The surface the user authors against. Defines `defineProcessor`, primitives, declarations (`state`, `buffer`, `param`), and authoring patterns for reusable DSP blocks.

## Status

skeleton

## 1. `defineProcessor` and I/O declarations

<!-- defineProcessor(config) shape, audioInput / audioOutput, `inputs` and `outputs` records.
     Q5 (multi-output processors) — explicit support, schema rules. Lands here. -->

## 2. Primitive operators

<!-- Full inventory: arithmetic (add/sub/mul/div/mod/neg), comparison (eq/lt/gt/lte/gte),
     math (sin/cos/tan/tanh/exp/log/sqrt/abs/floor/ceil/frac/min/max/clamp),
     control (select), memory (load/store/readBuffer/writeBuffer/readBufferInterpolated),
     type conversions (f32/f64/i32/i64).
     Q14 (math precision: default vs `/precise` vs `/table` import paths). Lands here. -->

## 3. State, buffer, param declarations

<!-- state.f32 / state.f64 / state.i32 / state.i64 / state.bool: load() / store(node);
     buffer.* with size + name; access via readBuffer / writeBuffer / readBufferInterpolated;
     param({ default, min, max, automationRate, unit? }): .at(i) access. -->

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

TBD — settled by Q2-c.

## 6. The two phases

<!-- `process(({ inputs, outputs, params, ctx })) => sample => ...` shape;
     `publish(({ state, emit, every }))` shape;
     scheduling and constraints of each. -->
