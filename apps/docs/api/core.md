# @unworklet/core

The DSL surface. Captured at compile time, lowered to WASM.

## Top-level

```ts
defineProcessor(body, options?)
defineSubgraph(body)
```

The body receives a `ProcessorContext`:

```ts
interface ProcessorContext {
  readonly sampleRate: number;
  readonly renderQuantum: number;
  /** ms → integer sample count at this sample rate. */
  samples(ms: number): number;
  /** MIDI note → frequency in Hz (A4 = 440, MIDI 69). */
  hz(midiNote: number): number;
}
```

## Declarations

```ts
state.f32(initial, options?)   state.i32(...)   state.bool(...)   state.f64(...)   state.i64(...)
buffer.f32({ size, name, snapshot?, publish? })   buffer.i32(...)   buffer.f64(...)
param({ name, default, min, max, automationRate, unit?, snapshot? })
audioInput({ name, channels })       // .at(c, i); when channels === 2 also exposes .left.at(i) / .right.at(i)
audioOutput({ name, channels })      // .set(c, i, v); when channels === 2 also exposes .left.set(i, v) / .right.set(i, v)
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
