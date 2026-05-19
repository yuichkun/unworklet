# 05 — Client (`@unworklet/core`)

The main-thread API. Wraps the standard `AudioWorkletNode` with a typed surface for params, messages, and events, and manages module loading, readiness, and disposal.

## Status

partial (§2 surface listing + §2.6 snapshot/restore + §5 event/state subscription + §6 timing + §7 latency-comp written; §1, §3, §4 placeholder)

## 1. `createNode`

```typescript
createNode<C>(
  context: BaseAudioContext,
  processor: CompiledProcessor<C>,
  options?: CreateNodeOptions<C>,
): Promise<UnworkletNode<C>>;

type CreateNodeOptions<C> = {
  // Per-param initial values; key is the param `name`, value is the initial number.
  initial?: Partial<Record<string, number>>;

  // Snapshot blob to restore on creation (alternative to `initial`); applied
  // before the first render quantum. Schema mismatch routed through the
  // processor's `migrations` chain (see `01-dsl.md` §8.3).
  restore?: Uint8Array;
};
```

Loads the WASM module (cached across calls), adds the Worklet module to the `AudioWorkletGlobalScope` if not already present, instantiates the underlying `AudioWorkletNode` with `numberOfInputs` / `numberOfOutputs` / `outputChannelCount` derived from the processor's `audioInput` / `audioOutput` declarations (no overrides from main side — declaration count is authoritative), and awaits the worklet's readiness handshake before resolving the returned promise.

## 2. `UnworkletNode<C>` surface

The `UnworkletNode<C>` shape exposes the following members:

- **`.node: AudioWorkletNode`** — raw `AudioWorkletNode` for advanced graph wiring not covered by the typed surface.
- **`.inputs.<name>`** — typed `connect()` / disconnection wrapper per declared `audioInput`. See `01-dsl.md` §1.6.
- **`.outputs.<name>`** — typed `connect()` / disconnection wrapper per declared `audioOutput`.
- **`.params.<name>: AudioParam`** — real Web Audio `AudioParam` (`setValueAtTime` / `linearRampToValueAtTime` / `exponentialRampToValueAtTime` / connection-from-`AudioNode` all work).
- **`.state.<name>.value: T`** — current value of a `state.publish` (or `buffer.publish`) slot. Returns the most recently published value synchronously. Read-only. `T` follows the declared slot type: `number` for `state.f32` / `state.i32`, `boolean` for `state.bool` (the framework casts the internal `i32` 0/1 representation; see Q42 in `decisions-log.md`); typed-array view for `buffer.<type>`. `state.f64` / `state.i64` do not accept `publish` in v1.0.0.
- **`.state.<name>.subscribe(handler) → unsubscribe`** — listen for updates on a published state / buffer slot. Handler fires on every publish tick where the version counter has advanced — the framework does not compare values, so handlers receive every published update including identical re-publishes (Q39-b, `decisions-log.md`; see §5.2 for the dedupe pattern if you need it).
- **`.events.<name>.on(handler) → unsubscribe`** — typed subscriber per declared `event<T>`. Handler receives the payload (including `atSample`).
- **`.events.<name>.diagnostics.overflowCount(): number`** — monotonic counter of dropped events (see `02-messaging.md` §3).
- **`.messages.<name>(payload): void`** — typed sender per declared `message<T>`. Fire-and-forget; in-arrival-order delivery, drained at the start of each render quantum on the worklet side.
- **`.messages.<name>.diagnostics.overflowCount(): number`** — monotonic counter of dropped messages.
- **`.midi.<name>.send(event, atTime?)`** — source-agnostic MIDI inject on a declared `midiInput({ name })`. Namespaced per port to allow multi-port processors (Q40, `decisions-log.md`). See `11-midi.md` §3.
- **`.midi.<name>.connectFromWebMIDI(input)`** — Web MIDI bridge convenience on a declared `midiInput({ name })`.
- **`.midi.<name>.onEvent(type, handler) → unsubscribe`** — typed MIDI event subscriber on a declared `midiOutput({ name })`. See `11-midi.md` §2.
- **`.midi.<name>.diagnostics.overflowCount(): number`** — monotonic counter of dropped MIDI events for the named port.
- **`.diagnostics.transport: 'sab' | 'postMessage'`** — active transport mode (see `02-messaging.md` §4 and `08-deployment.md` §3).
- **`.dispose()`** — tear down node, queues, worklet runtime, all subscribers.
- **`.onError(handler)`** — error subscription (worklet traps, queue overflow events, SAB-mode change diagnostics).

