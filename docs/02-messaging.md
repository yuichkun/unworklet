# 02 — Messaging (typed message / event / publish-state contract)

Runtime contract for typed main↔worklet communication. Schema declaration syntax lives in `01-dsl.md` §3 (`state.publish`) and §4 (`event<T>` / `message<T>`); this doc covers the wire-level contract, queue behavior, and delivery guarantees. MIDI uses a specialization of the same machinery — cross-references to `11-midi.md` are noted inline where the wire format is shared.

## Status

written

## 1. Send / receive surface

Main thread (per `05-client.md` §2):

- `node.state.<name>.value` / `.subscribe(handler)` — read or listen to a published state / buffer slot (read-only).
- `node.events.<name>.on(handler) → unsubscribe` — subscribe to a worklet → main `event<T>`.
- `node.events.<name>.diagnostics.overflowCount()` — monotonic counter for dropped events.
- `node.messages.<name>(payload)` — send a `message<T>` to the worklet.
- `node.messages.<name>.diagnostics.overflowCount()` — monotonic counter for dropped messages.

Worklet (per `01-dsl.md` §3 / §4):

- `state.<type>(initial, { ..., publish: { rateFps } })` / `buffer.<type>({ ..., publish: { rateFps } })` — declare a published state slot. Writes via `slot.store(...)` / `writeBuffer(...)` are visible on main at the next publish tick.
- `emitIf(cond, eventDecl, payload)` — conditional emission inside `forSample`; the only path to push an event onto the worklet → main wire.
- `messageDecl.onReceive(handler)` — register a handler at the per-block phase top of `process`. Runs at the start of the next render quantum, before any `forSample`.

The same ringbuffer machinery serves MIDI (`midiInput` / `midiOutput`); MIDI's surface is type-discriminated by event class (`onEvent('noteOn', ...)` etc.), but underneath it shares the SAB ringbuffer + `Atomics` protocol described in §4 and §5.

## 2. Delivery semantics

| Surface | Coalesce | Ordering | Drained | Backpressure |
|---|---|---|---|---|
| `state.publish` | latest-wins per slot | (no queue) | every publish tick (audio thread copies into shared region) | none — slot is overwritten freely |
| `event<T>` | preserve all | sample-arrival-order with `atSample` | continuously by main thread reader | drop-oldest + `overflowCount` |
| `message<T>` | preserve all | main-arrival-order | start of each render quantum, before any `forSample` | drop-oldest + `overflowCount` |

Common guarantees:

- **No mid-sample mutation**: `state.publish` copies happen at scheduler tick boundaries; main never sees a half-written slot. `event<T>` writes commit one slot at a time, atomically.
- **Non-blocking on the audio thread**: emission and publish never wait for the main thread. If a ringbuffer is full, the oldest entry is overwritten and the overflow counter advances by 1.
- **Sample-accurate `atSample` end-to-end**: every `event<T>` payload carries a block-local sample-offset (`0..renderQuantum-1`). The wire format preserves it; main-side handlers receive it as an unwrapped field.
- **No reordering**: `event<T>` consumers see events in the order they were emitted within a block; across blocks, this-block events are observed before next-block events.

## 3. Queue sizing and overflow policy

Default capacities:

- `event<T>`: 256 slots (uniform with MIDI Q4-c-i).
- `message<T>`: 256 slots.
- `state.publish`: 1 slot per declared state (no queue — coalesce-latest).

Override via the `capacity` option on `event<T>` / `message<T>` (see `01-dsl.md` §4).

Overflow policy is **drop-oldest + monotonic counter** for both `event<T>` and `message<T>`:

- The oldest slot is overwritten on overflow. Producers (worklet for `event<T>`, main for `message<T>`) never block.
- A monotonic `overflowCount` is exposed via `node.events.<name>.diagnostics.overflowCount()` / `node.messages.<name>.diagnostics.overflowCount()`.
- Drop-oldest matches MIDI Q4-c-iv. The rationale (preserve recent events; let consumers detect saturation through the counter) carries over unchanged.

`state.publish` does not overflow — slot writes are absolute, and the publisher always wins the latest value.

## 4. SAB vs postMessage path

