# 01 — DSL (`@unworklet/core` + `@unworklet/dsp`)

The surface the user authors against. Defines `defineProcessor`, primitives, declarations (`state`, `buffer`, `param`), the `forSample` per-sample loop primitive, and authoring patterns for reusable DSP blocks.

## Status

written

## 1. `defineProcessor`, the process body, and I/O declarations

`defineProcessor` is the entry point. The body is a single lambda that runs once at build time (see `00-foundations.md` §3 for the meta-program semantics) — declarations come first; a `process` lambda is returned in the result record.

A `process` body has **two execution phases distinguished by lexical position**:

- **Per-block phase** — statements at the top level of the `process` body. Run once at the start of every render quantum on the audio thread.
- **Per-sample phase** — statements inside a `forSample(callback)` or `forSample.byN(stride, callback)` invocation. The callback body runs once per sample (or once per `stride` samples) of the render quantum.

The body is read **top-to-bottom**: each statement (whether direct per-block code or a `forSample` invocation) executes in declared (source) order. Per-block code can interleave freely with `forSample` invocations — per-block setup → per-sample work → more per-block code → another `forSample` → … — all valid.

Sample-position primitives (`audioIn.at(c, i)`, `audioOut.set(c, i, v)`, `param.at(i)`) take an `i: Node<'i32'>` whose only source is a `forSample` callback parameter. Outside any `forSample`, `i` is not in scope, so the IDE rejects misplaced sample-position calls as TypeScript reference errors. There is no sugar form; every per-sample access uses `at` / `set` / `param.at(...)`.

```typescript
// Single-phase per-sample plugin (one forSample, no per-block work):
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

// Multi-phase plugin (interleaved per-block and per-sample code):
const partitionedReverb = defineProcessor((ctx) => {
  const main       = audioInput ({ channels: 1, name: 'main' });
  const out        = audioOutput({ channels: 1, name: 'main' });
  const inBuf      = buffer.f32({ size: 128, name: 'inBuf'  });
  const outBuf     = buffer.f32({ size: 128, name: 'outBuf' });
  const partIdx    = state.i32(0, { name: 'partIdx' });
  const NUM_PARTITIONS = 8;

  return {
    process: () => {
      // Per-block phase: advance partition pointer, run partitioned FFT setup.
      const idx = partIdx.load();
      partIdx.store(mod(add(idx, 1), NUM_PARTITIONS));
      // ... partitioned FFT computation ...

      // Per-sample phase: shovel input into inBuf, drain outBuf to output.
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

The returned handles expose sample-position primitives (`at` / `set`); both require a `Node<'i32'>` for the sample-offset and are valid only inside `forSample` callbacks.

### 1.2 Reading audio inputs

`AudioInputHandle<C>` exposes one method:

```typescript
type AudioInputHandle<C extends number> = {
  at(c: ChannelIndex<C>, i: Node<'i32'>): Node<'f32'>;
  channels: C;
  name:     string;
};