The `.params.<name>` shape is a real `AudioParam` — distinct from the worklet-side `param.at(i)` graph-capture form. Main-thread JS uses standard Web Audio APIs; the worklet-side primitive is graph-capture only.

The `.state.<name>` surface is **read-only on main**. Writing to a worklet-side state slot from main is not supported by design — main-driven state changes go through `params.<name>` (continuous values), `messages.<name>(payload)` (discrete commands), or `restore(blob)` (full state reload). Authoritative rationale: `decisions-log.md` Q27-a.

### 2.6 Snapshot / restore / inspect

`UnworkletNode<C>` exposes three methods for state persistence — their contract is declared by the processor (see `01-dsl.md` §8):

- **`snapshot(options?: { profile?: string }): Promise<Uint8Array>`** — capture the current state slots into a binary blob. Without `profile`, all slots flagged `'persistent'` are included (the union across profiles for declarations using the record form). With `profile`, only slots flagged `'persistent'` for that named profile are included.

- **`restore(blob: Uint8Array): Promise<RestoreResult>`** — write the blob's slot values back into the running processor.

  ```typescript
  type RestoreResult =
    | {
        ok: true;
        applied:  string[];     // migration step labels that successfully ran (in order); empty when schema hash matched and no migration was needed
        restored: number;       // slots successfully written
        skipped:  string[];     // slot names that existed in the blob but mismatched type/size in the current schema
        missing:  string[];     // current schema slots that the blob did not carry — initialized from declaration default
      }
    | {
        ok: false;
        error: {
          step:    string;      // 'fromHash → toHash' label of the migration step that threw
          message: string;      // error message extracted from the thrown value
          cause:   unknown;     // the thrown value itself (typically an Error instance)
        };
        applied:  string[];     // migration steps that ran successfully before the failing step
        restored: number;
        skipped:  string[];
        missing:  string[];
      };
  ```

  `ok: true` means the migration chain completed without throwing — `skipped` / `missing` may still be non-empty when the new schema dropped or renamed slots. `ok: false` means a `migrate` function threw; the framework caught it, stopped the migration chain, and started the processor with declaration defaults for unrestored slots (Q45, `decisions-log.md`). Audio output starts cleanly regardless of `ok`'s value — the failure surfaces only through the return value, never as audio dropout.

  Timing semantics (block-atomic, next-block-boundary application) are spelled out in §6.

- **`inspect(blob: Uint8Array): InspectionResult`** — non-realtime helper that decodes a blob into a debug-friendly structured view. Imported from `@unworklet/core` as a **free function**, not a node method, because the operation has no node dependency — it can run in preset-library tooling, debug scripts, or any process holding a blob without needing an `AudioContext` or a live processor. The shape rule is uniform across this surface: node-bound operations (`snapshot` / `restore`) are node methods, blob-only operations (`inspect`) are free functions (Q48).

  ```typescript
  type InspectionResult = {
    version:    number;          // blob format version (= 1 in v1.0.0)
    schemaHash: string;
    profile:    string | null;
    slots:      Record<string, SlotInspection>;
  };
  type SlotInspection =
    | { kind: 'state';  type: ScalarType; value: number | boolean }
    | { kind: 'param';  value: number }
    | { kind: 'buffer'; type: ScalarType; length: number; head: number[] };  // first ~64 elements as preview
  ```

  This is a *read-only* view; `inspect` does not mutate the blob and there is no way to construct a blob from an `InspectionResult`. Build new blobs through the processor's snapshot path or through migrations.

A processor that calls `snapshot()` without any `name`-bearing slot is a graph-capture-time error.

