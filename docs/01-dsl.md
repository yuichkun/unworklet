# 01 — DSL (`@unworklet/core`)

The surface the user authors against. Defines `defineProcessor`, primitives, declarations (`state`, `buffer`, `param`), the `forSample` per-sample loop primitive, and authoring patterns for reusable DSP blocks.

## Status

written

## 1. `defineProcessor`, the process body, and I/O declarations

`defineProcessor` is the entry point. The body is a single lambda that runs once at build time (see `00-foundations.md` §3 for the meta-program semantics) — declarations come first; a `process` lambda is returned in the result record.

```typescript
defineProcessor<C>(
  body:     (ctx: ProcessorContext) => ProcessorBody,
  options?: ProcessorOptions,
): CompiledProcessor<C>;

type ProcessorOptions = {
  migrations?:       Migration[];   // see §8.3
  migrationsStrict?: boolean;       // see §8.3.2; default false (= warning, not error)
};
```

The second argument is the **options bag** — host of `migrations` (§8.3) and `migrationsStrict` (§8.3.2). All fields are optional; processors that do not need schema migration omit the bag entirely. Future processor-level configuration lands on this same bag additively.

A `process` body has **two kinds of code distinguished by lexical position**:

- **Per-block code** — statements at the top level of the `process` body. Run once at the start of every render quantum on the audio thread.
- **Per-sample code** — statements inside a `forSample(callback)` or `forSample.byN(stride, callback)` invocation. The callback body runs once per sample (or once per `stride` samples) of the render quantum.

The body is read **top-to-bottom**: each statement (whether direct per-block code or a `forSample` invocation) executes in declared (source) order. Per-block code can interleave freely with `forSample` invocations — per-block setup → per-sample work → more per-block code → another `forSample` → … — all valid.

**Handler registrations are an exception to source order at runtime.** `messageDecl.onReceive(handler)` and `midiInput().onEvent(type, handler)` registrations placed anywhere in the `process` body always run at block-boundary drain, **before** any per-block top-level statement or `forSample` invocation (Q38-b). Source order in the body controls graph-capture-time registration order (= multiple `onReceive` registrations for the same message run in registration order at drain); it does not control where handlers fire relative to per-block / per-sample code. See §4.2 + `02-messaging.md` §1 + `11-midi.md` §2.3 for the unified drain rule.

Sample-offset primitives (`audioIn.at(c, i)`, `audioOut.set(c, i, v)`, `param.at(i)`) take an `i: Node<'i32'> | number`. A `Node<'i32'>` `i` originates from a `forSample` callback parameter and is in scope only inside that callback — using it outside is a TypeScript reference error. JS-literal sample-offsets (the most common being `0`) lift to `Node<'i32'>` per Q36-a and are accepted everywhere the primitives appear: `param.at(0)` reads the block-start param value, `audioIn.at(c, 0)` reads the block-start input sample, `audioOut.set(c, 0, v)` writes the block-start output sample (Q51). JS-literal offsets must fall within `[0, SAMPLES_PER_BLOCK - 1]` (= `0`〜`127`); offsets outside this range fail at graph-capture time with `error[unworklet/audio-sample-offset-out-of-range]` (Q68). This keeps the mental model identical to JUCE's `AudioProcessor::processBlock` and AudioWorklet's `process` — the body runs top-to-bottom, any sample-offset primitive can be called at any point, and `forSample` is purely a loop construct over the block (write the same output multiple times, last write wins per Q37; read any input sample at any point). There is no sugar form; every per-sample access uses `at` / `set` / `param.at(...)`.

```typescript
// Per-sample-only plugin (one forSample, no per-block code):
const gain = defineProcessor((ctx) => {
  const main = audioInput ({ channels: 2, name: 'main' });
  const out  = audioOutput({ channels: 2, name: 'main' });
  const g    = param({ default: 1.0, ..., automationRate: 'a-rate', name: 'gain' });

  return {
    process: () => {
      forSample((i) => {
        out.set(0, i, mul(main.at(0, i), g.at(i)));
        out.set(1, i, mul(main.at(1, i), g.at(i)));
      });
    },
  };
});

// Mixed per-block + per-sample plugin (interleaved per-block and per-sample code):
const partitionedReverb = defineProcessor((ctx) => {
  const main       = audioInput ({ channels: 1, name: 'main' });
  const out        = audioOutput({ channels: 1, name: 'main' });
  const inBuf      = buffer.f32({ size: SAMPLES_PER_BLOCK, name: 'inBuf'  });
  const outBuf     = buffer.f32({ size: SAMPLES_PER_BLOCK, name: 'outBuf' });
  const partIdx    = state.i32(0, { name: 'partIdx' });
  const NUM_PARTITIONS = 8;

  return {
    process: () => {
      // Per-block code: advance partition pointer, run partitioned FFT setup.
      const idx = partIdx.load();
      partIdx.store(mod(add(idx, 1), NUM_PARTITIONS));
      // ... partitioned FFT computation ...

      // Per-sample code: shovel input into inBuf, drain outBuf to output.
      forSample((i) => {
        inBuf.write(i, main.at(0, i));
        out.set(0, i, outBuf.read(i));
      });
    },
  };
});
```

Authoritative rationale and rejected alternatives: see `decisions-log.md` Q22 (Q22-aprime / Q22-b).

### 1.1 `audioInput` and `audioOutput`

Both helpers live in declaration scope only. Calling them inside a `process` body, a `forSample` callback, or any other expression scope is a graph-capture-time error.

```typescript
audioInput <C extends number>(options: { channels: C, name: string }): AudioInputHandle<C>;
audioOutput<C extends number>(options: { channels: C, name: string }): AudioOutputHandle<C>;
```

Options:

- **`channels: number`** — fixed channel count, set at compile time. Maps directly to Web Audio's `outputChannelCount[i]` for outputs and is the input-side expectation for `at`.
- **`name: string`** — required. Used as the key in main-thread `node.inputs.<name>` / `node.outputs.<name>` access (see `05-client.md` §1) and as the slot identity for that I/O port. There is no default; explicit naming is uniform with `state` / `buffer` / `param` `name` and avoids index-based mental models in tooling and main-thread code.

The returned handles expose sample-offset primitives (`at` / `set`); the sample-offset argument is `Node<'i32'> | number` per the type signatures (§1.2 / §1.3). The `Node<'i32'>` form binds the surrounding `forSample` callback's loop counter `i`; JS-literal offsets (Q36-a) work at any lexical position, including the per-block top level (Q51 — e.g. `audioIn.at(0, 0)` reads the block-start input sample).

### 1.2 Reading audio inputs

`AudioInputHandle<C>` exposes one method:

```typescript
type AudioInputHandle<C extends number> = {
  at(c: ChannelIndex<C> | number, i: Node<'i32'> | number): Node<'f32'>;
  channels: C;
  name:     string;
};

// `ChannelIndex<C>` is the union `0 | 1 | ... | (C - 1)`, narrowed by TypeScript
// from the literal `channels: C` declared on the handle. Out-of-range indices are
// TS errors at the call site.
```

`audioIn.at(c, i)` returns the channel-`c` value at sample-offset `i` within the current render quantum. The `i` argument accepts `Node<'i32'> | number` (Q36-a): a `Node<'i32'>` originates from a `forSample` callback parameter (= per-sample loop counter), and a JS-literal sample-offset (e.g. `0`) lifts to `Node<'i32'>` and is accepted at any lexical position including per-block top level (Q51 — `audioIn.at(c, 0)` reads the block-start input sample). JS-literal offsets must fall within `[0, SAMPLES_PER_BLOCK - 1]`; out-of-range literals are graph-capture-time errors with stable ID `audio-sample-offset-out-of-range` (Q68).

> Naming note: in prose, `audioIn` / `audioOut` refer to the user's declared `audioInput` / `audioOutput` handles (named by the user via the required `name` option — e.g. `const main = audioInput({ channels: 2, name: 'main' })`). They are not framework-provided globals; the prose name is a placeholder for whatever variable the author bound the declaration to.

The channel index `c` is narrowed by TypeScript to the legal range for the declared channel count (`channels: 2` → `0 | 1`); out-of-range indices are TypeScript errors at the call site.

```typescript
const stereo = audioInput({ channels: 2, name: 'main' });

forSample((i) => {
  const l = stereo.at(0, i);     // Node<'f32'>, channel 0 at sample-offset i
  const r = stereo.at(1, i);     // Node<'f32'>, channel 1 at sample-offset i
  const x = stereo.at(2, i);     // ❌ Type error: 2 is not assignable to 0 | 1
});

// Outside any forSample, `i` is not in scope:
const y = stereo.at(0, i);       // ❌ Type error: i is undefined
```

The actual channel count of the connected source is normalized by Web Audio's standard up-mix / down-mix rules (`channelInterpretation`, `channelCountMode`) before the worklet sees it; the framework does not intervene in this layer.

### 1.3 Writing audio outputs

`AudioOutputHandle<C>` exposes one method:

```typescript
type AudioOutputHandle<C extends number> = {
  set(c: ChannelIndex<C> | number, i: Node<'i32'> | number, v: Node<'f32'> | number): void;
  channels: C;
  name:     string;
};
```

`audioOut.set(c, i, v)` writes value `v` to channel `c` at sample-offset `i`. Both `c` and `i` follow the same scoping and narrowing rules as `at`.

```typescript
const stereoOut = audioOutput({ channels: 2, name: 'main' });

forSample((i) => {
  stereoOut.set(0, i, leftNode);             // ✓
  stereoOut.set(1, i, rightNode);            // ✓
  stereoOut.set(2, i, extraNode);            // ❌ Type error: 2 not assignable to 0 | 1
});
```

`audioOut.set(c, i, v)` follows the same mental model as the AudioWorklet `process(inputs, outputs)` and JUCE `processBlock` host environments: **write freely, no coverage requirement, no exactly-once constraint** (Q37, `decisions-log.md`):

