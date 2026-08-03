# 02 — Messaging (typed event family / publish-state contract)

Runtime contract for typed main↔worklet communication. Schema declaration syntax lives in `01-dsl.md` §3 (`state.publish`) and §4 (the `event` family — `event<T>({ to: 'main' })` worklet → main, `event<T>({ from: 'main' })` main → worklet); this doc covers the wire-level contract, queue behavior, and delivery guarantees. MIDI uses a specialization of the same machinery — cross-references to `11-midi.md` are noted inline where the wire format is shared.

Throughout this doc, **`event<T>({ to: 'main' })`** names the worklet → main direction (sample-accurate, worklet emits via `eventDecl.emitIf`) and **`event<T>({ from: 'main' })`** names the main → worklet direction (worklet receives via `eventDecl.onReceive`). They are one declaration family discriminated by `from` / `to`; the wire-level slot layout differs per direction (§5).

## Status

written

## 1. Send / receive surface

Main thread (per `05-client.md` §2):

- `node.state.<name>.value` / `.subscribe(handler)` — read or listen to a published state / buffer slot (read-only).
- `node.events.<name>.on(handler) → unsubscribe` — subscribe to a worklet → main `event<T>({ to: 'main' })`.
- `node.events.<name>.diagnostics.overflowCount()` — monotonic counter for dropped events.
- `node.events.<name>.emit(payload)` — send an `event<T>({ from: 'main' })` to the worklet.
- `node.events.<name>.diagnostics.overflowCount()` — monotonic counter for dropped main → worklet events.

Worklet (per `01-dsl.md` §3 / §4):