// `ChannelIndex<C>` is the union `0 | 1 | ... | (C - 1)`, narrowed by TypeScript
// from the literal `channels: C` declared on the handle. Out-of-range indices are
// TS errors at the call site.
```

`audioIn.at(c, i)` returns the channel-`c` value at sample-offset `i` within the current render quantum. `i` must be a `Node<'i32'>` originating from a `forSample` callback parameter.

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
  set(c: ChannelIndex<C>, i: Node<'i32'>, v: Node<'f32'>): void;
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

Per declared output channel, exactly one `set(c, i, v)` write must happen on every code path inside the surrounding `forSample` callback. Missing writes (output channel never written) and duplicate writes (same channel × same `i` written twice in the same phase) are graph-capture-time errors with refactor-hint messages.

A processor with multiple `forSample` phases may have different phases write to different outputs, but each declared output channel must end up written in some phase covering every sample-offset of the render quantum.

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

Authoritative rationale and rejected alternatives: see `decisions-log.md` Q6 (declaration shape) and Q22 (single form for sample-position primitives).

## 2. Primitive operators

<!-- Full inventory: arithmetic (add/sub/mul/div/mod/neg), comparison (eq/lt/gt/lte/gte),
     math (sin/cos/tan/tanh/exp/log/sqrt/abs/floor/ceil/frac/min/max/clamp),
     control (select), memory (load/store on State<T>; .read/.write/.readInterpolated as
     methods on Buffer<T>),
     type conversions (f32/f64/i32/i64).
     Q17 (math precision: default vs `/precise` vs `/table` import paths). Lands here. -->

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

State is sample-position-independent: the `state` reference itself does not depend on the surrounding phase. `load()` returns the value as updated by the most recent `store()`. State updates inside `forSample` callbacks are observable in subsequent samples in the same render quantum and in subsequent render quanta. State updates at the per-block phase top level are observable for the rest of that render quantum and beyond. State load/store at the per-block phase **after** a `forSample` invocation can observe the state's value at the end of the loop — useful for block-level summaries (peak detect, accumulator readout, etc.).

Options:

- **`name?: string`** — slot identity. Required when the parent processor calls `snapshot()` (graph-capture-time error otherwise). Used as the slot key in snapshot blobs.
- **`snapshot?: 'persistent' | 'transient' | { [profile: string]: 'persistent' | 'transient' }`** — snapshot inclusion. Default is `'persistent'`. See §8.2.
- **`publish?: { rateFps: number }`** — when set, the framework periodically copies the current slot value into a shared region readable from the main thread via `node.state.<name>.subscribe(handler)` or `.value`. Default omitted (= not published). The slot remains worklet-private for writes regardless of this option; main observes a snapshot at copy time. Authoritative rationale: `decisions-log.md` Q27-a.

### 3.2 `buffer` — fixed-size arrays

```typescript
const ring = buffer.f32({ size: 44100, name: 'delayLine' });                          // default 'transient'
const wave = buffer.f32({ size: 256,   name: 'wavetable', snapshot: 'persistent' });  // explicit include
```

Access goes through methods on the `Buffer<T>` handle (`buf.read(idx)`, `buf.write(idx, v)`, `buf.readInterpolated(pos)`); bounds and interpolation behavior are explicit at each call site. The index argument is an explicit `Node<'i32'>` supplied by the user — this can be a ring-buffer write head from a `state.i32` slot (per-block or per-sample), the loop counter `i` of a surrounding `forSample` (per-sample), or any computed `Node<'i32'>` value.

The `Buffer<T>` handle returned by `buffer.<T>(...)` exposes the following methods (these are part of the handle type, not free function imports):

```typescript
type Buffer<T extends ScalarType> = {
  read(idx: Node<'i32'>): Node<T>;
  write(idx: Node<'i32'>, v: Node<T>): void;
  readInterpolated(pos: Node<'f32'>): Node<T>;
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
// Inside a forSample callback (per-sample phase): use the loop counter `i`.
forSample((i) => {
  const v = cutoff.at(i);          // Node<'f32'>, value at sample-offset i
});

// At the per-block phase top level: use 0 (block-start sample).
const blockValue = cutoff.at(0);   // Node<'f32'>, block-start value
                                   // For k-rate params this is the unique block value;
                                   // for a-rate params it is the first-sample value.
```

`param.at(i)` returns the value at sample-offset `i` within the current render quantum. Used inside `forSample` it returns the per-sample value (a-rate: per-sample interpolated; k-rate: the unique block value). Used at the per-block phase with `i = 0` it returns the block-start value, which is what k-rate consumers want and what most per-block computations involving a-rate params should treat as their representative value.

There is **no callable `param()` form** and **no `param.value` / `param.now()` property**. The single explicit method makes the sample-offset visible at every call.

Options:

- **`default`, `min`, `max`** — initial value and clamp range.
- **`automationRate: 'a-rate' | 'k-rate'`** — Web Audio automation rate.
- **`unit?: string`** — display hint passed through to `AudioParamDescriptor` metadata.
- **`name?: string`** — slot identity.
- **`snapshot?: 'persistent' | 'transient' | { ... }`** — default is `'persistent'` (param values are typically the user-controlled state of a preset). Snapshots include only the **current value**; AudioParam automation queues (`setValueAtTime`, `linearRampToValueAtTime`, etc.) are not preserved.

Authoritative rationale for the snapshot defaults: `decisions-log.md` Q5 (Q5-b). Authoritative rationale for the single form (no sugar): `decisions-log.md` Q22 (Q22-b).

## 4. Messages and events declarations

The two new declaration kinds added by Q27 — `event<T>` (worklet → main, sample-accurate) and `message<T>` (main → worklet, coarse-grained) — share an authoring shape. Both are declared at declaration scope and consumed inside the `process` body. Wire-level transport, queue policy, and SAB-vs-postMessage handling live in `02-messaging.md`; this section covers only the DSL surface.

### 4.1 `event<T>` — worklet to main

```typescript
const peakEvt = event<{ level: number }>({ name: 'peak' });
const noteFired = event<{ note: number; velocity: number }>({ name: 'noteFired', capacity: 512 });
```

`event<T>(options): EventDecl<T>` declares a typed worklet → main event channel. The payload type `T` is user-defined; an `atSample: number` field is **always carried on the wire** alongside `T` (mirroring MIDI Q4-c). Emission is via the `emitIf` method on the event handle (`eventDecl.emitIf(cond, payload)`) from inside a `forSample` callback:

```typescript
forSample((i) => {
  peakEvt.emitIf(gt(abs(audioIn.at(0, i)), thresh.at(i)),
                 { atSample: i, level: audioIn.at(0, i) });
});
```

Plain unconditional `emit(...)` is **not offered** — every emission must carry a structural condition. Same footgun-elimination as MIDI Q4-b: an unconditional emission inside `forSample` would saturate the ringbuffer at sample rate.

Options:

- **`name: string`** — required. Used as the key for `node.events.<name>` on the main thread.
- **`capacity?: number`** — ringbuffer slot count. Default 256, uniform with MIDI Q4-c.

Overflow: drop-oldest + monotonic `overflowCount` counter, exposed as `node.events.<name>.diagnostics.overflowCount()`. Variable-length payload fields (e.g. `Float32Array`) follow §4.3.

### 4.2 `message<T>` — main to worklet

```typescript
const reqReset   = message<void>({ name: 'requestReset' });
const loadPreset = message<{ slot: number }>({ name: 'loadPreset' });
const uploadIR   = message<{ samples: Float32Array }>({ name: 'uploadIR', capacity: 4 });
```

`message<T>(options): MessageDecl<T>` declares a typed main → worklet message channel. The worklet-side handler is registered inside the `process` body at the per-block phase top level via `messageDecl.onReceive(handler)`:

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

Handler bodies run at the start of the current render quantum, before any `forSample`. Inside a handler, only state writes, buffer writes, and scalar arithmetic are allowed — sample-offset `i` is not in scope, so audio I/O primitives (`audioIn.at`, `audioOut.set`, `param.at(i)`) produce TypeScript reference errors at the call site (uniform with MIDI handler bodies, see `11-midi.md` §2).

Options:

- **`name: string`** — required. Used as the key for `node.messages.<name>(payload)` on the main thread.
- **`capacity?: number`** — default 256. Same overflow semantics as `event<T>`.

### 4.3 Variable-length payloads

Both `event<T>` and `message<T>` allow variable-length payload fields (`Float32Array`, `Uint8Array`, etc.) within `T`. The wire format borrows the MIDI sysex pattern (Q4-c): the main slot in the ringbuffer holds the fixed-size header + an index into a separate variable-length content buffer. Authoritative wire format and capacity policy: `02-messaging.md` §5.

Authoritative rationale and rejected alternatives: see `decisions-log.md` Q27.

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

L1 helpers compose freely from both per-block and per-sample contexts. Pure-`Node<T>`-arithmetic helpers (no audio I/O / param access) are sample-position-agnostic and can be called anywhere.

Helpers that need to access audio I/O or param values from inside their own body should accept `i: Node<'i32'>` as a parameter and use it with the sample-position primitives — see §5.5.2.

Whether L1 helpers can also write to `state.*` references owned by the caller — and the typing rules for that — is settled in §5.5.

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

Subgraph `process` lambdas have the same per-block / per-sample phase structure as `defineProcessor` `process` lambdas. A subgraph instantiation invoked from the parent's `forSample` callback runs its per-sample work at the surrounding `i`; from the parent's per-block phase, it runs at the per-block phase. (The conventional pattern is for subgraphs that consume per-sample audio to be invoked inside a `forSample`, since their inputs are per-sample values.)

Instantiation API, parameter declaration rules, and capture-time analysis are settled in §5.6.

### 5.3 Why two layers, not one

A single layer that auto-promotes to a subgraph based on the presence of `state.*` calls inside the function body was rejected. Implicit promotion blurs the responsibility boundary between graph capture (`03-compiler.md` §2) and TypeScript type inference: whether a call site is "an inlined expression" or "an instance of a stateful block" would depend on what the function happened to call. Explicit separation gives the static analyzer a clean rule and gives users a clear mental model for what they are authoring.

### 5.4 No L3

unworklet does not provide a "separate processor + connect" integration layer. The existing Web Audio mechanism — instantiating two `AudioWorkletNode`s and calling `.connect()` on the main thread — already covers this case and lives outside unworklet's API surface. Wrapping it would add weight without value.

Rationale and rejected alternatives: see `decisions-log.md` Q2.

### 5.5 L1 surface details

L1 helpers are pure TypeScript functions that compose `Node<T>` values into new `Node<T>` values, inlined at the call site. The following rules govern what such a function can take, return, and contain.

#### 5.5.1 Two scopes (cross-cutting context)

unworklet code lives in two graph-capture-time scopes:

- **Declaration scope** — the body of `defineProcessor` and `defineSubgraph` directly. New `state.*`, `buffer.*`, `param.*`, `audioInput`, `audioOutput`, and `defineSubgraph` instantiations are created here. Each declaration registers a slot in the graph (and ultimately a region in WASM linear memory).
- **Expression scope** — the `process` lambda body, including its per-block top level and any `forSample` callbacks; L1 helper bodies; `defineSubgraph` `process` lambdas; `everyNSamples` callbacks. Per-block and per-sample expressions live here. New declarations are forbidden in expression scope.

L1 helpers exist purely in expression scope, callable from either the per-block phase top level or inside a `forSample` callback (depending on what the helper's body does).

(Authoritative scope and graph-capture-model definitions: `00-foundations.md` §3.)

#### 5.5.2 Parameters

L1 helpers can receive:

- `Node<T>` values (the most common case),
- `State<T>` references owned by the caller, including their `load` / `store` methods,
- `Param` references owned by the caller, accessed via `param.at(i)` or `param.at(0)`,
- `AudioInputHandle<C>` / `AudioOutputHandle<C>` references for helpers that perform per-sample I/O,
- `Node<'i32'>` for sample-offset `i` when the helper itself uses sample-position primitives,
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
- New `audioInput` / `audioOutput` declarations.
- `message` / `event` declarations.

The following are **allowed**:

- Primitive operators (`add`, `mul`, `tanh`, `select`, …).
- `load` / `store` on `State<T>` references received as parameters.
- `param.at(i)` (with `i` from a surrounding `forSample`) or `param.at(0)` (per-block context) on `Param` references received as parameters.
- `audioIn.at(c, i)` / `audioOut.set(c, i, v)` on handles received as parameters (with `i` from a surrounding `forSample`).
- Buffer access methods (`buf.read` / `buf.write` / `buf.readInterpolated`) on buffer references received as parameters.
- Calls to other L1 helpers.
- `forSample(...)` invocations when the helper itself wants to iterate samples (rare; usually iteration is the caller's job and the helper is invoked from inside the caller's `forSample`).

#### 5.5.6 Error UX

Violations are caught at compile time (during graph capture or static analysis — see `03-compiler.md` §2) and surfaced as build errors before the WASM is emitted, never at runtime. Error messages include a concrete refactor hint pointing at one of the legal patterns. Example:

```text
error: L1 helper 'badHelper' cannot declare state.
  Either:
    (a) accept State<'f32'> as a parameter from the caller, or
    (b) refactor as a defineSubgraph (L2).
  See docs/01-dsl.md §5.2 for the L1 vs L2 boundary.
```

Detailed error-UX policy (Q22-d) is open — see `03-compiler.md` §2.

### 5.6 L2 surface details

L2 subgraphs are reusable, stateful DSP blocks defined with `defineSubgraph`. Each instantiation gets its own state slots, and every instance is inlined into the parent's WASM module.

#### 5.6.1 Body structure (mirrors `defineProcessor`)

A subgraph body has the same two-scope structure as `defineProcessor`: a declaration scope at the top and an expression scope inside a `process` lambda. Inside the `process` lambda, the same per-block-top-level / per-sample-`forSample`-callback split applies. The symmetry is intentional — L2 and root processors share one mental model.

```typescript
const onepole = defineSubgraph((input: Node<'f32'>, coef: Node<'f32'>) => {
  // ━━━ Declaration scope ━━━
  // Per-instantiation state slots; declared once per call site.
  const z = state.f32(0);

  return {
    process: () => {
      // ━━━ Expression scope ━━━
      // For a single-statement subgraph (no per-sample iteration internally), the body is
      // evaluated at the parent's surrounding context: per-block when called from the
      // parent's per-block phase, per-sample when called from inside a forSample.
      const y = add(z.load(), mul(coef, sub(input, z.load())));
      z.store(y);
      return y;
    },
  };
});
```

Subgraphs that need internal per-sample iteration use `forSample` in their own `process` body.

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

`defineSubgraph` results may only be **instantiated in declaration scope** — the body of `defineProcessor` or another `defineSubgraph`, before its `process` lambda. Instantiation inside an expression scope (a `process` body, a `forSample` callback, an L1 helper body) is forbidden.

Each instantiation is a *declaration of an independent state slot*; placing it in declaration scope keeps graph structure predictable (the number of instances is statically determined at compile time) and prevents the misread that subgraphs are runtime-allocated.

Conditional output between configurations is expressed by instantiating both and choosing with `select`:

```typescript
const myProcessor = defineProcessor((ctx) => {
  const main = audioInput ({ channels: 1, name: 'main' });
  const out  = audioOutput({ channels: 1, name: 'main' });
  const useA = param({ default: 1, min: 0, max: 1, automationRate: 'k-rate', name: 'useA' });

  // Two filter instances, each with independent state.
  // (Subgraph argument shape — handle-passing vs Node-passing — is the subject of §5.6.2;
  // this example assumes both instances consume the same audio source.)
  const lpfA = onepole(main, coefA);  // instance #1
  const lpfB = onepole(main, coefB);  // instance #2

  return {
    process: () => {
      forSample((i) => {
        // useA is k-rate 0|1; compare to 1 to get a Node<'bool'> for select.
        out.set(0, i, select(eq(useA.at(i), 1), lpfA, lpfB));
        // Both instances evaluate every sample; select chooses one.
      });
    },
  };
});
```

#### 5.6.5 Body constraints

Inside a subgraph body:

- **Declaration scope** (top of the body, before `return { process }`) allows new `state.*` / `buffer.*` / `param.*` declarations and L2 instantiations of other subgraphs.
- **Expression scope** (inside `process`, including any nested `forSample`) follows the same rules as L1 helpers (§5.5.5): no new declarations, no L2 instantiations; primitives, `load` / `store`, and audio-I/O / param access via `at` / `set` / `param.at(...)` are allowed.

Violations are caught at graph-capture / static-analysis time with refactor-hint error messages, mirroring §5.5.6.

## 6. The `process` phase

unworklet processors run a single execution body, the `process` lambda, on the audio thread every render quantum. Build-time evaluation of `process` captures an AST DAG; the framework emits the DAG as a per-block runtime program (per-block top-level statements run once per render quantum; `forSample` callbacks run per sample). Hard realtime constraints apply (no allocation, no unbounded loops, no I/O). Authoritative shape and semantics: §1, §10, and `decisions-log.md` Q22.

There is **no separate `publish` lambda**. State that the main thread observes (meter, spectrum, etc.) is declared with the `publish` option on `state` / `buffer` (see §3 and `decisions-log.md` Q27-a); worklet → main event delivery is via `eventDecl.emitIf(cond, payload)` from inside `forSample` callbacks (see §4.1); main → worklet messages are handled by `onReceive` registered at the per-block phase top of the `process` body (see §4.2). The framework manages all scheduling — there is no user-visible publish-phase lambda.

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
// vec4 / splat / addVec / mulVec / subVec / divVec are free functions.
// Lane access (`vec.lane(i)`) and SIMD buffer access (`buf.loadVec` / `buf.storeVec`)
// are methods on the value/handle, not free functions.
import { vec4, splat, addVec, mulVec } from '@unworklet/core/simd';
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

#### Memory

SIMD memory access is performed via methods on the `Buffer<'f32'>` handle (see §3.2). Importing `@unworklet/core/simd` makes these methods part of the buffer handle's type:

```typescript
type BufferSimdMethods = {
  loadVec(offset: Node<'i32'>): Node<'f32x4'>;
  storeVec(offset: Node<'i32'>, value: Node<'f32x4'>): void;
};
```

- `buf.loadVec(offset)` — load four contiguous f32 lanes from the buffer (offset in element units; alignment-agnostic per WASM v128 semantics). Typically called inside a `forSample.byN(4, ...)` callback, or at the per-block phase top level (with build-time-loop unrolling) for bulk init.
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
  const scratch = buffer.f32({ size: 128, name: 'scratch' });
  const gain    = param({ default: 1.0, min: 0.0, max: 4.0, automationRate: 'k-rate', name: 'gain' });

  return {
    process: () => {
      // Phase 1: accumulate input into scratch (per-sample).
      forSample((i) => {
        scratch.write(i, main.at(0, i));
      });

      // Phase 2: SIMD bulk gain.
      forSample.byN(4, (i) => {
        const v = scratch.loadVec(i);
        scratch.storeVec(i, mulVec(v, splat(gain.at(i))));
      });

      // Phase 3: drain scratch to output (per-sample).
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

The migration array lives on the **processor's options bag** (the second argument to `defineProcessor`), not in the declaration body — this keeps the processor body focused on the live runtime graph and isolates schema-evolution concerns from per-block / per-sample logic. Each entry's `from` and `to` are schema hashes emitted by `unworklet build` into `dist/schema-hash.json` (see `07-tooling.md`). The framework constructs a directed graph from the entries and finds the path `blob.schemaHash → currentSchemaHash`; entries are applied in order, with each step's output hash verified against its declared `to`.

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
3. If no migration path exists (or a step's hash check fails), the framework falls back to **name-match partial restore**: slots that share name and compatible type with the new schema are written back; the rest are reset to declaration defaults.

The result of `restore(blob)` reports `{ restored, skipped, missing }` so the consumer can surface "preset partially loaded" UX (see `05-client.md` §2.6 / §6).

Authoritative rationale and rejected alternatives: see `decisions-log.md` Q5.

## 9. Sub-rate computation (`everyNSamples`)

Some processor-internal computations (LFO, envelope, FFT, modulation matrix, etc.) only need to update at a coarser rate than the audio rate. unworklet exposes a single primitive — `everyNSamples(N, callback)` — for this. The callback's body is graph-captured and compiled into a sub-block that fires once every `N` audio samples; `state` slots updated inside the callback retain their previous value (zero-order hold) on intermediate samples.

```typescript
const synth = defineProcessor((ctx) => {
  const lfoVal  = state.f32(0, { name: 'lfo' });
  const fftMag  = state.f32(0, { name: 'mag' });
  const inBuf   = buffer.f32({ size: 1024, name: 'fftIn' });
  const audioIn = audioInput({ channels: 1, name: 'main' });
  const out     = audioOutput({ channels: 1, name: 'main' });

  return {
    process: () => {
      forSample((i) => {
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
- **Expression scope only, inside `forSample`**: callable from inside `forSample` callbacks (the typical usage), L1 helper bodies invoked from inside `forSample`, and `defineSubgraph` `process` lambdas (with their own internal `forSample`). Calling it from declaration scope or from the per-block phase top level is a graph-capture-time error — `everyNSamples` requires a surrounding sample loop to gate against.
- **No new declarations inside the callback**: the callback body is an expression scope (same rules as L1 helpers — see §5.5.5). New `state.*` / `buffer.*` / `param.*` / `defineSubgraph` declarations inside the callback are graph-capture-time errors.
- **Sample-position primitives inside the callback**: `audioIn.at(c, i)`, `audioOut.set(c, i, v)`, `param.at(i)` are valid (`i` from the surrounding `forSample`); state and buffer access are valid.

### 9.2 Multiple sub-rate blocks coexist

A `forSample` callback can contain any number of `everyNSamples` blocks at any divisor; they share the audio-rate counter and execute independently:

```typescript
forSample((i) => {
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

forSample((i) => {
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

`forSample` is the only sample-loop primitive in unworklet. The presence of a `forSample` invocation in a `process` body marks the per-sample phase; statements at the top level of the `process` body (= outside any `forSample`) are the per-block phase. There is no implicit form, no sugar wrapping, and no `perBlock` sibling primitive — the per-block phase is "the top level", denoted by lexical position.

### 10.1 Surface

```typescript
function forSample(callback: (i: Node<'i32'>) => void): void;

forSample.byN: (
  stride: number,                           // compile-time positive integer
  callback: (i: Node<'i32'>) => void,
) => void;
```

- `forSample(callback)` — the callback body runs once per sample of the current render quantum. `i` is a `Node<'i32'>` bound at WASM-emission time to the loop counter, advancing by 1 each iteration.
- `forSample.byN(stride, callback)` — same shape, but `i` advances by `stride` each iteration. Typical use is `stride = 4` for SIMD bulk operations paired with `buf.loadVec` / `buf.storeVec` methods. The stride must be a compile-time-constant positive integer; non-constant strides are graph-capture-time errors.

### 10.2 Semantics

- **Graph-capture-time meta primitive**: the callback is evaluated once during graph capture; the resulting AST nodes are recorded as belonging to a per-sample (or per-`stride`) sub-block of the WASM render-quantum program.
- **`i` is loop-counter-bound and scoped to the callback**: inside the callback, `i` denotes the current sample-offset within the render quantum. Outside the callback, `i` is not in scope — TypeScript will reject any sample-position primitive that tries to use it (e.g., `audioIn.at(0, i)` written at the per-block top level is a TS reference error).
- **Arithmetic on `i`**: `add(i, 1)` and similar produce a `Node<'i32'>` that resolves to the offset value at WASM-emission time. Out-of-block access (`add(i, lookaheadSamples)` exceeding the render quantum) is a static-analysis error when statically detectable.
- **Multiple `forSample` calls in one body**: each call is an independent phase. Phases (per-block top-level statements + each `forSample` invocation) execute in **declared (source) order** within the render quantum.
- **No implicit `forSample` wrapping**: per-sample primitives (`audioIn.at(c, i)`, `audioOut.set(c, i, v)`, `param.at(i)`) cannot be written outside a `forSample` callback. The IDE catches this through TypeScript scoping (`i` is undefined). Any per-sample work must live inside a `forSample`.

### 10.3 Body constraints

Inside a `forSample` callback, the same rules as L1 helper bodies (§5.5.5) apply:

- **Forbidden**: new `state.*` / `buffer.*` / `param.*` / `audioInput` / `audioOutput` declarations; new `defineSubgraph` declarations or instantiations.
- **Allowed**: primitive operators, `state.load()` / `state.store()`, sample-position primitives (`audioIn.at(c, i)`, `audioOut.set(c, i, v)`, `param.at(i)`), buffer access, calls to L1 helpers, `everyNSamples`, nested `forSample` (rare; typically used for tile iteration in 2D buffers).

### 10.4 Examples

#### 10.4.1 Single-phase (one `forSample`, no per-block work)

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

#### 10.4.2 Multi-phase (interleaved per-block and per-sample, with SIMD)

```typescript
const simdProc = defineProcessor((ctx) => {
  const main    = audioInput ({ channels: 1, name: 'main' });
  const out     = audioOutput({ channels: 1, name: 'main' });
  const scratch = buffer.f32({ size: 128, name: 'scratch' });
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
- The callback signature is `(i: Node<'i32'>) => void`; non-`void` returns are not part of the v1.0.0 surface.
- Future additive primitives (`forSample.parallel(callback)` for unordered-iteration optimization opportunities, `forSampleRange(start, end, callback)` for partial-block iteration, etc.) can be introduced in v1.x.0 without breaking the v1.0.0 surface.

Authoritative rationale and rejected alternatives: see `decisions-log.md` Q22 (Q22-aprime).