## 3. Param connection / automation

<!-- Standard AudioParam capabilities are preserved end-to-end:
     - setValueAtTime / linearRamp / exponentialRamp
     - connection from other AudioNodes (LFO modulation) — wire-up via `node.params.<name>` returning a real AudioParam. -->

## 4. Lifecycle states

<!-- creating → ready → running → disposed.
     Errors transition: any → errored (terminal). -->

## 5. Event and state subscription details

### 5.1 Event drain on the main thread

`node.events.<name>.on(handler)` registers a subscriber. The main-thread runtime drains the corresponding event ringbuffer on a recurring tick (default: per-`MessageChannel` ping in SAB mode, per-`postMessage` arrival in fallback mode). Each drained event is dispatched to all subscribers for that event in registration order.

Subscribers run synchronously on the main thread; if a subscriber is slow, it blocks the dispatch loop for that tick — never the audio thread. The audio thread continues to write into the ringbuffer (drop-oldest on overflow), so a slow main-thread subscriber manifests as `overflowCount` advancing while the live UI lags. This is observable via `.diagnostics.overflowCount()`.

### 5.2 State publish notification

`node.state.<name>.subscribe(handler)` registers a listener for a `state.publish` (or `buffer.publish`) slot. The runtime watches the slot's per-slot version counter (see `02-messaging.md` §5.4). On each tick where the version has advanced, the runtime reads the value and invokes the handler — including when the new value is identical to the previously delivered one. **The framework does not perform value-equality dedupe** (Q39-b, `decisions-log.md`): the audio thread increments the version counter unconditionally every due tick, and the main side delivers every advance.

If you want same-value dedupe in your subscriber, do it inline:

```typescript
let last;
const unsub = node.state.meter.subscribe((v) => {
  if (v === last) return;
  last = v;
  // ... handle changed value
});
```

For typed-array slots (`buffer.publish`), do equality the way that matches your use case (e.g. compare a content hash, or skip entirely if your handler is idempotent under same-value calls).

`.value` returns the most recent published value synchronously, without subscribing. It is safe to call in render loops on the main thread.

### 5.3 Unsubscribe semantics

Both `.events.<name>.on(handler)` and `.state.<name>.subscribe(handler)` return an unsubscribe function. Calling it removes the handler from the dispatch list; subsequent ticks will not invoke it. A pending in-flight dispatch (a tick already scheduled before unsubscribe) may still deliver one final invocation — handlers must be idempotent against this.

`.dispose()` removes all subscribers as part of teardown; explicit unsubscribe is not required when the node is being discarded.

### 5.4 Backpressure

The audio thread does not back off based on main-thread responsiveness. The framework's contract is "deliver as much as the ring buffer can hold; report overflow accurately". Consumers who need flow control build it on top:

- Round-trip throttle: send a `messages.<name>(payload)` request to the worklet, have the worklet reply with an `event<T>` only when ready for more.
- Source-side throttle: monitor `overflowCount` on the consumer side and adjust emission cadence at the worklet author's level (e.g. wrap the emit site in `everyNSamples(N, () => eventDecl.emitIf(...))`).

## 6. Snapshot / restore semantics

This section spells out the realtime-safety and timing guarantees of `node.snapshot()` / `node.restore()`. The brief surface lives in §2.6; the timing details are here.

### 6.1 Block-boundary synchronization

Snapshot acquisition and restore application are both **block-atomic**: state never changes mid-block, and main-thread reads never see a half-updated linear memory.

#### snapshot

1. Main thread calls `node.snapshot()` — sets a `'request'` flag (Atomics on SAB; flag-bearing message on the postMessage path).
2. The audio thread continues its current render quantum to completion (no preemption).
3. At block boundary, the audio thread checks the flag. If set, it `memcpy`s linear memory into a pre-allocated snapshot region and sets `'ready'`.
4. The audio thread proceeds with the next render quantum normally — there is no audible pause.
5. Main thread observes `'ready'` and constructs the `Uint8Array` from the snapshot region; the `snapshot()` Promise resolves.