- `state.<type>(initial, { ..., publish: { rateFps } })` / `state.buffer.<type>({ ..., publish: { rateFps } })` — declare a published state slot. Writes via `slot.write(...)` / `buf.write(...)` are visible on main at the next publish tick.
- `eventDecl.emitIf(cond, payload)` — emission primitive across **every** audio-thread expression context: `forSample` / `forSample.byN` callbacks, `everyNSamples` callbacks (taken from the surrounding `forSample` callback's second argument), `event.midi({ from: 'main' }).onEvent(...)` handlers, `eventDecl.onReceive(...)` handlers (for an `event<T>({ from: 'main' })` declaration), and the per-block top level (= statements in the `process` body outside any `forSample`). `cond` accepts `Node<'bool'> | boolean`; in handler context and at per-block top level, `emitIf(true, payload)` is the canonical spelling for unconditional 1:1 emission (the `atSample` is supplied by the caller — typically `0` at the per-block top, or the inbound event's `atSample` in a handler). Inside `forSample`, a constant-truthy `cond` is a static-analysis error — see Q32-c. There is no separate `emit(...)` method; `emitIf` is the single emission primitive (Q32-a).
- `eventDecl.onReceive(handler)` — register a handler for an `event<T>({ from: 'main' })` declaration at per-block top of `process`. Runs on the audio thread at the start of the **current** render quantum (worklet author's viewpoint; from main, this is the next quantum after `node.events.<name>.emit(...)` — same moment, viewpoint difference only, see Q38-a). **All handlers across all main → worklet events and MIDI inputs drain first, before any per-block top-level statement or `forSample` runs** (Q38-b) — the `process` body's source-order rule (`01-dsl.md` §1) applies to graph capture, not to runtime ordering. A single event declaration may have multiple `onReceive` registrations; all run in registration order (Q38-c). Inside a handler, `state.read()` returns the value at the start of the current quantum (= previous quantum's last write); `state.write(v)` is observable in the same quantum's per-block computation and `forSample` (Q38-d). Handler bodies obey the same realtime-safety invariants as the rest of the audio-thread code path: no allocation, no I/O, no unbounded loops. Build-time JS loops inside the handler must have a build-time-constant upper bound (see Q31-b); for bulk transfer of typed-array payload fields, use `buf.copyFrom(payloadField)` (Q31-c). For per-slot fan-out into a state-slot array, use the build-time-unroll + `select`/`lt` mask pattern (Q31-d). Handler bodies follow the same expression-scope rules as `forSample` callbacks (Q56, `decisions-log.md`): `eventDecl.emitIf(...)` / `midiOut.emitIf(...)` for sample-accurate projection of incoming events, audio I/O (`audioIn.at` / `audioOut.set` / `param.at`), subgraph methods, and L1 helper calls are all legal alongside `state` / buffer writes; new declarations are not. Sample-offset arguments accept `Node<'i32'> | number` from any source — the handler's own `atSample` arg (= **MIDI handlers only**; `event<T>({ from: 'main' })` handlers do not carry `atSample` since main-thread sends have no sample-offset concept, per §5.3), a state slot, a buffer read, or a JS literal.

MIDI (`event.midi({ from: 'main' })` / `event.midi({ to: 'main' })`) shares **the ring buffer header layout + Atomics protocol** described in §4 and §5 with the `event<T>` family; the slot encoding and the main → worklet sample-offset path differ per direction. Concretely: `event<T>({ to: 'main' })` ringbuffer slots carry `atSample` (worklet → main); `event<T>({ from: 'main' })` slots have no `atSample` (main → worklet, no sample-offset concept); `event.midi({ from: 'main' })` slots carry `atSample` in a different byte position (`11-midi.md` §4.1) and `node.midi.<name>.send(event, atTime?)` converts an absolute `atTime` to block-local `atSample` at injection (Q4 + `11-midi.md` §4.2). "Same machinery" means "same SAB + Atomics + header + drop-oldest + overflowCount", not "same wire-level slot layout".

### 1.1 Asset upload readiness pattern (no separate ack surface)

`node.events.<name>.emit(payload)` is **fire-and-forget** by design — it returns `void`, not a Promise. Reflection of the payload onto the audio thread happens at the start of the **current** render quantum from the worklet's viewpoint (= the next render quantum from the main thread's viewpoint after `node.events.<name>.emit(...)` is called — they refer to the same moment; see `decisions-log.md` Q38-a). At that moment the audio thread drains the event ringbuffer and runs the registered `onReceive` handler. This is the same delivery latency for every transport mode (SAB / postMessage); main-side `await` would not change _when_ the audio thread sees the data, only _whether_ main can know it has been seen.

Consequently, unworklet does not provide an ack-style event variant. When the main thread needs to observe that an upload has been reflected on the audio thread (e.g. clear a "loading" UI state, gate playback start), the canonical pattern is to publish a slot from inside the `onReceive` handler and subscribe on main:

```typescript
// worklet
const sampleBuf = state.buffer.f32({ size: SAMPLE_BUFFER_LEN }).named("sampleBuf");
const sampleLen = state.i32(0).expose({ name: "sampleLen", publish: { rateFps: 30 } });
const upload = event<{ samples: Float32Array }>({ from: "main", name: "upload" });

upload.onReceive(({ samples }) => {
  sampleBuf.copyFrom(samples);
  sampleLen.write(samples.length); // becomes visible on main at the next publish tick
});

// main
node.events.upload.emit({ samples: decoded.getChannelData(0) }); // void

const ready = new Promise<void>((resolve) => {
  const unsub = node.state.sampleLen.subscribe((n) => {
    if (n > 0) {
      unsub();
      resolve();
    }
  });
});
await ready;
playButton.disabled = false;
```

Authors that need "asset must be present before the first render quantum" use the snapshot/restore path instead — see `05-client.md` §2.6: the canonical 2-step pattern is `const node = await createNode(audioContext, processor); await node.restore(blob);` (Q57). The audio-thread-side defense against "asset not yet uploaded" (e.g. gating voice triggers on `sampleLen.read() > 0`) lives in the processor's own state machine; the framework does not synthesize a generic readiness flag.

Authoritative rationale: `decisions-log.md` Q27-a (publish surface) + Q27-c (`event<T>({ from: 'main' })` fire-and-forget contract).

## 2. Delivery semantics

| Surface                      | Coalesce             | Ordering                             | Drained                                                                                                                                                                                                                                                                                                            | Backpressure                      |
| ---------------------------- | -------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `state.publish`              | latest-wins per slot | (no queue)                           | every publish tick (audio thread copies into shared region)                                                                                                                                                                                                                                                        | none — slot is overwritten freely |
| `event<T>({ to: 'main' })`   | preserve all         | sample-arrival-order with `atSample` | continuously by main thread reader                                                                                                                                                                                                                                                                                 | drop-oldest + `overflowCount`     |
| `event<T>({ from: 'main' })` | preserve all         | main-arrival-order                   | start of each render quantum (worklet author's viewpoint = the **current** quantum; from main this is the quantum **after** the `node.events.<name>.emit(...)` call — same moment, viewpoint difference only, per Q38-a), before any per-block top-level statement or `forSample` (handlers drain first per Q38-b) | drop-oldest + `overflowCount`     |

Common guarantees:

- **No mid-sample mutation**: `state.publish` copies happen at scheduler tick boundaries; main never sees a half-written slot. `event<T>({ to: 'main' })` writes commit one slot at a time, atomically.
- **Non-blocking on the audio thread**: emission and publish never wait for the main thread. If a ringbuffer is full, the oldest entry is overwritten and the overflow counter advances by 1.
- **Sample-accurate `atSample` end-to-end**: every `event<T>({ to: 'main' })` payload carries a block-local sample-offset (`0..SAMPLES_PER_BLOCK-1`). The wire format preserves it; main-side handlers receive it as an unwrapped field.
- **No reordering**: `event<T>({ to: 'main' })` consumers see events in the order they were emitted within a block; across blocks, this-block events are observed before next-block events.

## 3. Queue sizing and overflow policy

Default capacities:

- `event<T>({ to: 'main' })`: 256 slots (uniform with MIDI Q4-c-i).
- `event<T>({ from: 'main' })`: 256 slots.
- `state.publish`: 1 slot per declared state (no queue — coalesce-latest).

Override via the `capacity` option on `event<T>` in either direction (see `01-dsl.md` §4).

**`Capacity` literal-union members** (Q44, top-level exports from `@unworklet/core`): `CAPACITY_16` / `CAPACITY_32` / `CAPACITY_64` / `CAPACITY_128` / `CAPACITY_256` / `CAPACITY_512` / `CAPACITY_1024` / `CAPACITY_2048` / `CAPACITY_4096` / `CAPACITY_8192` / `CAPACITY_16384` — all 11 values are powers of 2 from 2⁴ to 2¹⁴. The power-of-2 constraint enables the bitmask `head & (capacity - 1)` (§5.5 producer protocol) to wrap in a single instruction. Arbitrary integer literals (e.g. `capacity: 100`) are rejected at TypeScript level by the literal-union narrow — no build-time / runtime check is needed. The same set applies to `event.midi({ from: 'main', capacity })` / `event.midi({ to: 'main', capacity })` (`11-midi.md` §1).

Overflow policy is **drop-oldest + monotonic counter** for the `event<T>` family in both directions:

- The oldest slot is overwritten on overflow. Producers (worklet for `event<T>({ to: 'main' })`, main for `event<T>({ from: 'main' })`) never block.
- A monotonic `overflowCount` is exposed via `node.events.<name>.diagnostics.overflowCount()` for either direction.
- Drop-oldest matches MIDI Q4-c-iv. The same rationale applies: preserve recent events; let consumers detect saturation through the counter.

`state.publish` does not overflow — slot writes are absolute, and the publisher always wins the latest value.

## 4. SAB vs postMessage path

The framework selects a transport at processor instantiation, transparent to user code. API surface is identical; latency / accuracy differ.

|                              | SAB available (default)                                                          | SAB unavailable                                                                                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cross-origin isolation       | required (COOP/COEP)                                                             | not required                                                                                                                                                                                           |
| `state.publish` propagation  | atomic store/load on shared `f32` / `i32` regions; buffers via `memcpy`          | flag-bearing postMessage at render-quantum boundary                                                                                                                                                    |
| `event<T>` (both directions) | `SharedArrayBuffer`-backed ring buffer with `Atomics`-based head / tail pointers | pre-allocated transferable buffers (main allocates regions at instantiation; audio thread encodes into them at the render-quantum boundary and `postMessage(...buffer, [buffer])` transfers ownership) |
| Sample-accurate `atSample`   | preserved end-to-end                                                             | preserved on the wire; main-side delivery picks up render-quantum batching latency                                                                                                                     |
| Audio-thread allocation      | none                                                                             | none (transfer regions pre-allocated by main)                                                                                                                                                          |

Active mode is exposed via `node.diagnostics.transport` (`'sab'` / `'postMessage'`). Full degradation policy and consumer guidance: `08-deployment.md` §3.

## 5. Wire format

### 5.1 `event<T>({ to: 'main' })` ringbuffer slot

Each slot in an `event<T>({ to: 'main' })` ring buffer occupies a fixed-size block determined at compile time from the per-field wire types resolved at the `emitIf` call sites:

```
[ atSample      : u32 ]   // block-local sample-offset
[ T fields      : ... ]   // fixed-size record fields from T; per-field wire
                          // type resolved at emit time (Q71)
[ payloadLen    : u32 ]   // 0 if T has no variable-length field
[ payloadOffset : u32 ]   // index into the variable-length content buffer (when present)
```

**Per-field wire type resolution (Q71)**: each numeric field's wire width is decided by the `Node<T>` value supplied at the `emitIf` call site — `Node<'f32'>` / `Node<'i32'>` → 4 bytes, `Node<'f64'>` / `Node<'i64'>` → 8 bytes, `Node<'bool'>` → 1 byte (with implicit `u32` alignment within the slot). The declared `T` carries field **names** and a coarse type family (numeric / boolean / typed-array); the precise wire type for each numeric field is supplied by the emit site.

**Slot-size constancy**: although wire types are resolved at emit time, slot size for a given `event<T>({ to: 'main' })` declaration is build-time-constant — the framework rejects emit sites whose per-field `Node<T>` types disagree with each other across call sites for the same event handle as a graph-capture-time error.

**Single variable-length field limit (v1.0.0)**: `T` may contain **at most one** variable-length field (= `Float32Array`, `Uint8Array`, etc.). A declared `T` with more than one variable-length field is a graph-capture-time error. The slot carries one `payloadLen` / `payloadOffset` pair sized for that single field; the TS surface mirrors this with the single-field constraint. Forward-compatible: a v1.x.0 surface could extend the slot layout to carry multiple `payloadLen` / `payloadOffset` pairs without changing the v1.0.0 single-field path.

Slot count and byte size are decided at processor instantiation. Pointers (`head`, `tail`) increment by 1 per event, slot-indexed — slot-boundary misreads are structurally impossible. Same approach as MIDI Q4-c.

### 5.2 Variable-length payload content buffer

When `T` contains a variable-length field (`Float32Array`, `Uint8Array`, etc.), an additional content buffer is allocated alongside the main ring buffer. The slot's `payloadOffset` indexes into the content buffer; `payloadLen` records the field length in bytes. Each live payload occupies a distinct content chunk, so multiple payloads queued before the consumer drains do not overwrite one another.

Capacity for the content buffer is `perPayload × min(ringCapacity, 16)`, where `perPayload` is the per-payload byte size (`payloadCapacity` option, default 64 KiB) and the chunk count is capped at **16** to keep the default allocation bounded (= Q85; a big payload × the full 256-slot default ring would otherwise reserve 16 MB). The producer cycles through the 16 chunks: if more than 16 typed-array payloads are queued before the consumer drains, the oldest content is overwritten (drop-oldest) — never a trap. An individual payload larger than the whole content region is truncated to fit (`payloadLen` records the copied byte count) rather than overflowing — also never a trap, on either the main thread (SAB / postMessage injector) or the audio thread. For main → worklet this means up to 16 typed-array messages sent within one render quantum (≈ 2.7 ms) are all preserved. This is the same machinery used for MIDI sysex (Q4-c-iii); one transport implementation covers both.

### 5.3 `event<T>({ from: 'main' })` ringbuffer slot

Same slot structure as `event<T>({ to: 'main' })` (§5.1), minus `atSample` (main has no sample-offset concept):

```
[ T fields      : ... ]
[ payloadLen    : u32 ]
[ payloadOffset : u32 ]
```

Per-field wire type is decided **per field**, seeded at the worklet-side proxy. A `number` field defaults to a 4-byte f32 (the declared fractional value survives across the wire); a `boolean` field seals to a 1-byte bool the moment it is consumed in a bool sink (`state.bool.write` / `buffer.bool` write / `select` cond / `not` / `emitIf` cond). Typed-array fields go through the §5.2 variable-length content buffer. The declaration's `fields[].wireType` is the single source of truth read by (a) the WASM `messageFieldRead` emit path, (b) the three transport encode sites (main-side SAB inject / worklet postMessage fallback / offline harness), and (c) the main-side witness type derivation. Distinct from the `event<T>({ to: 'main' })` per-field emit-time rule of Q71: there the field type is decided at the emit call site's `Node<T>`; here it is decided at the worklet-side usage of the proxy field, since `event<T>({ from: 'main' })` enters as plain JS from `node.events.<name>.emit(payload)` on main and there is no `Node<T>` site to inspect at send time.

### 5.4 `state.publish` shared region

Each published `state.<type>` slot has a fixed shared region of size `sizeof(type)`. Each published `state.buffer.<type>({ size, ... })` slot has a region of size `size × sizeof(type)`. The audio thread writes via `Atomics.store` (scalar) or `memcpy` (buffer); the main thread reads via `Atomics.load` (scalar) or a structured view (buffer).

Scalar `state.<type>` publish accepts only `state.f32` / `state.i32` / `state.bool` (Q42, `decisions-log.md`) — all three are single 32-bit words readable/writable in one `Atomics` op. `state.bool` is held internally as `i32` (0 / 1) and cast to `boolean` for main-side delivery. `state.f64` / `state.i64` reject the `publish` option at TypeScript level: their values are 2-word and would expose the same torn-read pattern as buffers (deferred to v1.x.0; same axis as Q27-f).

The SAB region for these scalars is exposed internally as a single `Int32Array` view (JS `Atomics` is restricted to integer typed arrays by the language spec, so a `Float32Array` view cannot be passed to `Atomics.store` / `Atomics.load`). `state.f32` and `state.bool` go through the same `Int32Array` view by bit-reinterpret: f32 values are `Math.fround`-normalized then reinterpreted as i32 bits (`new Int32Array(new Float32Array([v]).buffer)[0]` semantics) for `Atomics.store`; bool values are stored as `0` / `1`. The wire byte layout is little-endian IEEE 754 — main and worklet are guaranteed to share the same view placement, so the bit pattern observed on either side is identical.

A small per-slot notification region (one `i32` "version" counter) is incremented **unconditionally** on each **due tick** (= the render quantum where the per-slot sample counter has reached the threshold derived from `rateFps`; see `04-worklet-runtime.md` §7 for the scheduler and Q39-a, `decisions-log.md`): the audio thread does not compare against the previous value — it stores the current value and increments the counter every due tick. Main-side subscribers observe this counter to deliver `subscribe(handler)` callbacks; the framework does not perform value-equality dedupe on the main side either, so handlers fire on every due tick regardless of whether the value changed (Q39-b). Same-value dedupe, if needed, is the handler author's responsibility (one-line `if (newVal === lastVal) return`).

> **v1.0.0 limitation — torn reads on multi-byte regions**: copying a published `state.buffer.<type>` into its shared region is **not atomic at the region level** (WebAssembly `memory.copy` is byte-wise). A main-thread reader observing the region during an audio-thread copy can see a partially-updated region. For visual UX (waveform, spectrum) the impact is one inconsistent frame restored within 33 ms — visually undetectable in practice. For main-side numerical analysis or persistence, this manifests as occasional outliers. Double-buffered region transport is a v1.x.0 mandatory upgrade — see `decisions-log.md` Q27-f and `10-roadmap.md` §3. Scalar `state.<type>` writes are unaffected (already atomic via `Atomics.store`).

`state.buffer.<T>` publish element-type constraint: unlike `state.<type>` publish, **all element types are accepted** (= `state.buffer.f32` / `state.buffer.f64` / `state.buffer.i32` / `state.buffer.i64` / `state.buffer.bool` / `state.buffer.u8` are all publishable). The entire region is copied via `memcpy` with no single-atomic-op constraint (= the torn-read-tolerant design noted above). The handler argument type on the main-side subscriber is narrowed per declaration kind (= `state.buffer.f32` publish → `Float32Array`, `state.buffer.f64` → `Float64Array`, `state.buffer.i32` → `Int32Array`, `state.buffer.i64` → `BigInt64Array`, `state.buffer.bool` → `Uint8Array` (0/1), `state.buffer.u8` → `Uint8Array`).

### 5.5 `Atomics` protocol (SAB mode)

Ring buffer header (one per `event<T>` declaration, either direction):

```
[ head          : i32 ]   // producer-incremented; consumer reads via Atomics.load
[ tail          : i32 ]   // consumer-incremented; producer reads via Atomics.load
[ overflowCount : i32 ]   // producer-incremented when head wraps past tail
```

Producer protocol (worklet for `event<T>({ to: 'main' })`, main for `event<T>({ from: 'main' })`):

1. Read `head`, compute write position `head & (capacity - 1)` (capacities are powers of 2).
2. Read `tail`. If `head - tail >= capacity`, the ring is full and the next write would overwrite an unread entry — increment `overflowCount` and advance `tail` by 1 (drop-oldest). `head` and `tail` are monotonically increasing `i32`; the distance `head - tail` is the live slot count, so the framework declares "capacity = N" as "N slots are live-fill before drop-oldest engages" without the textbook ring-buffer `+1` reservation.
3. Write the slot fields.
4. `Atomics.store(head, head + 1)` — release fence; visible to consumer.

Consumer protocol:

1. Read `head` (acquire) and `tail`. If equal, no events.
2. Read slot at `tail & (capacity - 1)`.
3. `Atomics.store(tail, tail + 1)`.

`state.publish` slots use a simpler protocol — producer `Atomics.store` on write, consumer `Atomics.load` on read. The 1-deep coalesce removes the head/tail pair; the version counter (§5.4) carries change notification.

Authoritative rationale and rejected alternatives: `decisions-log.md` Q27.
