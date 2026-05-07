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
num(value)                                          // chain-entry helper (see below)
flushDenormals(node)                                // FTZ guard
```

## Chain methods on Node values

Every `Node<T>` value carries the same operations as method calls — capture
mode and interp mode behave identically. Both styles below produce the
same captured AST and same numeric result:

```ts
// chain: reads in DSP-flow order (input → operation → operation)
out.left.set(i, main.left.at(i).sub(z.load()).mul(k).add(z.load()));

// free function: equivalent
out.set(0, i, add(z.load(), mul(k, sub(main.at(0, i), z.load()))));
```

Per-type method surface:

| Type | Methods |
| --- | --- |
| `f32`, `f64` | `add` `sub` `mul` `div` `mod` `neg` `min` `max` `abs` `clamp` `eq` `ne` `lt` `gt` `lte` `gte` `sin` `cos` `tan` `tanh` `exp` `log` `sqrt` `floor` `ceil` `frac` `toF32` `toF64` `toI32` `toI64` |
| `i32`, `i64` | same as `f32` minus the math methods (`sin`, `cos`, ...) |
| `bool` | `eq` `ne` |
| `f32x4` (SIMD) | `add` `sub` `mul` `div` `lane(0..3)` |

Methods explicitly NOT provided — these are 3-arg or treatment ops, kept
as free functions only:

- `select(cond, a, b)` — 3-arg, no natural receiver
- `flushDenormals(x)` — guard / treatment, not a math op

### `num(v)` — chain-entry helper

JS literals can't have methods (you can't write `1.sub(m)`). `num(v)`
lifts a JS number / boolean into a graph node so the chain can start
from a literal:

```ts
// (1 - mix) × dry + mix × wet
const y = num(1).sub(mix).mul(dry).add(mix.mul(wet));

// 0.5 + 0.5 × cos(theta)  — half-cosine window
const win = num(0.5).add(theta.cos().mul(0.5));
```

For type-explicit literal wrapping (when you need `f64` / `i32` / `i64`
specifically) use `f64(1)` / `i32(1)` / `i64(1)` directly — they're
the existing type conversion helpers.

### Hybrid policy

Recommended in docs / examples: chain when input flows through
processing, free function for literal-leading expressions (use `num` to
wrap), `select`, and `flushDenormals`. Either style works everywhere;
mix per line based on what reads best.

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