Latency upper bound: one render quantum (≈ 2.7 ms at 48 kHz / 128-sample blocks) plus main-thread copy. The audio thread's incremental cost is one `memcpy` per acquired snapshot, not per block.

#### restore

1. Main thread calls `node.restore(blob)` — writes the blob into a shared restore region (or transfers via postMessage) and sets `'pending'`.
2. The audio thread continues its current quantum unchanged — old state remains in effect through the end of the block.
3. At block boundary, the audio thread checks the flag and applies the slot values from the restore region into linear memory.
4. The audio thread sets `'applied'` and proceeds with the next quantum, **now using the restored state**.
5. Main thread observes `'applied'`; the `restore()` Promise resolves.

`await node.restore(blob)` resolves at the moment the new state is in effect for subsequent samples, **not** when the blob was handed off. This means `await restore(blob); /* ... */` can rely on `/* ... */` running with the post-restore state.

### 6.2 SAB available vs unavailable

API surface is identical; transport differs:

| | SAB available | SAB unavailable |
|---|---|---|
| Snapshot region | shared `SharedArrayBuffer` slice | pre-allocated `Uint8Array` transferred to audio thread |
| Flags | `Atomics.store / load` on shared int32 | flag-bearing postMessage |
| `snapshot()` round-trip | ~1 block + copy | ~1 block + postMessage round-trip (a few ms extra) |
| Audio-thread allocation | none | none (transfer buffer is provided by main thread) |

Both modes preserve the realtime-safety invariants (no allocation, no unbounded loops, no I/O on the audio thread). See `08-deployment.md` §3 for the broader SAB-degradation policy.

### 6.3 What the framework does not do

State changes between an old and new value can produce **audible discontinuities** even when the change is block-atomic — e.g. a filter coefficient jumping from 0.1 to 0.9 at the block boundary will produce a transient that the listener hears as a click.

The framework does **not** provide built-in fade or crossfade. There is no `silent: true` option, no automatic ramp, no equal-power crossfade. Reasoning: fade time, fade curve, and how to handle multiple simultaneous snapshot transitions are application-level decisions; embedding one choice into the framework would constrain consumers whose context expects a different choice (e.g. live-performance smooth fades vs. studio instant switches). This is the same "deliver the raw material, leave the abstraction to consumer culture" stance that governs MIDI clock / transport (see `decisions-log.md` Q4-d).

The framework's responsibility ends at "state changes block-atomically at a deterministic boundary." Anything beyond is consumer territory.

### 6.4 Common pattern: crossfade preset switch

To achieve smooth transitions, instantiate a fresh node in parallel and crossfade between the old and new instances using standard `GainNode` automation. This is the canonical Web Audio pattern; unworklet provides no special API for it.

```typescript
async function crossfadeRestore<C>(
  audioContext: AudioContext,
  processor: CompiledProcessor<C>,
  oldNode: UnworkletNode<C>,
  blob: Uint8Array,
  fadeSec: number = 0.05,
): Promise<UnworkletNode<C>> {
  // 1. Spin up a fresh instance with the target state.
  const newNode = await createNode(audioContext, processor);
  await newNode.restore(blob);

  // 2. Route old and new through separate gain nodes.
  //    The raw `.node.disconnect()` form is intentional here — during a crossfade
  //    we are tearing down every output of the old instance before the gain swap.
  //    For partial routing (one output only), use `oldNode.outputs.<name>.disconnect()`.
  const oldGain = audioContext.createGain();
  const newGain = audioContext.createGain();
  oldNode.node.disconnect();
  oldNode.node.connect(oldGain).connect(audioContext.destination);
  newNode.node.connect(newGain).connect(audioContext.destination);

  // 3. Linear crossfade using AudioParam ramps (sample-accurate, no clicks).
  const now = audioContext.currentTime;
  oldGain.gain.setValueAtTime(1, now);
  newGain.gain.setValueAtTime(0, now);
  oldGain.gain.linearRampToValueAtTime(0, now + fadeSec);
  newGain.gain.linearRampToValueAtTime(1, now + fadeSec);

  // 4. Dispose the old instance after the fade completes.
  setTimeout(() => {
    oldNode.dispose();
    oldGain.disconnect();
  }, fadeSec * 1000 + 10);

  return newNode;
}
```