- Writing the same `(c, i)` multiple times is legal; source-order semantics apply (the later write wins).
- Sample-offsets that no `forSample` writes are emitted as silence (= 0) — this matches AudioWorklet's per-callback zero-init of the output buffer.
- A processor with multiple `forSample` loops may split channels across loops (e.g. left in loop 1, right in loop 2), overwrite previously written values for mix-in patterns, or leave portions of the buffer silent — all are legal.

Static analysis enforces only the real-time-safety invariants listed in `03-compiler.md` §2.4 (no unbounded loops, no dynamic allocation, no out-of-block sample-offset arithmetic, no illegal `forSample.byN` strides). Coverage of the render quantum is the author's responsibility.

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

This is intentional: a single declaration pattern across all processor sizes (minimal sine generator → multi-band splitter) keeps the mental model uniform with `state` / `buffer` / `param`. The few extra lines on the smallest example are paid back the moment the processor grows.

```typescript
const sin440 = defineProcessor((ctx) => {
  const out   = audioOutput({ channels: 1, name: 'main' });
  const phase = state.f32(0, { name: 'phase' });
  const inc   = 2 * Math.PI * 440 / ctx.sampleRate;          // build-time JS constant
  return {
    process: () => {
      forSample((i) => {
        phase.store(add(phase.load(), inc));
        out.set(0, i, sin(phase.load()));
      });
    },
  };
});
```

### 1.6 Main-thread access

The compiled `UnworkletNode<C>` exposes `node.inputs.<name>` and `node.outputs.<name>` typed accessors that wrap the underlying `AudioWorkletNode`'s indexed `connect()` calls. The raw `AudioWorkletNode` is always reachable as `node.node` for graph topologies the typed surface does not cover. See `05-client.md` §1 for the full main-thread surface.

Authoritative rationale and rejected alternatives: see `decisions-log.md` Q6 (declaration shape) and Q22 (single form for sample-offset primitives).

### 1.6.1 Public TypeScript types

Handle types for every declaration kind are exported from `@unworklet/core` for use in helper / subgraph signatures and main-side typing:

- `AudioInputHandle<C>` / `AudioOutputHandle<C>` (§1.2 / §1.3)
- `State<T>` / `Buffer<T>` / `Param` (§3)
- `EventDecl<T>` / `MessageDecl<T>` (§4)
- `MidiInputHandle` / `MidiOutputHandle` (`11-midi.md` §2)
- `Node<T>` (§2)

