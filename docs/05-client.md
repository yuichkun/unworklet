# 05 — Client (`@unworklet/client`)

The main-thread API. Wraps the standard `AudioWorkletNode` with a typed surface for params, messages, and events, and manages module loading, readiness, and disposal.

## Status

skeleton

## 1. `createNode`

<!-- createNode<C>(context, processor, options?): Promise<UnworkletNode<C>>
     - context: BaseAudioContext
     - processor: CompiledProcessor<C> (artifact from the compiler)
     - options.initial: per-param initial values
     - options.numberOfInputs / numberOfOutputs / outputChannelCount: AudioWorkletNodeOptions passthroughs
     Loads WASM (cached), adds Worklet module, instantiates the node, awaits worklet readiness. -->

## 2. `UnworkletNode<C>` surface

<!-- - .node:     raw AudioWorkletNode (for advanced graph wiring)
     - .inputs.<name>:  typed AudioInput connect()/be-connected-to wrapper per declared audioInput
     - .outputs.<name>: typed AudioOutput connect()/be-connected-to wrapper per declared audioOutput
     - .params.<name>:  real AudioParam (Web Audio standard; setValueAtTime / linearRamp / exponentialRamp / connection-from-AudioNode all work)
     - .messages.<name>(payload):           typed sender per declared message
     - .events.<name>.on(handler) → unsub:  typed subscriber per declared event
     - .midi.send(event, atTime?):          source-agnostic MIDI inject (when midiInput is declared)
     - .midi.connectFromWebMIDI(input):     Web MIDI bridge convenience (when midiInput is declared)
     - .dispose():                          tear down node, queues, worklet
     - .onError(handler):                   error subscription (worklet traps, queue overflow, SAB-mode change).
     The .params.<name> shape is a real AudioParam — distinct from the worklet-side `param.at(i)` graph-capture form;
     main-thread JS uses standard Web Audio APIs, the worklet-side primitive is graph-capture only. -->

### 2.6 Snapshot / restore / inspect

`UnworkletNode<C>` exposes three methods for state persistence — their contract is declared by the processor (see `01-dsl.md` §8):

- **`snapshot(options?: { profile?: string }): Promise<Uint8Array>`** — capture the current state slots into a binary blob. Without `profile`, all slots flagged `'persistent'` are included (the union across profiles for declarations using the record form). With `profile`, only slots flagged `'persistent'` for that named profile are included.

- **`restore(blob: Uint8Array): Promise<RestoreResult>`** — write the blob's slot values back into the running processor.

  ```typescript
  type RestoreResult = {
    restored: number;       // slots successfully written
    skipped:  string[];     // slot names that existed in the blob but mismatched type/size in the current schema
    missing:  string[];     // current schema slots that the blob did not carry — initialized from declaration default
  };
  ```

  Timing semantics (block-atomic, next-block-boundary application) are spelled out in §6.

- **`inspect(blob: Uint8Array): InspectionResult`** — non-realtime helper that decodes a blob into a debug-friendly structured view.

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

## 5. Event subscription details

<!-- Tick scheduling for queue drain on main thread; backpressure if subscribers are slow;
     unsubscribe semantics. -->

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