Variations (equal-power curve, S-curve, longer pre-warm of the new node before the crossfade starts) compose naturally. Consumers can wrap this into their own preset-switch helper.

### 6.5 Migration on restore

When the blob was produced by an older version of the processor, the migration chain in `01-dsl.md` §8.3 runs on the main thread before the slot values reach the audio thread. The audio thread sees the same block-atomic application — it does not know whether migration occurred.

`restore()`'s `RestoreResult` reports any `skipped` or `missing` slots that resulted from incompatible blob content (post-migration). Consumers monitor this for "preset partially loaded" UX.

Authoritative rationale and rejected alternatives: see `decisions-log.md` Q5.

## 7. Latency compensation recipe

When an unworklet processor performs lookahead (i.e. its internal computation introduces a fixed input → output sample delay), parallel paths in the audio graph fall out of phase unless the dry / non-lookahead path is delayed by the same amount. The web platform has no automatic plugin-latency compensation, so this delay is wired up by the application using the standard `audioContext.createDelay(...)` node.

```typescript
// Suppose `limiterProcessor` performs a 5 ms (~240 sample @ 48 kHz) lookahead.
// Its author advertises this latency in the package's documentation; the
// application configures the dry path accordingly.

const limiter           = await createNode(audioContext, limiterProcessor);
const lookaheadSamples  = 240;                                       // documented by the processor's author
const compensationSec   = lookaheadSamples / audioContext.sampleRate;

// Dry path: delay by the same amount as the limiter's internal lookahead.
const dryDelay = audioContext.createDelay(compensationSec);
dryDelay.delayTime.value = compensationSec;

// Wet path: the limiter itself.
source.connect(limiter.inputs.main);
source.connect(dryDelay);

const mixer = audioContext.createGain();
limiter.outputs.main.connect(mixer);
dryDelay.connect(mixer);
mixer.connect(audioContext.destination);
```

The delay amount comes from the processor's documentation, **not** from a framework-exposed API. unworklet does not provide a `node.latency` property, an automatic-compensation manager, or compile-time delay insertion — see `decisions-log.md` Q8 for the full rationale.

For cleanest results:

- **Read the lookahead value from the processor's documentation**, not from runtime introspection. If the author of the processor wants to expose it programmatically, that is a package-level convention (e.g. a static `lookaheadProcessor.latencySamples` on the compiled artifact), not a unworklet-core feature.
- **Compose the compensating `DelayNode` once at graph construction time.** Do not mutate `delayTime` afterwards unless you specifically want a transient.
- **For chains of multiple lookahead processors**, sum the latencies and apply the total to the dry / parallel path:

```typescript
const totalLatencySec = (limiterSamples + analyzerSamples) / audioContext.sampleRate;
const dryDelay = audioContext.createDelay(totalLatencySec);
dryDelay.delayTime.value = totalLatencySec;
```

Multi-stage layouts where each stage has different lookahead requirements follow the same rule: at each branching / parallel point in the graph, the application inserts a `DelayNode` whose value equals the sum of lookaheads on the alternate path.

## 8. Dynamic processor swap (`replaceProcessor`)

`replaceProcessor` is a free function on `@unworklet/core` that swaps a running processor's WASM implementation while carrying state forward via the existing `snapshot()` + migration-chain machinery (Q5 + Q45). It is the **raw primitive** that user-land tooling (vite-plugin HMR recipes, Faust-style live coding REPLs, Max/MSP-style visual-programming editors) builds on; the framework itself does not orchestrate code-change detection, graph reconnection, or audio-side crossfade. Authoritative rationale: `decisions-log.md` Q50.

### 8.1 Signature