The value returned by `createSubgraph(...)` is **the subgraph body's return record itself** (= the author-named methods declared by `defineSubgraph`'s body) — no separate `SubgraphInstance<S>` wrapper type is exported. When a helper signature needs to receive a subgraph instance, use `ReturnType<typeof subgraphDecl>` (TypeScript's standard inference). Authoritative rationale: `decisions-log.md` Q54.

L1 helper signatures and main-side type annotations import these directly (see canonical Ex 2 and Ex 4 for examples).

### 1.7 Build-time constants

The package exports build-time constants at the top level, alongside `defineProcessor` and the primitive operators:

- **`SAMPLES_PER_BLOCK: 128`** — the render quantum length in samples. Web Audio specifies 128 samples per quantum across all environments; this value is fixed at build time. Used wherever processor code needs to refer to the block length by name rather than by the literal `128`.

  ```typescript
  import { defineProcessor, buffer, forSample, SAMPLES_PER_BLOCK } from '@unworklet/core';

  defineProcessor(() => {
    const scratch = buffer.f32({ size: SAMPLES_PER_BLOCK, name: 'scratch' });

    return {
      process: () => {
        forSample((i) => {
          // i runs 0 .. SAMPLES_PER_BLOCK - 1
        });
      },
    };
  });
  ```

  `SAMPLES_PER_BLOCK` is also usable in build-time JS contexts outside `defineProcessor`, such as in helper modules where `ctx` is not in scope:

  ```typescript
  // helpers.ts
  import { SAMPLES_PER_BLOCK } from '@unworklet/core';

  export const RING_CAP = SAMPLES_PER_BLOCK * 8;  // 1024
  export const blockToMs = (sampleRate: number) => SAMPLES_PER_BLOCK * 1000 / sampleRate;
  ```

These constants are not exposed on the `ctx` object. `ctx` carries run-time values supplied by the host (e.g. `ctx.sampleRate`, which varies per `AudioContext`); build-time constants are kept off `ctx` so the two categories stay distinct.

Authoritative rationale and rejected alternatives: see `decisions-log.md` Q35.

## 2. Primitive operators

Primitive operators are pure functions over `Node<T>` values. Each primitive's argument positions accept either a `Node<T>` or a JS `number` / `boolean` literal that lifts to `Node<T>` according to the **context-dependent literal lift rule** (see `00-foundations.md` §4 + `decisions-log.md` Q1 + Q33 + Q36):

- A literal in a primitive-argument position lifts to `Node<T>`, where `T` is inferred from sibling arguments
- A literal in a **method argument position** also lifts: if the method's declared argument type is `Node<X>`, a JS literal in that position lifts to `Node<X>` (Q36-a). Covers `param.at(0)`, `samples.at(s)`, `emitIf(true, ...)`, `audioIn.at(0, i)`, `buf.read(idx)`, etc.
- All-literal primitive calls fall back to `T = 'f32'`
- Implicit lift covers `'f32'` / `'f64'` / `'i32'` / `'bool'`. `'i64'` requires the explicit `i64(BigInt(...))` constructor
- Range constraints not expressible in TS (integer-only, non-negative, channel-index upper bound, etc.) are enforced at graph-capture time

### 2.1 Inventory

- **Arithmetic** (generic over `T extends 'f32' | 'f64' | 'i32' | 'i64'`): `add`, `sub`, `mul`, `div`, `mod`, `neg`
- **Comparison** (generic over `T`, returns `Node<'bool'>`): `eq`, `lt`, `gt`, `lte`, `gte`
- **Math** (`Node<'f32'>` or `Node<'f64'>`): `sin`, `cos`, `tan`, `tanh`, `exp`, `log`, `sqrt`, `abs`, `floor`, `ceil`, `frac`, `min`, `max`, `clamp`
- **Control**: `select(cond: Node<'bool'>, then: Node<T>, else_: Node<T>): Node<T>` (generic over `T`)
- **Memory**: `load` / `store` on `State<T>`; `.read` / `.write` / `.readInterpolated` / `.copyFrom` / `.loadVec` / `.storeVec` as methods on `Buffer<T>` (see §3.2 and §7). `loadVec` / `storeVec` are SIMD-only and exist on the buffer handle, not on `audioOutput`.

Math-precision strategy (Q17, `decisions-log.md`): the `@unworklet/core` import path ships **polynomial approximations** (5–7th-order minimax) for every math primitive listed above. All approximations are emitted as WASM functions and run entirely inside the WASM module — there is no FFI / JS-WASM boundary crossing per call, so per-sample use stays realtime-safe. Maximum approximation error is on the order of `1e-4`, inaudible within audio's 24-bit dynamic range. Numerical-analysis use cases (where IEEE-754-faithful math matters) are outside unworklet's scope. v1.x.0 may additively introduce `@unworklet/core/precise` (WASM-bundled libm, std-math-equivalent precision) and `@unworklet/core/table` (precomputed lookup, even faster) import paths.

### 2.2 Scalar constructors

Five scalar constructors lift JS values to `Node<T>` explicitly. Used wherever the implicit lift does not apply — declarations, ambiguous-call disambiguation, i64 construction, and cross-precision conversion between `Node` types:

```typescript
f32(v: number): Node<'f32'>;
f64(v: number): Node<'f64'>;
i32(v: number): Node<'i32'>;
i64(v: bigint): Node<'i64'>;
bool(v: boolean): Node<'bool'>;
```

```typescript
// Declaration (= outside primitive arguments, implicit lift not available):
let count = i32(0);
let mix   = f32(0);
const def = bool(false);

// Ambiguous-call disambiguation (all-literal call would default to f32):
add(i32(0), i32(0))     // T = 'i32' fixed

// i64: BigInt-required (no implicit lift):
add(state.i64.load(), i64(BigInt(123)))

// Cross-precision conversion between Node types:
const wide   = f64(f32node);
const narrow = f32(f64node);
const idx    = i32(f32node);    // truncate
```

Constructor naming follows GLSL (`vec3(0.0)` / `float(0)`) and WGSL (`f32(0)`) convention.

Authoritative rationale and rejected alternatives: `decisions-log.md` Q33.

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

State is sample-offset-independent: the `state` reference itself does not depend on the surrounding context. `load()` returns the value as updated by the most recent `store()`. State updates inside `forSample` callbacks are observable in subsequent samples in the same render quantum and in subsequent render quanta. State updates at per-block top level are observable for the rest of that render quantum and beyond. State load/store at per-block top level **after** a `forSample` invocation can observe the state's value at the end of the loop — useful for block-level summaries (peak detect, accumulator readout, etc.).

Options:

- **`name?: string`** — slot identity. Required when the parent processor calls `snapshot()` (graph-capture-time error otherwise). Used as the slot key in snapshot blobs.
- **`snapshot?: 'persistent' | 'transient' | { [profile: string]: 'persistent' | 'transient' }`** — snapshot inclusion. Default is `'persistent'`. See §8.2.
- **`publish?: { rateFps: number }`** — when set, the framework periodically copies the current slot value into a shared region readable from the main thread via `node.state.<name>.subscribe(handler)` or `.value`. Default omitted (= not published). The slot remains worklet-private for writes regardless of this option; main observes a snapshot at copy time.

  **Type restriction (Q42, `decisions-log.md`)**: `publish` is accepted only on `state.f32` / `state.i32` / `state.bool` — all three are 32 bit single-word slots that audio thread and main can read/write in a single `Atomics` op (no torn reads). `state.f64` / `state.i64` reject the `publish` option at TypeScript level; their values span two 32-bit words and require a torn-read mitigation that is deferred to v1.x.0 (same axis as Q27-f). Use `f32` as a substitute when possible.

  `state.bool` is represented internally as `i32` (0 / 1); the audio thread stores `cond ? 1 : 0` via `Atomics.store`, and the main side casts back to `boolean` when delivering to subscribers (so `node.state.<name>.value` is typed `boolean`).

  Authoritative rationale: `decisions-log.md` Q27-a + Q42.

### 3.2 `buffer` — fixed-size arrays

```typescript
const ring     = buffer.f32({ size: 44100, name: 'delayLine' });                          // default 'transient'
const wave     = buffer.f32({ size: 256,   name: 'wavetable', snapshot: 'persistent' });  // explicit include
const sysexBuf = buffer.u8 ({ size: 64,    name: 'sysexBuf' });                           // byte buffer (= sysex emit; see 11-midi.md §2.5)
```

The element-type factory exposes `buffer.f32` / `buffer.f64` / `buffer.i32` / `buffer.i64` / `buffer.bool` / `buffer.u8`. The `'u8'` variant exists specifically for sysex emission (Q49) — byte values are written and read through `Node<'i32'>` (the lower 8 bits are stored), so no separate `Node<'u8'>` type is introduced into the scalar type system.

Access goes through methods on the `Buffer<T>` handle (`buf.read(idx)`, `buf.write(idx, v)`, `buf.readInterpolated(pos)`, `buf.copyFrom(src)`); bounds and interpolation behavior are explicit at each call site. The index argument type is `Node<'i32'> | number` (Q36-a, `decisions-log.md`) — this can be a ring-buffer write head from a `state.i32` slot (per-block or per-sample), the loop counter `i` of a surrounding `forSample` (per-sample), any computed `Node<'i32'>` value, or a JS literal that lifts to `Node<'i32'>`. Range constraints (non-negative, within capacity) are enforced at graph capture.

For bulk transfer from a `message<T>` / `event<T>` payload (e.g. uploading a sample buffer or IR), use `buf.copyFrom(payloadField)`: the framework emits a single WASM `memory.copy` instruction, runtime-clamped to `min(buf.size, src.length)`. This is the canonical replacement for per-sample loops driven by payload length, which would violate the realtime-safety invariant (see `decisions-log.md` Q31).

The `Buffer<T>` handle returned by `buffer.<T>(...)` exposes the following methods (these are part of the handle type, not free function imports):

```typescript
type Buffer<T extends ScalarType | 'u8'> = {
  read(idx: Node<'i32'> | number): Node<T>;
  write(idx: Node<'i32'> | number, v: Node<T> | number): void;
  readInterpolated(pos: Node<'f32'> | number): Node<T>;
  // Bulk copy from a typed-array field of the surrounding message / event payload (see §4).
  // Compiles to a single WASM `memory.copy`; runtime length is clamped to min(buf.size, src.length).
  // See `decisions-log.md` Q31-c.
  copyFrom(src: TypedArrayFieldRef<T>): void;
  // SIMD methods (only typed when `@unworklet/core/simd` is imported — see §7):
  loadVec(offset: Node<'i32'>): Node<'f32x4'>;
  storeVec(offset: Node<'i32'>, value: Node<'f32x4'>): void;
  size: number;
  name: string;
};
```

Options:

- **`size: number`** — element count, fixed at compile time. The buffer occupies `size × sizeof(type)` bytes in linear memory.
- **`name?: string`** — slot identity (same rules as `state`).
- **`snapshot?: 'persistent' | 'transient' | { ... }`** — default is `'transient'`. Most buffers are accumulation regions (delay lines, scratch buffers) whose contents lose meaning across preset boundaries; include explicitly when the contents *are* the slot's identity (wavetables, lookup tables).
- **`publish?: { rateFps: number }`** — same shape as `state.publish`. The framework copies the buffer region into a shared region every publish tick; main thread reads via `node.state.<name>.subscribe(handler)` (handler receives the typed array view) or `.value`. Used for continuous large data (waveform display, spectrum frame). See `decisions-log.md` Q27-a / Q27-e.

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

`param()` declares a slot bound to the standard Web Audio `AudioParam`. There is **one access method**: `param.at(i)`.

```typescript
// Inside a forSample callback (per-sample code): use the loop counter `i`.
forSample((i) => {
  const v = cutoff.at(i);          // Node<'f32'>, value at sample-offset i
});

// At per-block top level: use 0 (block-start sample).
const blockValue = cutoff.at(0);   // Node<'f32'>, block-start value
                                   // For k-rate params this is the unique block value;
                                   // for a-rate params it is the first-sample value.
```

`param.at(i: Node<'i32'> | number)` returns the value at sample-offset `i` within the current render quantum. Used inside `forSample` (`i` is the callback's `Node<'i32'>`) it returns the per-sample value (a-rate: per-sample interpolated; k-rate: the unique block value). Used at per-block top level with the JS literal `0` (which lifts to `Node<'i32'>` per Q36-a, `decisions-log.md`) it returns the block-start value, which is what k-rate consumers want and what most per-block computations involving a-rate params should treat as their representative value.

There is **no callable `param()` form** and **no `param.value` / `param.now()` property**. The single explicit method makes the sample-offset visible at every call.

Options:

- **`default`, `min`, `max`** — initial value and clamp range.
- **`automationRate: 'a-rate' | 'k-rate'`** — Web Audio automation rate.
- **`unit?: string`** — display hint passed through to `AudioParamDescriptor` metadata.
- **`name?: string`** — slot identity.
- **`snapshot?: 'persistent' | 'transient' | { ... }`** — default is `'persistent'` (param values are typically the user-controlled state of a preset). Snapshots include only the **current value**; AudioParam automation queues (`setValueAtTime`, `linearRampToValueAtTime`, etc.) are not preserved.

Authoritative rationale for the snapshot defaults: `decisions-log.md` Q5 (Q5-b). Authoritative rationale for the single form (no sugar): `decisions-log.md` Q22 (Q22-b).

## 4. Messages and events declarations

The two declaration kinds `event<T>` (worklet → main, sample-accurate) and `message<T>` (main → worklet, coarse-grained) share an authoring shape. Both are declared at declaration scope and consumed inside the `process` body. Wire-level transport, queue policy, and SAB-vs-postMessage handling live in `02-messaging.md`; this section covers only the DSL surface.

### 4.1 `event<T>` — worklet to main

```typescript
const peakEvt = event<{ level: number }>({ name: 'peak' });
const noteFired = event<{ note: number; velocity: number }>({ name: 'noteFired', capacity: CAPACITY_512 });
```

`event<T>(options): EventDecl<T>` declares a typed worklet → main event channel. The payload type `T` is user-defined; an `atSample` field is **always carried on the wire** alongside `T` (mirroring MIDI Q4-c). Emission is via the `emitIf` method on the event handle (`eventDecl.emitIf(cond, payload)`) from any expression context where the audio-thread graph is captured — `forSample` / `forSample.byN` callbacks, `everyNSamples` callbacks (taken from the surrounding `forSample` callback's second argument; see §9 and Q43), `messageDecl.onReceive(...)` and `midiInput().onEvent(...)` handler bodies, and the per-block top level (statements in the `process` body outside any `forSample`). `emitIf` is the **single emission primitive**; there is no plain `emit(...)` form.

`event<T>` mirrors MIDI in offering two TypeScript views of the same payload (Q46): main-side handlers receive `T & { atSample: number }` with plain JS scalars, while the worklet-side `emitIf` accepts the lifted shape (every `number` field becomes `Node<'i32'>`, every `boolean` field becomes `Node<'bool'>`, every `Float32Array` / `Uint8Array` field becomes a typed-array-field proxy per §4.3). Number / boolean literals at the emit call site fold through Q33 literal-lift, so authors write the same literal values they would on main. See `decisions-log.md` Q46.

```typescript
// Inside forSample — cond gates per-sample emission.
forSample((i) => {
  peakEvt.emitIf(gt(abs(audioIn.at(0, i)), thresh.at(i)),
                 { atSample: i, level: audioIn.at(0, i) });
});

// Inside a MIDI / message handler — `emitIf(true, payload)` is the canonical
// form for handler-context unconditional 1:1 projection.
midi.onEvent('noteOn', ({ note, velocity, atSample }) => {
  notePlayed.emitIf(true, { atSample, note, velocity: velocity / 127 });
});
```

The `cond` parameter type is `Node<'bool'> | boolean` (finalized at Q36-c, `decisions-log.md`). A JS `boolean` value (literal or computed) lifts to `Node<'bool'>` per the method-argument literal lift rule (Q36-a). Literal `true` / `false` at the call site folds at graph capture: `emitIf(false, payload)` is dropped from the graph, and `emitIf(true, payload)` records an unconditional emission node. Build-time JS constants (e.g. `const FORCE = true; emitIf(FORCE, payload)`) fold the same way.

**Static-analysis: constant-truthy `cond` inside `forSample` is an error.** A `forSample` callback that contains `emitIf(true, payload)` (or any cond expression that folds to a build-time-constant truthy value) is rejected at WASM-emission time — unconditional emission at audio rate would fill the 256-slot ringbuffer in milliseconds and produce continuous overflow. The error message points at the three honest alternatives: gate with a state-edge expression, move the emission into a handler context, or use `everyNSamples(N, () => emitIf(...))` for periodic sub-rate emission (taken from the surrounding `forSample` callback's second argument — see §9 and Q43). Authoritative wording: `decisions-log.md` Q32-c (uniform with the MIDI Q4-b footgun-elimination rule).

Options:

- **`name: string`** — required. Used as the key for `node.events.<name>` on the main thread.
- **`capacity?: Capacity`** — ringbuffer slot count. Default `CAPACITY_256`, uniform with MIDI Q4-c. The `Capacity` literal-union type (= `typeof CAPACITY_16 | ... | typeof CAPACITY_16384`) is enforced at TypeScript level so arbitrary integer literals are rejected at IDE time (Q44).
- **`payloadCapacity?: number`** — bytes reserved for variable-length payload content (`Float32Array` / `Uint8Array` / etc.). If omitted, the framework derives a default from the largest expected payload × ringbuffer slot count. See §4.3 and `02-messaging.md` §5.

Overflow: drop-oldest + monotonic `overflowCount` counter, exposed as `node.events.<name>.diagnostics.overflowCount()`. Variable-length payload fields (e.g. `Float32Array`) follow §4.3.

### 4.2 `message<T>` — main to worklet

```typescript
const reqReset   = message<void>({ name: 'requestReset' });
const loadPreset = message<{ slot: number }>({ name: 'loadPreset' });
const uploadIR   = message<{ samples: Float32Array }>({ name: 'uploadIR', capacity: CAPACITY_16 });
```

`message<T>(options): MessageDecl<T>` declares a typed main → worklet message channel. The worklet-side handler is registered inside the `process` body at per-block top level via `messageDecl.onReceive(handler)`:

```typescript
return {
  process: () => {
    reqReset.onReceive(() => {
      meterL.store(0);
      meterR.store(0);
    });

    loadPreset.onReceive(({ slot }) => {
      // restore state slots from a built-in preset table
    });

    forSample((i) => {
      // ...
    });
  },
};
```

Handler bodies run at the start of the current render quantum (= worklet author's viewpoint; from main, this is the next quantum after the `node.messages.<name>(...)` call — see Q38-a). At runtime, **all registered handlers (across all messages and MIDI inputs) drain first, before any per-block top-level statement or `forSample` runs** — even though the source order interleaves handler registrations with per-block code. The `process` body's top-to-bottom reading rule (§1) applies to graph capture; at runtime the order is always [handlers] → [per-block statements + forSamples, in source order]. This matches AudioWorklet's `MessagePort.onmessage` behavior (drained before `process` runs) — see Q38-b.

A single message may have **multiple `onReceive` registrations**; all of them run in registration order at the start of the quantum (later registrations do not override earlier ones — Q38-c).

**Handler argument shape (Q46-aligned)**: the worklet-side `onReceive` handler receives `T` in **lifted shape** — every `number` field becomes `Node<'i32'>`, every `boolean` field becomes `Node<'bool'>`, every `Float32Array` / `Uint8Array` / typed-array field becomes the §4.3 typed-array-field proxy. Main-side `node.messages.<name>(payload)` sends the natural JS `T` (plain `number` / `boolean` / typed array); the framework lifts to the graph shape before the handler executes. Same 2-view pattern as `event<T>` (§4.1) and `MidiEvent` / `MidiEventGraph` (Q46 + `11-midi.md` §2.2) — `message<T>` is not a special case.

State observation inside a handler (Q38-d): `state.load()` reads the value at the start of the current quantum (= the value written by the previous quantum's last write). State written by `state.store(v)` inside the handler is observable in the same quantum's per-block computation and `forSample` callbacks (i.e. handlers can stage values for the per-block code that follows).

Inside a handler, the same expression-scope rules apply as in a `forSample` callback (Q56, `decisions-log.md`): primitive operators, `state.load/store`, buffer access, audio I/O via `audioIn.at(c, i)` / `audioOut.set(c, i, v)` / `param.at(i)`, `emitIf`, subgraph methods, and L1 helper calls are all legal. New declarations (`state.*` / `buffer.*` / `param.*` / `createSubgraph(...)`) are not allowed. The surrounding `forSample`'s `i` is not in scope (handlers drain before any `forSample` runs); sample-offset arguments accept `Node<'i32'> | number` from any source — the handler's own `atSample` arg (in MIDI handlers), a state slot value, a buffer read, or a JS literal.

Options:

- **`name: string`** — required. Used as the key for `node.messages.<name>(payload)` on the main thread.
- **`capacity?: Capacity`** — default `CAPACITY_256`. Same overflow semantics and `Capacity` literal-union enforcement as `event<T>` (Q44).
- **`payloadCapacity?: number`** — bytes reserved for variable-length payload content (`Float32Array` / `Uint8Array` / etc.). If omitted, the framework derives a default from the largest expected payload × ringbuffer slot count. See §4.3 and `02-messaging.md` §5.

### 4.3 Variable-length payloads

Both `event<T>` and `message<T>` allow variable-length payload fields (`Float32Array`, `Uint8Array`, etc.) within `T`. The wire format borrows the MIDI sysex pattern (Q4-c): the main slot in the ringbuffer holds the fixed-size header + an index into a separate variable-length content buffer. The size of that content buffer is controlled by the `payloadCapacity` option on the declaration (`event<T>({ name, payloadCapacity })` / `message<T>({ name, payloadCapacity })`), measured in bytes. If omitted, the framework derives a default from the largest expected payload × ring-buffer slot count. Authoritative wire format and capacity policy: `02-messaging.md` §5.

Inside a handler body, the variable-length field is **not** a plain JS typed array — it is exposed as a **typed-array-field proxy** with two methods (Q36-b, `decisions-log.md`):

- `.length: Node<'i32'>` — payload length resolved at graph capture; the actual value is determined at receive time.
- `.at(idx: Node<'i32'> | number): Node<T>` — single-element read. Argument behavior depends on its kind:
  - **JS `number`** — build-time-folded read. The handler body is unrolled per element at graph capture (use this inside a JS `for` loop where the length is known build-time, or with a literal constant).
  - **`Node<'i32'>`** — runtime read. The graph captures a runtime-indexed load against the payload's content buffer.

`T` is the element type of the typed array (`Float32Array` → `Node<'f32'>`, `Uint8Array` → `Node<'i32'>` (zero-extended), etc.).

```typescript
// Argument = Node — runtime-indexed read (e.g. sample player):
uploadSample.onReceive(({ samples }) => {
  const len = samples.length;            // Node<'i32'>
  forSample((i) => {
    const v = samples.at(mod(i, len));   // runtime read
    buf.write(i, v);
  });
});

// Argument = JS number — build-time-folded read (e.g. step sequencer):
loadPattern.onReceive(({ steps }) => {
  for (let s = 0; s < steps.length; s++) {  // ← here `steps.length` is a JS number; see note below
    const v = steps.at(s);
    pattern[s].store(v);
  }
});
```

> Note on `.length` in build-time `for` loops: `samples.length` is normally `Node<'i32'>`. When the message declaration pins the payload length at build time (e.g. fixed-size content), `length` is additionally available as a build-time JS `number` for use in `for` loop bounds. The framework distinguishes these via the declared `capacity` policy in `02-messaging.md` §5.

Bulk transfer of the entire payload into a `buffer.<type>` slot uses `buf.copyFrom(typedArrayField)` (see §3.2), which is the bounded, single-call path. `.at(node)` runtime read is the per-element path; both coexist.

Out-of-range `.at(idx)` reads (idx outside `[0, length)`) are wrapped at graph capture by a `select`-based carrier-clamp so the runtime never traps; documenting the bound at the call site is the author's responsibility.

Authoritative rationale and rejected alternatives: see `decisions-log.md` Q27 (variable-length wire format) and Q36-b (proxy surface).

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

L1 helpers compose freely from both per-block and per-sample contexts. Pure-`Node<T>`-arithmetic helpers (no audio I/O / param access) are sample-offset-agnostic and can be called anywhere.

Helpers that need to access audio I/O or param values from inside their own body should accept `i: Node<'i32'>` as a parameter and use it with the sample-offset primitives — see §5.5.2.

Whether L1 helpers can also write to `state.*` references owned by the caller — and the typing rules for that — is settled in §5.5.

### 5.2 L2 — `defineSubgraph`

A reusable, stateful DSP block. The `defineSubgraph` wrapper has two framework-level roles that pure TypeScript function reuse cannot match:

1. **Identification.** The wrapper marks its result as a subgraph definition, not an inlined helper. Memory-budget tallying for state slots (Q30), DevTools graph viewer instance grouping (Q23), and snapshot path namespacing all hook off this marker.
2. **Name scope for snapshots.** Each `createSubgraph(..., { name: 'lpfL' })` call attaches an instance name (Q41) that becomes the prefix of the snapshot path for every state slot inside that instance (e.g. `'lpfL/z1'`). Without the wrapper, the framework has no canonical place to attach the per-instance name.

The body declares `state.*` / `buffer.*` / `param.*` slots in declaration scope and returns a record of author-named methods (see §5.6.1 for the body shape and §5.6.2 for instantiation). Every instance is inlined into the parent's WASM module per `createSubgraph(...)` call — there is no per-instance function-call boundary at audio rate, and instance state is independent across calls.

Subgraph method bodies execute top-to-bottom in source order — the same mental model as `defineProcessor` `process` bodies (Q51) — and may contain `forSample` callbacks where per-sample iteration is needed. A method invoked from the parent's `forSample` callback runs at the surrounding `i`; one invoked from per-block top level runs once per block. The conventional pattern is for subgraphs that consume per-sample audio to be invoked from inside a `forSample`, since their method inputs are per-sample values.

Why two layers and not one (= L1 helper + L2 subgraph) — see §5.3. Canonical Ex 2 (3-band biquad EQ, 6 `peakingBand` instances) and Ex 8 (poly synth, 8 `synthVoice` instances) exercise the multi-instance reuse where the wrapper's identification + name scope are essential; compare Ex 5's flat voice-slot pattern (= no wrapper, slot names hand-managed) with Ex 8's voice subgraph (= wrapper handles slot allocation and naming).

Instantiation API, parameter declaration rules, and capture-time analysis are settled in §5.6. Authoritative rationale: `decisions-log.md` Q2 (two-layer split) + Q54 (wrapper role + return shape).

### 5.3 Why two layers, not one

Auto-promotion to a subgraph based on the presence of `state.*` calls inside a function body is not part of the surface. Implicit promotion blurs the responsibility boundary between graph capture (`03-compiler.md` §2) and TypeScript type inference: whether a call site is "an inlined expression" or "an instance of a stateful block" would depend on what the function happened to call. Explicit separation gives the static analyzer a clean rule and gives users a clear mental model for what they are authoring.

### 5.4 No L3

unworklet does not provide a "separate processor + connect" integration layer. The Web Audio mechanism — instantiating two `AudioWorkletNode`s and calling `.connect()` on the main thread — covers this case and lives outside unworklet's API surface. Wrapping it would add weight without value.

Rationale and rejected alternatives: see `decisions-log.md` Q2.

### 5.5 L1 surface details

L1 helpers are pure TypeScript functions that compose `Node<T>` values into new `Node<T>` values, inlined at the call site. The following rules govern what such a function can take, return, and contain.

#### 5.5.1 Two scopes (cross-cutting context)

unworklet code lives in two graph-capture-time scopes:

- **Declaration scope** — the body of `defineProcessor` and `defineSubgraph` directly. The 10 declaration kinds canonically listed in `03-compiler.md` §2.6 `scope-violation` are created here: `state.*`, `buffer.*`, `param.*`, `audioInput`, `audioOutput`, `event<T>`, `message<T>`, `midiInput`, `midiOutput`, `createSubgraph(...)`. (`defineSubgraph` itself is a module-level subgraph constructor — not a declaration-scope helper; only `createSubgraph(...)` calls inside a processor body create per-processor instances.) Each declaration registers a slot in the graph (and ultimately a region in WASM linear memory).
- **Expression scope** — the `process` lambda body (per-block top level + `forSample` / `forSample.byN` callbacks); L1 helper bodies; subgraph method bodies; `everyNSamples` callbacks; `messageDecl.onReceive(...)` handler bodies; `midiInput().onEvent(...)` handler bodies (`00-foundations.md` §3 canonical list, 6 contexts). Per-block and per-sample expressions live here. New declarations are forbidden in expression scope.

L1 helpers exist purely in expression scope, callable from either per-block top level or inside a `forSample` callback (depending on what the helper's body does).

(Authoritative scope and graph-capture-model definitions: `00-foundations.md` §3.)

#### 5.5.2 Parameters

L1 helpers can receive:

- `Node<T>` values (the most common case),
- `State<T>` references owned by the caller, including their `load` / `store` methods,
- `Param` references owned by the caller, accessed via `param.at(i)` or `param.at(0)`,
- `AudioInputHandle<C>` / `AudioOutputHandle<C>` references for helpers that perform per-sample I/O,
- `Node<'i32'>` for sample-offset `i` when the helper itself uses sample-offset primitives,
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

A helper that needs to access an `audioInput` or `param` directly takes the sample-offset as a parameter:

```typescript
function envelopeFollow(
  src: AudioInputHandle<2>,
  i:   Node<'i32'>,
  prev: State<'f32'>,
  alpha: Node<'f32'>,
): Node<'f32'> {
  const peak = max(abs(src.at(0, i)), abs(src.at(1, i)));
  const y    = add(prev.load(), mul(alpha, sub(peak, prev.load())));
  prev.store(y);
  return y;
}

// Caller — inside forSample, pass i along.
forSample((i) => {
  const env = envelopeFollow(main, i, prev, alpha);
  // ...
});
```

A pure-arithmetic helper (no audio I/O / param access) takes no `i` parameter and is callable from any expression scope:

```typescript
function softclip(x: Node<'f32'>): Node<'f32'> {
  return tanh(mul(x, 1.5));
}

// Callable from per-block top level (e.g., on a state-load value):
const lastPeak = peakState.load();
const clipped  = softclip(lastPeak);

// Callable from inside forSample on per-sample values:
forSample((i) => {
  audioOut.set(0, i, softclip(audioIn.at(0, i)));
});
```

**Literal lift applies to user-defined L1 helper arguments too** (Q36-a generalized): if an L1 helper declares an argument typed `Node<X>`, a JS literal `number` / `boolean` passed at the call site lifts to `Node<X>` per the same rule that applies to framework primitives (Q33 + Q36-a). The helper author does not need to type the argument as `Node<X> | number` — `Node<X>` alone is sufficient. Example: canonical Ex 4's `envelopeFollow(x, attackCoef, releaseCoef, prev)` accepts `attackCoef: 1.0` (= JS `number` literal) directly even though `attackCoef` is declared `Node<'f32'>`.

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
- New `defineSubgraph(...)` declarations or `createSubgraph(...)` instantiations (Q34, `decisions-log.md`).
- New `audioInput` / `audioOutput` declarations.
- `message` / `event` declarations.

The following are **allowed**:

- Primitive operators (`add`, `mul`, `tanh`, `select`, …).
- `load` / `store` on `State<T>` references received as parameters.
- `param.at(i)` (with `i` from a surrounding `forSample`) or `param.at(0)` (per-block context) on `Param` references received as parameters.
- `audioIn.at(c, i)` / `audioOut.set(c, i, v)` on handles received as parameters (with `i` from a surrounding `forSample`).
- Buffer access methods (`buf.read` / `buf.write` / `buf.readInterpolated`) on buffer references received as parameters.
- Calls to other L1 helpers.
- `forSample(...)` invocations when the helper itself wants to iterate samples (rare; usually iteration is the caller's job and the helper is invoked from inside the caller's `forSample`). When the caller is itself inside a `forSample` and the helper also calls `forSample`, the loops nest — the inner loop runs once per iteration of the outer (= 128 × 128 = 16384 sample operations per quantum for stride-1 nesting). The inner and outer callbacks are separate functions, so their `i` parameters are independent; realtime-safety check applies the `SAMPLES_PER_BLOCK` bounded-loop rule to both `forSample` invocations. Authors should verify the resulting per-quantum iteration count is realistic for their target latency (Q58, `decisions-log.md`).

#### 5.5.6 Error UX

Violations are caught at compile time (during graph capture or static analysis — see `03-compiler.md` §2) and surfaced as build errors before the WASM is emitted, never at runtime. Error messages include a concrete refactor hint pointing at one of the legal patterns. Example:

```text
error: L1 helper 'badHelper' cannot declare state.
  Either:
    (a) accept State<'f32'> as a parameter from the caller, or
    (b) refactor as a defineSubgraph (L2).
  See docs/01-dsl.md §5.2 for the L1 vs L2 boundary.
```

Detailed error-UX policy (Q22-d) is ratified in `03-compiler.md` §2.5 (Rust-style template with stable kebab-case error IDs + `help:` rationale + `note:` linking to `decisions-log.md` Q-ref).

### 5.6 L2 surface details

L2 subgraphs are reusable, stateful DSP blocks defined with `defineSubgraph`. Each instantiation gets its own state slots, and every instance is inlined into the parent's WASM module.

#### 5.6.1 Body structure (record return, author-named methods)

A subgraph body has the same two-scope structure as `defineProcessor`: a **declaration scope** at the top of the body and **expression scope** inside each method. The `defineSubgraph` lambda returns a record whose keys are method names (author-free) and whose values are method lambdas:

```typescript
const onepole = defineSubgraph((coef: Node<'f32'>) => {
  // ━━━ Declaration scope ━━━
  // Per-instantiation state slots; lambda arguments (here `coef`) are bound at instance
  // creation time and shared across all methods.
  const z = state.f32(0);

  return {
    process: (input: Node<'f32'>) => {
      // ━━━ Expression scope (per method) ━━━
      // Method arguments (here `input`) are passed per-call.
      const y = add(z.load(), mul(coef, sub(input, z.load())));
      z.store(y);
      return y;
    },
  };
});
```

Method record keys are author-free (`process`, `tick`, `render`, `compute`, `setFrequency`, `reset`, etc.); the framework imposes no naming convention. Multi-method subgraphs follow the same shape with multiple record entries:

```typescript
const oscillator = defineSubgraph((sr: number) => {
  const phase = state.f32(0);
  const freq  = state.f32(440);
  return {
    setFrequency: (hz: Node<'f32'>) => { freq.store(hz); },
    tick: () => {
      const inc = div(freq.load(), sr);
      phase.store(add(phase.load(), inc));
      return sin(mul(phase.load(), 2 * Math.PI));
    },
    reset: () => { phase.store(0); },
  };
});
```

**Lambda arguments vs method arguments**: the outer `defineSubgraph` lambda's arguments (e.g. `sr`, `coef`) are bound **once per instance** at `createSubgraph(...)` time and shared across all methods (closure capture). Each method's own arguments (e.g. `input`, `hz`) are passed **per call**. Subgraphs that need internal per-sample iteration use `forSample` inside a method body.

#### 5.6.2 Instantiation via `createSubgraph(...)`

Parent processors instantiate subgraphs through the free function `createSubgraph(subgraph, ...lambdaArgs, options?)`:

- `subgraph` — the `defineSubgraph(...)` recipe being instantiated.
- `lambdaArgs` — values bound to the subgraph's outer lambda arguments at instance creation time (e.g. `ctx.sampleRate`).
- `options?.name?: string` — optional instance name used as the snapshot path prefix for the instance's state slots (Q41).

(The exact TypeScript signature — generic-parameter binding for the return record, rest-args inference, etc. — is impl-level detail that lives in the emitted `.d.ts`; see `decisions-log.md` Q53.)

```typescript
const lpf = createSubgraph(onepole, 0.5);          // coef = 0.5 bound at instance creation; no options

forSample((i) => {
  const y = lpf.process(audioIn.at(0, i));         // input passed per call
  audioOut.set(0, i, y);
});

// 8-voice synth — build-time loop over NUM_VOICES allocates 8 independent instances:
const voices = [];
for (let s = 0; s < NUM_VOICES; s++) {
  voices.push(createSubgraph(synthVoice, ctx.sampleRate));
}
forSample((i) => {
  let mix = f32(0);
  for (let s = 0; s < NUM_VOICES; s++) {
    mix = add(mix, voices[s].process(hz, vel, gate, attackS, releaseS));
  }
});

// With `name` (required when the subgraph carries persistent state and the processor takes snapshots — see §8.1):
const filterL = createSubgraph(filterCore, ctx.sampleRate, { name: 'filterL' });
const filterR = createSubgraph(filterCore, ctx.sampleRate, { name: 'filterR' });
```

`createSubgraph(...)` performs state slot allocation. **The returned value is the subgraph body's return record itself** (= the author-named methods declared by `defineSubgraph`'s body), not a wrapper around it (Q54). Callers can invoke those methods from any expression context (§5.6.4) and pass the value to L1 helpers using TypeScript's standard `ReturnType<typeof someSubgraph>` inference where a type annotation is needed.

The `options.name` is **optional**: snapshot-free subgraphs need not provide one (Q41). When the subgraph declares persistent state and the parent processor takes snapshots, missing `name` is a graph-capture-time error — see §8.1.

`createSubgraph` mirrors the main-side `createNode` naming convention (see `05-client.md`).

#### 5.6.3 Return shape (per method)

Each method's return value follows the same shapes allowed for L1 helpers (§5.5.3):

- single `Node<T>` — typical filter / oscillator output,
- tuple `[Node<...>, Node<...>, ...]` — multi-output (stereo, SVF low/band/high),
- record `{ key: Node<...>, ... }` — named multi-output,
- `void` — side-effect-only (e.g. trigger / config method that only updates state slots).

The method call expression's type is inferred from the corresponding return.

#### 5.6.4 Where `createSubgraph(...)` can be called, and method context rules

`createSubgraph(subgraph, ...args)` can only be called in **declaration scope** — the body of `defineProcessor` or another `defineSubgraph`, before the `return` of the body record. Calling it inside expression scope (a method body, a `forSample` callback, an L1 helper body, a handler body) is a graph-capture-time error. Each instantiation declares an independent state slot region; placing the call in declaration scope keeps state allocation static and the instance count statically determined at build time.

The methods on the returned instance, however, can be called from **any expression context**: `forSample` / `forSample.byN` / `everyNSamples` callbacks, `midiInput().onEvent(...)` handlers, `messageDecl.onReceive(...)` handlers, and per-block top level. Method context is unrestricted regardless of return type — `Node<T>`-returning and `void`-returning methods are both callable everywhere. This matches the context rules for `state.load/store` and the primitive operators.

```typescript
const osc = createSubgraph(oscillator, ctx.sampleRate);

midi.onEvent('noteOn', ({ note }) => {
  osc.setFrequency(noteToHz(note));     // OK (handler context)
});

reqReset.onReceive(() => {
  osc.reset();                           // OK (handler context)
});

forSample((i) => {
  const y = osc.tick();                  // OK (forSample context)
  audioOut.set(0, i, y);
});

return {
  process: () => {
    const blockY = osc.tick();           // OK (per-block top level)
    // ...
  },
};
```

Conditional output between configurations is expressed by instantiating both and choosing with `select`:

```typescript
const myProcessor = defineProcessor((ctx) => {
  const main = audioInput ({ channels: 1, name: 'main' });
  const out  = audioOutput({ channels: 1, name: 'main' });
  const useA = param({ default: 1, min: 0, max: 1, automationRate: 'k-rate', name: 'useA' });

  // Two filter instances, each with independent state.
  const lpfA = createSubgraph(onepole, coefA);
  const lpfB = createSubgraph(onepole, coefB);

  return {
    process: () => {
      forSample((i) => {
        const x = main.at(0, i);
        // useA is k-rate 0|1; compare to 1 to get a Node<'bool'> for select.
        out.set(0, i, select(eq(useA.at(i), 1), lpfA.process(x), lpfB.process(x)));
        // Both instances evaluate every sample; select chooses one.
      });
    },
  };
});
```

Authoritative rationale and rejected alternatives: `decisions-log.md` Q34.

#### 5.6.5 Body constraints

Inside a subgraph body:

- **Declaration scope** (top of the body, before the `return` of the method record) allows new `state.*` / `buffer.*` / `param.*` declarations and `createSubgraph(...)` calls for nested subgraph instantiation.
- **Expression scope** (inside any method body, including any nested `forSample`) follows the same rules as L1 helpers (§5.5.5): no new declarations, no `createSubgraph(...)` calls; primitives, `load` / `store`, audio-I/O / param access via `at` / `set` / `param.at(...)`, and method calls on subgraph instances passed in scope are allowed.

Violations are caught at graph-capture / static-analysis time with refactor-hint error messages, mirroring §5.5.6.

## 6. The `process` body

unworklet processors run a single execution body, the `process` lambda, on the audio thread every render quantum. Build-time evaluation of `process` captures an AST DAG; the framework emits the DAG as a per-block runtime program (per-block top-level statements run once per render quantum; `forSample` callbacks run per sample). Hard realtime constraints apply (no allocation, no unbounded loops, no I/O). Authoritative shape and semantics: §1, §10, and `decisions-log.md` Q22.

There is **no separate `publish` lambda** and no `perBlock` body. State that the main thread observes (meter, spectrum, etc.) is declared with the `publish` option on `state` / `buffer` (see §3 and `decisions-log.md` Q27-a); worklet → main moment-in-time delivery is via `eventDecl.emitIf(cond, payload)` callable from any expression context (`forSample` / `forSample.byN`, `everyNSamples`, MIDI / message handler bodies, **per-block top level**) — see §4.1 and `decisions-log.md` Q32; main → worklet messages are handled by `onReceive` registered at per-block top of the `process` body (see §4.2). The framework manages all scheduling — there is no user-visible publish-lambda.

## 7. Opt-in SIMD

unworklet exposes WASM SIMD as a separate, opt-in surface via the import path `@unworklet/core/simd`. Code that does not import this path never encounters vector types or vector primitives — the scalar surface is unchanged.

### 7.1 Philosophy

- **Opt-in**: importing `@unworklet/core/simd` is the only way to bring vector concepts into scope. Scalar-only authors and consumers never see `f32x4`, `splat`, or any vec primitive.
- **Parallel families**: scalar primitives (`add`, `mul`, …) and vec primitives (`addVec`, `mulVec`, …) are distinct functions over distinct types. Scalar `Node<'f32'>` and vector `Node<'f32x4'>` cannot be combined in one operation; conversion is explicit (`splat`, `vec.lane(i)`).
- **Bulk iteration via `forSample.byN`**: SIMD-stride iteration is expressed by `forSample.byN(stride, callback)` (typically `stride = 4`) — see §10. The stride is user-chosen and visible in the source; the framework does not auto-vectorize a per-sample body.

```typescript
// Scalar-only author — never imports SIMD
import { defineProcessor, state, add, mul } from '@unworklet/core';

// SIMD-using author — separate import path
// vec4 / splat / addVec / mulVec / subVec / divVec / sumLanes are free functions.
// Lane access (`vec.lane(i)`) and SIMD buffer access (`buf.loadVec` / `buf.storeVec`)
// are methods on the value/handle, not free functions.
import { vec4, splat, addVec, mulVec, sumLanes } from '@unworklet/core/simd';
```

### 7.2 v1.0.0 surface (Minimal MVP)

The v1.0.0 SIMD surface is the smallest set of primitives that lets DSP authors hand-vectorize hot paths (4-channel mixers, 4-tap filters, parallel-lane oscillators, 4-sample-wide bulk processing). Subsequent v1.x.0 releases extend the surface additively (see `10-roadmap.md`).

#### Vector types

- `Node<'f32x4'>` — four 32-bit floats packed into a v128.

#### Construction

- `vec4(a: Node<'f32'>, b: Node<'f32'>, c: Node<'f32'>, d: Node<'f32'>): Node<'f32x4'>` — pack 4 scalars into a vec.
- `splat(x: Node<'f32'>): Node<'f32x4'>` — broadcast a scalar to all four lanes.

#### Arithmetic

- `addVec`, `subVec`, `mulVec`, `divVec`: `(Node<'f32x4'>, Node<'f32x4'>) → Node<'f32x4'>`.

#### Lane access

Lane extraction is a method on the vec value, not a free function:

```typescript
type Vec4Methods = {
  lane(i: 0 | 1 | 2 | 3): Node<'f32'>;
};
```

`vec.lane(i)` extracts one lane from a `Node<'f32x4'>`. The index `i` must be a compile-time constant `0 | 1 | 2 | 3`; non-constant indices are a graph-capture-time error.

#### Horizontal reduction

```typescript
sumLanes(v: Node<'f32x4'>): Node<'f32'>;
```

`sumLanes(v)` collapses a 4-lane vec to a scalar by summing all four lanes. The framework emits a shuffle + add sequence (WASM SIMD has no direct float horizontal-reduce instruction; the lowering is equivalent to `add(add(v.lane(0), v.lane(1)), add(v.lane(2), v.lane(3)))` but expressed as a single primitive at the call site). Typical use: 4-tap FIR / dot product / per-block accumulator collapse (Q59, `decisions-log.md`).

#### Memory

SIMD memory access is performed via methods on the `Buffer<'f32'>` handle (see §3.2). Importing `@unworklet/core/simd` makes these methods part of the buffer handle's type:

```typescript
type BufferSimdMethods = {
  loadVec(offset: Node<'i32'>): Node<'f32x4'>;
  storeVec(offset: Node<'i32'>, value: Node<'f32x4'>): void;
};
```

- `buf.loadVec(offset)` — load four contiguous f32 lanes from the buffer (offset in element units; alignment-agnostic per WASM v128 semantics). Typically called inside a `forSample.byN(4, ...)` callback, or at per-block top level (with build-time-loop unrolling) for bulk init.
- `buf.storeVec(offset, value)` — store four contiguous f32 lanes into the buffer.

The `Buffer<T>` handle is returned by `buffer.<T>({ size, name, ... })` declarations (see §3.2); the `.read` / `.write` / `.readInterpolated` scalar methods are always present, while `.loadVec` / `.storeVec` only become callable in modules that import `@unworklet/core/simd`.

### 7.3 Beyond v1.0.0 (deferred to v1.x.0, additive)

Adding any of the following does not change the v1.0.0 surface:

- `Node<'f64x2'>` and `Node<'i32x4'>` types and their arithmetic.
- Boolean / mask vectors and `selectVec`.
- `shuffle` / `swizzle` lane permutations.
- Comparison primitives (`ltVec`, `eqVec`, …).
- Gather / scatter (load from non-contiguous offsets).

Rollout order is settled by Q14 once early DSP packages report which extensions they need first.

### 7.4 Use within L1 / L2 / processors

Vec primitives are usable inside any expression scope (`process` body per-block top level, `forSample` callbacks, L1 helper bodies, subgraph `process` lambdas). They count as primitive operators for §5.5.5 / §5.6.5 purposes — bodies are still forbidden from declaring new state / buffer / param.

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

### 7.5 SIMD bulk in practice

The canonical 4-sample-wide bulk pattern uses `forSample.byN(4, ...)` plus the buffer's `.loadVec` / `.storeVec` methods:

```typescript
import { defineProcessor, audioInput, audioOutput, param, buffer, forSample } from '@unworklet/core';
import { mulVec, splat } from '@unworklet/core/simd';

export const simdGain = defineProcessor((ctx) => {
  const main = audioInput ({ channels: 1, name: 'main' });
  const out  = audioOutput({ channels: 1, name: 'main' });
  const scratch = buffer.f32({ size: SAMPLES_PER_BLOCK, name: 'scratch' });
  const gain    = param({ default: 1.0, min: 0.0, max: 4.0, automationRate: 'k-rate', name: 'gain' });

  return {
    process: () => {
      // Step 1: accumulate input into scratch (per-sample).
      forSample((i) => {
        scratch.write(i, main.at(0, i));
      });

      // Step 2: SIMD bulk gain.
      forSample.byN(4, (i) => {
        const v = scratch.loadVec(i);
        scratch.storeVec(i, mulVec(v, splat(gain.at(i))));
      });

      // Step 3: drain scratch to output (per-sample).
      forSample((i) => {
        out.set(0, i, scratch.read(i));
      });
    },
  };
});
```

## 8. Snapshot / restore declaration

Processors that need preset save/load, session restore, or AB compare declare snapshot/restore behavior in two places: per-slot `snapshot` flags (§3) and an optional `migrations` array on the processor itself.

### 8.1 Slot identity rules

Every slot reachable from a `defineProcessor` body that calls `snapshot()` must carry a unique `name`. Names are used as keys in snapshot blobs.

**Subgraph instances** carry a `name` only when the parent processor's snapshot path needs to identify which instance owns a slot (Q41). For snapshot-free subgraphs, `name` is omitted entirely:

```typescript
const onepole = defineSubgraph((coef: Node<'f32'>) => {
  const z = state.f32(0, { name: 'z' });
  return {
    process: (input: Node<'f32'>) => {
      const y = add(z.load(), mul(coef, sub(input, z.load())));
      z.store(y);
      return y;
    },
  };
});

const synth = defineProcessor((ctx) => {
  // Snapshot-bearing: each instance's `z` becomes a distinct slot in the blob.
  const lpfL = createSubgraph(onepole, cutoff, { name: 'lpfL' });   // slot path 'lpfL/z'
  const lpfR = createSubgraph(onepole, cutoff, { name: 'lpfR' });   // slot path 'lpfR/z'
  // ...
});
```

Slot path is the slash-joined chain from the root processor (`'lpfL/z'`, `'fxBus/reverb/tail'`, etc.). Graph capture validates uniqueness; missing `name` on any reachable slot is always an error. Missing `name` on a subgraph instance is an error only when the subgraph declares persistent state and the parent processor takes snapshots — for snapshot-free instances (the common case), no `name` is required.

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

  return { process: () => { /* ... */ } };
}, {
  migrations: [
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
  ],
});
```

The migration array lives on the **processor's options bag** (the second argument to `defineProcessor`), not in the declaration body — this keeps the processor body focused on the live runtime graph and isolates schema-evolution concerns from per-block / per-sample logic. Each entry's `from` and `to` are schema hashes emitted by `@unworklet/vite-plugin` into `dist/<processor>.schema-hash.json` (per-processor artifact; authoritative shape in `07-vite-plugin.md` §6.3). The framework constructs a directed graph from the entries and finds the path `blob.schemaHash → currentSchemaHash`; entries are applied in order, with each step's output hash verified against its declared `to`.

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

If the current schema is unreachable (i.e. the developer changed the schema but did not write a migration), the build emits a **warning by default** — name-match partial restore (§8.3.3) covers many cases without explicit migration. Set `migrationsStrict: true` in the processor's options bag (alongside `migrations`) to elevate this to an error.

#### 8.3.3 Restore-time fallback

When `restore(blob)` runs:

1. If the blob's schema hash matches the current hash, slots are written back directly.
2. If not, the framework searches the migration graph for a path `blob.schemaHash → currentSchemaHash`. If found, migrations are applied in order with hash verification at each step.
3. If a `migrate` function **throws** during step execution, the framework catches the exception, stops the chain (= no further steps run; their inputs would be incomplete), starts the processor with declaration defaults for slots not yet successfully restored, and surfaces the failure through the `restore(blob)` return value (Q45, `decisions-log.md`). Audio-thread state is never left mid-migration; the audio thread is never reached with a partial migration in progress.
4. If no migration path exists (or a step's hash check fails without a thrown exception), the framework falls back to **name-match partial restore**: slots that share name and compatible type with the new schema are written back; the rest are reset to declaration defaults.

The result of `restore(blob)` is a discriminated union `{ ok: true, ... } | { ok: false, error: { step, message, cause }, ... }` (Q45) so the consumer can distinguish a clean partial-restore (`ok: true` with non-empty `skipped` / `missing`) from a thrown-migration failure (`ok: false` with `error` carrying the throwing step and cause). See `05-client.md` §2.6 / §6 for the full type.

Authoritative rationale and rejected alternatives: see `decisions-log.md` Q5.

## 9. Sub-rate computation (`everyNSamples`)

Some processor-internal computations (LFO, envelope, FFT, modulation matrix, etc.) only need to update at a coarser rate than the audio rate. unworklet exposes a single primitive — `everyNSamples(N, callback)` — for this. It is **delivered as the second argument of the `forSample` callback** (Q43, `decisions-log.md`), not as a free function import: scope is enforced by TypeScript scoping (the same shape as the `i: Node<'i32'>` first argument), so calling it outside a `forSample` is impossible at TypeScript level.

```typescript
const synth = defineProcessor((ctx) => {
  const lfoVal  = state.f32(0, { name: 'lfo' });
  const fftMag  = state.f32(0, { name: 'mag' });
  const inBuf   = buffer.f32({ size: 1024, name: 'fftIn' });
  const audioIn = audioInput({ channels: 1, name: 'main' });
  const out     = audioOutput({ channels: 1, name: 'main' });

  return {
    process: () => {
      forSample((i, everyNSamples) => {
        // 1 ms (= 48 sample) sub-rate block: LFO update.
        everyNSamples(48, () => {
          lfoVal.store(computeLfo(/* ... */));
        });

        // ~5 ms (= 256 sample) sub-rate block: FFT magnitude update.
        everyNSamples(256, () => {
          const mag = computeFft(inBuf);
          fftMag.store(mag);
        });

        // Audio-rate output uses held values from sub-rate slots.
        const sample = audioIn.at(0, i);
        out.set(0, i, applyFilter(sample, lfoVal.load(), fftMag.load()));
      });
    },
  };
});
```

### 9.1 Semantics

- **Graph-capture-time meta primitive**: `everyNSamples` is *not* a runtime callback. The callback body is evaluated once during graph capture; the resulting graph nodes are recorded as belonging to the `N`-rate sub-block.
- **Compilation**: the sub-block compiles to a WASM branch keyed off an internal sample counter. On samples where `(counter % N) == 0`, the sub-block body executes; on other samples, it is skipped.
- **State slots in the callback**: `state.<type>` slots written inside the callback hold their value between updates (zero-order hold). Reading them in the surrounding per-sample body (`slot.load()`) returns the most recent stored value.
- **Scope by callback argument, not by separate context check (Q43)**: `everyNSamples` is in scope only inside a `forSample(...)` or `forSample.byN(...)` callback that takes it as the second parameter. Using the name outside such a callback (handler bodies, per-block top level, declaration scope) is a TypeScript reference error — no separate compiler context check is performed. The second argument is optional; callbacks take `(i) => ...` when sub-rate is not needed and `(i, everyNSamples) => ...` when it is.
- **Counter is per call, continuous across blocks**: each `everyNSamples(N, cb)` call site has its own counter; counters advance by 1 per `forSample` iteration (by `stride` per `forSample.byN(stride)` iteration), and are not reset at render-quantum boundaries — sub-rate timing is continuous across blocks. Multiple `everyNSamples` calls inside the same `forSample` callback do not share counters.
- **Subgraph methods**: if a subgraph method needs sub-rate, it opens its own `forSample` inside the method body and takes `everyNSamples` from that callback — there is no caller-context propagation, because the surrounding `forSample` is local to the method.
- **No new declarations inside the callback**: the callback body is an expression scope (same rules as L1 helpers — see §5.5.5). New `state.*` / `buffer.*` / `param.*` / `defineSubgraph` declarations inside the callback are graph-capture-time errors.
- **Sample-offset primitives inside the callback**: `audioIn.at(c, i)`, `audioOut.set(c, i, v)`, `param.at(i)` are valid (`i` from the surrounding `forSample`); state and buffer access are valid.

### 9.2 Multiple sub-rate blocks coexist

A `forSample` callback can contain any number of `everyNSamples` blocks at any divisor; each has its own counter and they execute independently:

```typescript
forSample((i, everyNSamples) => {
  everyNSamples(8, () => {
    smoothing.store(/* ... */);     // 8-sample rate
  });
  everyNSamples(48, () => {
    lfo.store(/* ... */);           // 48-sample rate (1 ms)
  });
  everyNSamples(256, () => {
    fftMag.store(/* ... */);        // 256-sample rate
  });
  out.set(0, i, /* audio rate */);  // every sample
});
```

The counter advance is global to the processor instance; sub-blocks do not interfere.

### 9.3 Relationship to `param` automation

`everyNSamples` is for **internal computation rate-down**, not for changing how `AudioParam` automation arrives. AudioParam's own rate (`'a-rate'` / `'k-rate'`) is set on the `param` declaration (see §3.3) and governed by Web Audio's standard automation machinery; unworklet does not modify it.

If a consumer wants to consume an automation value at a coarse rate (e.g. read `cutoff` only once per 8 samples), they wrap the read in an `everyNSamples` callback and store into a `state` slot:

```typescript
const cutoffSampled = state.f32(0, { name: 'cutoffSampled' });

forSample((i, everyNSamples) => {
  everyNSamples(8, () => {
    cutoffSampled.store(cutoff.at(i));
  });
  // audio-rate body uses cutoffSampled.load()
});
```

### 9.4 CPU spike caveat (consumer responsibility)

`everyNSamples` reduces **average CPU**, but the **worst-case sample** (when the sub-block fires) still pays the full computation cost. For heavy sub-blocks (e.g. a 1024-point FFT inside `everyNSamples(256, ...)`), this produces a periodic CPU spike on the audio thread.

unworklet does not auto-distribute the spike. CPU smoothing is the consumer's responsibility:

- **Partitioned algorithms**: split the heavy work across multiple samples (e.g. partitioned FFT processes one stage per audio sample, evening out cost).
- **Out-of-band processing**: instantiate a separate `AudioWorkletNode` and route audio through it, decoupling the heavy work from the main processor's audio thread (see Q9).

### 9.5 v1.0.0 scope

v1.0.0 ships `everyNSamples(N, callback)` only, where `N` is a compile-time positive integer (sample count). Future additive primitives (`everyTimeMs(ms, callback)`, `atSampleRate(rate, callback)`, etc.) can be introduced in v1.x.0 without breaking the v1.0.0 surface.

Authoritative rationale and rejected alternatives: see `decisions-log.md` Q7.

## 10. `forSample` — the per-sample loop primitive

`forSample` is the only sample-loop primitive in unworklet. The presence of a `forSample` invocation in a `process` body marks per-sample code; statements at the top level of the `process` body (= outside any `forSample`) are per-block code. There is no implicit form, no sugar wrapping, and no `perBlock` sibling primitive — per-block code lives at "the top level", denoted by lexical position.

### 10.1 Surface

```typescript
function forSample(
  callback: (i: Node<'i32'>, everyNSamples?: EveryNSamples) => void,
): void;

forSample.byN: (
  stride: number,                           // compile-time positive integer
  callback: (i: Node<'i32'>, everyNSamples?: EveryNSamples) => void,
) => void;

type EveryNSamples = (n: number, body: () => void) => void;
```

`everyNSamples` is delivered as the **second callback argument** (Q43, `decisions-log.md`); the parameter is optional and most `forSample` callbacks just take `(i) => ...`. See §9 for sub-rate semantics.

- `forSample(callback)` — the callback body runs once per sample of the current render quantum. `i` is a `Node<'i32'>` bound at WASM-emission time to the loop counter, advancing by 1 each iteration.
- `forSample.byN(stride, callback)` — same shape, but `i` advances by `stride` each iteration. Typical use is `stride = 4` for SIMD bulk operations paired with the buffer-handle methods `buf.loadVec` / `buf.storeVec`. SIMD store is buffer-only by design (Q3-b、 §2.1) — `audioOut.storeVec` is not part of the surface, so audio output writes in `forSample.byN` use scalar `audioOut.set` per iteration. The stride must be a compile-time-constant positive integer **and must divide `SAMPLES_PER_BLOCK` (= 128)** — allowed values are `1`, `2`, `4`, `8`, `16`, `32`, `64`, `128` (Q37-b, `decisions-log.md`). Non-constant strides or strides that do not divide 128 are graph-capture-time errors at the `forSample.byN(...)` call site. Sample-offsets skipped by the stride (e.g. `stride = 4` with `audioOut.set` writes only `i = 0, 4, 8, ..., 124`) are emitted as silence unless other code writes them — same silence-for-unwritten-samples behavior as §1.3 (no coverage requirement; Q37).

### 10.2 Semantics

- **Graph-capture-time meta primitive**: the callback is evaluated once during graph capture; the resulting AST nodes are recorded as belonging to a per-sample (or per-`stride`) sub-block of the WASM render-quantum program.
- **`i` is loop-counter-bound and scoped to the callback**: inside the callback, `i` denotes the current sample-offset within the render quantum. Outside the callback, `i` is not in scope — TypeScript will reject any sample-offset primitive that tries to use it (e.g., `audioIn.at(0, i)` written at per-block top level is a TS reference error).
- **Arithmetic on `i`**: `add(i, 1)` and similar produce a `Node<'i32'>` that resolves to the offset value at WASM-emission time. Out-of-block access (`add(i, lookaheadSamples)` exceeding the render quantum) is a static-analysis error when statically detectable.
- **Multiple `forSample` calls in one body**: each call is an independent sub-loop. Per-block top-level statements and `forSample` invocations execute in **declared (source) order** within the render quantum — the body reads top-to-bottom, exactly like JUCE / AudioWorklet `process` (see `00-foundations.md` §3 "Process body" mental model).
- **No implicit `forSample` wrapping**: the `Node<'i32'> i` alias (= loop counter form of sample-offset primitives) is forSample-scoped — `audioIn.at(0, i)` written at per-block top level is a TS reference error because `i` is undefined there. Single-offset access with a JS-literal offset (`audioIn.at(0, 0)`, `audioOut.set(0, 0, v)`, `param.at(0)`) lifts via Q36-a and is valid at any lexical position (Q51); per-sample work over the full block requires `forSample`.

### 10.3 Body constraints

Inside a `forSample` callback, the same rules as L1 helper bodies (§5.5.5) apply:

- **Forbidden**: new `state.*` / `buffer.*` / `param.*` / `audioInput` / `audioOutput` declarations; new `defineSubgraph` declarations or instantiations.
- **Allowed**: primitive operators, `state.load()` / `state.store()`, sample-offset primitives (`audioIn.at(c, i)`, `audioOut.set(c, i, v)`, `param.at(i)`), buffer access, calls to L1 helpers, `everyNSamples`, and nested `forSample` invocations (rare; typically used for tile iteration in 2D buffers, or when an L1 helper called from inside a `forSample` itself calls `forSample`). The inner and outer `forSample` callbacks are separate functions, so their `i` parameters are independent; realtime-safety check applies the `SAMPLES_PER_BLOCK` bounded-loop rule to both invocations (Q58, `decisions-log.md`).

### 10.4 Examples

#### 10.4.1 Per-sample-only (one `forSample`, no per-block code)

```typescript
const gainSat = defineProcessor((ctx) => {
  const main  = audioInput ({ channels: 2, name: 'main' });
  const out   = audioOutput({ channels: 2, name: 'main' });
  const gain  = param({ default: 1.0, ..., automationRate: 'a-rate', name: 'gain'  });
  const drive = param({ default: 0.0, ..., automationRate: 'a-rate', name: 'drive' });

  return {
    process: () => {
      forSample((i) => {
        const inL = main.at(0, i);
        const inR = main.at(1, i);
        const g   = gain.at(i);
        const d   = drive.at(i);
        const cleanL = mul(inL, g);
        const cleanR = mul(inR, g);
        const satL   = tanh(mul(inL, mul(g, 3.0)));
        const satR   = tanh(mul(inR, mul(g, 3.0)));
        const m = sub(1, d);
        out.set(0, i, add(mul(cleanL, m), mul(satL, d)));
        out.set(1, i, add(mul(cleanR, m), mul(satR, d)));
      });
    },
  };
});
```

#### 10.4.2 Mixed (interleaved per-block and per-sample, with SIMD)

```typescript
const simdProc = defineProcessor((ctx) => {
  const main    = audioInput ({ channels: 1, name: 'main' });
  const out     = audioOutput({ channels: 1, name: 'main' });
  const scratch = buffer.f32({ size: SAMPLES_PER_BLOCK, name: 'scratch' });
  const gain    = param({ default: 1.0, ..., automationRate: 'k-rate', name: 'gain' });

  return {
    process: () => {
      // Per-block: snapshot the block-start gain value for SIMD bulk multiply.
      const blockGain = gain.at(0);

      // Per-sample: input shaping
      forSample((i) => {
        scratch.write(i, main.at(0, i));
      });

      // Per-sample (SIMD stride): apply blockGain across the buffer.
      forSample.byN(4, (i) => {
        const v = scratch.loadVec(i);
        scratch.storeVec(i, mulVec(v, splat(blockGain)));
      });

      // Per-sample: output drain
      forSample((i) => {
        out.set(0, i, scratch.read(i));
      });
    },
  };
});
```

### 10.5 v1.0.0 scope

- `forSample(callback)` and `forSample.byN(stride, callback)` ship in v1.0.0.
- The callback signature is `(i: Node<'i32'>, everyNSamples?: EveryNSamples) => void`; non-`void` returns are not part of the v1.0.0 surface.
- Future additive primitives admitted by Q29 (`decisions-log.md`):
  - `forSample.parallel(callback)` — unordered-iteration optimization opportunities (v1.x.0 additive).
  - `forSampleRange(start, end, callback)` — partial-block iteration (v1.x.0 additive; the v1.0.0 surface already expresses the same outputs via `forSample` + build-time `if`, so this is an efficiency addition rather than a missing capability).
- Permanently excluded by Q29 (= not v1.0.0, not v1.x.0):
  - `forSamplesUntil(cond, callback)` — runtime early-exit would make audio-thread work unpredictable in length, violating realtime safety.
  - Runtime-variable stride for `forSample.byN` — the stride must be a compile-time constant; a runtime stride cannot be specialized in WASM emission and breaks the "user-authored structure compiles directly to WASM" principle.

Authoritative rationale and rejected alternatives: see `decisions-log.md` Q22 (Q22-aprime) + Q29.
