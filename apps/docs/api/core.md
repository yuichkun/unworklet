# @unworklet/core

The DSL surface. Captured at compile time, lowered to WASM.

## Top-level

```ts
defineProcessor(body, options?)
defineSubgraph(body)
```

## Declarations

```ts
state.f32(initial, options?)   state.i32(...)   state.bool(...)   state.f64(...)   state.i64(...)
buffer.f32({ size, name, snapshot?, publish? })   buffer.i32(...)   buffer.f64(...)
param({ name, default, min, max, automationRate, unit?, snapshot? })
audioInput({ name, channels })
audioOutput({ name, channels })
event<T>({ name, capacity? })
message<T>({ name, capacity?, payload? })
midiInput({ name?, capacity? })
midiOutput({ name?, capacity? })
```

## Control flow

```ts
forSample((i: Node<'i32'>) => void)
forSample.byN(stride, (i) => void)
everyNSamples(N, () => void)  // inside forSample only
```

## Arithmetic / math primitives

```ts
add, sub, mul, div, mod, neg, min, max, abs, clamp
eq, ne, lt, gt, lte, gte
sin, cos, tan, tanh, exp, log, sqrt, floor, ceil, frac
select(cond, ifTrue, ifFalse)
f32(node), f64(node), i32(node), i64(node)        // type conversions
flushDenormals(node)                              // FTZ guard
```

## Snapshot policy

```ts
snapshot: 'persistent' | 'transient' | { [profile: string]: 'persistent' | 'transient' }
```

## Per-slot publish

```ts
publish: { rateFps: number }   // on state.<type>(...) or buffer.f32({ ..., publish }).
```

## See also

- [@unworklet/core/simd](./simd) — SIMD primitives.
- [@unworklet/dsp](./dsp) — `/precise` + `/table` math variants.
- [@unworklet/client](./client) — JS-engine `createNode` + `renderOffline`.
- [@unworklet/worklet](./worklet) — browser-side `createWasmNode`.