```typescript
import { replaceProcessor } from '@unworklet/core';

const result = await replaceProcessor(oldNode, NewProcessor);

type ReplaceResult<New> =
  | {
      ok: true;
      node:     UnworkletNode<New>;   // freshly-typed wrapper for the new processor
      applied:  string[];
      restored: number;
      skipped:  string[];
      missing:  string[];
    }
  | {
      ok: false;
      node:     UnworkletNode<New>;   // still returned; runs on declaration defaults
      error:    { step: string; message: string; cause: unknown };
      applied:  string[];
      restored: number;
      skipped:  string[];
      missing:  string[];
    };
```

The result shape mirrors `RestoreResult` (§2.6) one-for-one — the same migration chain runs underneath. The `node` field is always a fresh `UnworkletNode<New>` typed against the new processor's declarations; the old `oldNode` is left in whatever graph state the caller put it in.

### 8.2 What the call does

1. Calls `oldNode.snapshot()` to capture the current state into a blob.
2. Registers the new processor's WASM under a fresh unique name (Web Audio's `registerProcessor()` rejects duplicate names, and `removeModule()` does not exist — see `decisions-log.md` Q50).
3. Instantiates a new `AudioWorkletNode` against the new WASM and runs `restore(blob)` on it (migration chain per Q45).
4. Returns the new typed wrapper.

### 8.3 What the call does NOT do

- It does **not** disconnect `oldNode` from the audio graph. The caller decides when to detach the old node.
- It does **not** connect the new node into the audio graph. The caller wires the returned `result.node` into wherever it needs to live.
- It does **not** crossfade between old and new. A clean swap with audio continuity is built by the caller using parallel routing and a `GainNode` envelope (or whatever pattern fits the use case).
- It does **not** monitor source files, listen to `import.meta.hot`, or otherwise detect that a swap is needed. The decision to call `replaceProcessor` lives entirely in user-land code (an HMR plugin, a live-coding REPL, a UI button).

### 8.4 Type surface across declarations changes

Because the returned `node` is typed against the **new** processor's declarations, any consumer code that captured a reference to a slot on the old wrapper (`oldNode.state.fb.subscribe(...)`) does not silently migrate. If the new schema renamed `fb` → `feedback`, the caller's `result.node.state.fb` is a TypeScript error at the call site — the rename surfaces in the IDE the moment the new typed `.d.ts` is loaded. Resubscriptions, parameter wiring, and graph connections that the caller wants to carry across the swap are written explicitly in the caller's post-swap code.

This is the deliberate trade-off: `replaceProcessor` is honest about what a processor swap is (a new processor, with new declarations, potentially with a new I/O shape) rather than pretending the wrapper is the same object underneath. The cost is that callers write the post-swap wiring; the benefit is that schema drift between old and new never silently dies.

### 8.5 Memory and registration accumulation

Each `replaceProcessor` call adds one entry to the `AudioWorkletGlobalScope`'s registered-processor table; the Web Audio spec provides no removal path before the `AudioContext` is destroyed. In dev workflows that swap repeatedly (HMR, live coding), this accumulates inside the current `AudioContext`'s lifetime. The framework surfaces this through a `console.warn` after a threshold of swaps in the same `AudioContext`, suggesting the caller recreate the context (or refresh the page) when it becomes a concern. Production code that swaps occasionally (preset reloads, format changes) is unaffected in practice.

### 8.6 Patterns built on top (= user-land, not framework)

Hot module reload, live coding, and visual programming patterns are not first-class features of unworklet; they are *recipes* that the user-land code (or third-party plugins) compose from `createNode`, `replaceProcessor`, and the standard Web Audio graph methods. Sketch of the Vite HMR recipe:

```typescript
const node = await createNode(audioCtx, MyProcessor);
let current = node;
current.connect(audioCtx.destination);

if (import.meta.hot) {
  import.meta.hot.accept('./my-processor.ts?worklet', async (mod) => {
    const result = await replaceProcessor(current, mod.default);
    result.node.connect(audioCtx.destination);   // wire the new node in
    current.disconnect();                         // unwire the old node
    current = result.node;                        // refresh the caller's handle
  });
}
```

`07-vite-plugin.md` documents the Vite-specific delivery details (the `?worklet` import shape, the HMR boundary the plugin sets up). The swap orchestration itself stays in user code.
