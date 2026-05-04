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

TBD — settled by Q2-b.

### 5.6 L2 surface details

TBD — settled by Q2-c.

## 6. The two phases

<!-- `process(({ inputs, outputs, params, ctx })) => sample => ...` shape;
     `publish(({ state, emit, every }))` shape;
     scheduling and constraints of each. -->