The framework selects a transport at processor instantiation, transparent to user code. API surface is identical; latency / accuracy differ.

| | SAB available (default) | SAB unavailable |
|---|---|---|
| Cross-origin isolation | required (COOP/COEP) | not required |
| `state.publish` propagation | atomic store/load on shared `f32` / `i32` regions; buffers via `memcpy` | flag-bearing postMessage at render-quantum boundary |
| `event<T>` / `message<T>` | `SharedArrayBuffer`-backed ring buffer with `Atomics`-based head / tail pointers | postMessage with structured-clone payloads |
| Sample-accurate `atSample` | preserved end-to-end | preserved on the wire; main-side delivery picks up render-quantum batching latency |
| Audio-thread allocation | none | none (transfer regions pre-allocated by main) |

Active mode is exposed via `node.diagnostics.transport` (`'sab'` / `'postMessage'`). Full degradation policy and consumer guidance: `08-deployment.md` §3.

## 5. Wire format

### 5.1 `event<T>` ringbuffer slot

Each slot in an `event<T>` ring buffer occupies a fixed-size block determined at compile time from `T`:

```
[ atSample      : u32 ]   // block-local sample-offset
[ T fields      : ... ]   // fixed-size record fields from T
[ payloadLen    : u32 ]   // 0 if T has no variable-length field
[ payloadOffset : u32 ]   // index into the variable-length content buffer (when present)
```

Slot count and byte size are decided at processor instantiation. Pointers (`head`, `tail`) increment by 1 per event, slot-indexed — slot-boundary misreads are structurally impossible. Same approach as MIDI Q4-c.

### 5.2 Variable-length payload content buffer

When `T` contains a variable-length field (`Float32Array`, `Uint8Array`, etc.), an additional content buffer is allocated alongside the main ring buffer. The slot's `payloadOffset` indexes into the content buffer; `payloadLen` records the field length in bytes.

Capacity for the content buffer follows the largest expected payload × ring-buffer slot count, with an override on `event<T>({ ..., payloadCapacity: <bytes> })`. This is the same machinery used for MIDI sysex (Q4-c-iii); one transport implementation covers both.

### 5.3 `message<T>` ringbuffer slot

Identical slot layout to `event<T>`, minus `atSample` (main has no sample-offset concept):

```
[ T fields      : ... ]
[ payloadLen    : u32 ]
[ payloadOffset : u32 ]
```

### 5.4 `state.publish` shared region

Each published `state.<type>` slot has a fixed shared region of size `sizeof(type)`. Each published `buffer.<type>({ size, ... })` slot has a region of size `size × sizeof(type)`. The audio thread writes via `Atomics.store` (scalar) or `memcpy` (buffer); the main thread reads via `Atomics.load` (scalar) or a structured view (buffer).

A small per-slot notification region (one `i32` "version" counter) is incremented on each publish tick where the value changed. Main-side subscribers observe this counter to deliver `subscribe(handler)` callbacks.

### 5.5 `Atomics` protocol (SAB mode)

Ring buffer header (one per `event<T>` / `message<T>` declaration):

```
[ head          : i32 ]   // producer-incremented; consumer reads via Atomics.load
[ tail          : i32 ]   // consumer-incremented; producer reads via Atomics.load
[ overflowCount : i32 ]   // producer-incremented when head wraps past tail
```

Producer protocol (worklet for `event<T>`, main for `message<T>`):

1. Read `head`, compute write position `head & (capacity - 1)` (capacities are powers of 2).
2. Read `tail`. If `head + 1 - tail >= capacity`, the next slot would overwrite an unread entry — increment `overflowCount` and proceed (drop-oldest).
3. Write the slot fields.
4. `Atomics.store(head, head + 1)` — release fence; visible to consumer.

Consumer protocol:

1. Read `head` (acquire) and `tail`. If equal, no events.
2. Read slot at `tail & (capacity - 1)`.
3. `Atomics.store(tail, tail + 1)`.

`state.publish` slots use a simpler protocol — producer `Atomics.store` on write, consumer `Atomics.load` on read. The 1-deep coalesce removes the head/tail pair; the version counter (§5.4) carries change notification.

Authoritative rationale and rejected alternatives: `decisions-log.md` Q27.
