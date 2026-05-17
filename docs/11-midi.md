# 11 — MIDI

Sample-accurate MIDI ingestion and emission at the processor boundary. unworklet supports both directions: processors can receive MIDI events from the main thread (synths / MIDI-driven effects) and emit MIDI events back to the main thread (arpeggiators / sequencers / MIDI-effects).

The main thread injects events through a source-agnostic API; unworklet does not concern itself with where events originated (Web MIDI input, application-generated, network bridge, etc.).

## Status

written

## 1. Declaration surface

A processor declares MIDI involvement explicitly in declaration scope. Two declarations exist — `midiInput()` and `midiOutput()` — and either can be omitted. A processor that calls neither has no MIDI surface at all (the concepts are absent from its API and IDE completion).

```typescript
midiInput (options: { name: string; capacity?: number }): MidiInputHandle;
midiOutput(options: { name: string; capacity?: number }): MidiOutputHandle;
```

```typescript
const synth = defineProcessor((ctx) => {
  const midiIn = midiInput({ name: 'midiIn' });          // declare MIDI ingestion
  // ...
  return { process: () => { /* ... */ } };
});

const arpeggiator = defineProcessor((ctx) => {
  const midiIn  = midiInput ({ name: 'midiIn'  });
  const midiOut = midiOutput({ name: 'midiOut' });       // declare MIDI emission
  // ...
});

const dualPort = defineProcessor((ctx) => {
  // Multiple ports per processor: each gets its own `name` and is reached
  // through `node.midi.<name>` on the main thread.
  const sync   = midiInput ({ name: 'sync'   });   // external clock / transport
  const arpOut = midiOutput({ name: 'arpOut' });   // arp-generated notes
  // ...
});

const audioOnly = defineProcessor((ctx) => {
  // No midiInput / midiOutput call → MIDI concepts unused, never appear in this processor's surface.
});
```

Options:

- **`name: string`** — required. Used as the identifier in three places: (a) main-side access — `node.midi.<name>` resolves to this declaration's surface (`send` / `connectFromWebMIDI` / `onEvent` / `diagnostics.overflowCount`); (b) snapshot schema-hash identity — declarations participate in the structural hash that drives migration matching, even though the MIDI ringbuffer state itself is transient; (c) error and diagnostic messages — `midiInput 'sync' overflowed: 12 events dropped` is more actionable than `midiInput[0] overflowed`. Required for the same reasons as `name` on `state` / `buffer` / `param` / `event` / `message` declarations: the framework refuses index-based identity to keep declaration order non-load-bearing.
- **`capacity?: number`** — ringbuffer slot count. Default 256 (per Q4-c-i). Override for dense MIDI / sequencer / network-driven loads.

The exact shape of the `midiInput` / `midiOutput` handles (event subscription on the worklet side, emission primitives, etc.) is settled in §2 and §4.

## 2. Sample-accurate event handling

### 2.1 Inbound: subscribing to MIDI events (worklet side)

`midiInput()` returns a handle whose primary surface is `onEvent(eventType, handler)`. Handlers are **type-discriminated**: each registered handler observes one event type, and TypeScript narrows the handler's argument shape accordingly.

```typescript
defineProcessor((ctx) => {
  const midiIn = midiInput({ name: 'midiIn' });

  return {
    process: () => {
      midiIn.onEvent('noteOn',  ({ channel, note, velocity, atSample }) => {
        // ...handle noteOn
      });
      midiIn.onEvent('noteOff', ({ channel, note, atSample }) => {
        // ...handle noteOff
      });
      midiIn.onEvent('cc',      ({ channel, controller, value, atSample }) => {
        // ...handle continuous controller
      });
    },
  };
});
```

### 2.2 Event types (TypeScript surface)

MIDI events appear in two contexts: **main thread** (= `node.midi.<name>.send(...)` argument and `.onEvent(...)` handler argument), and **worklet audio-thread** (= `midiInput().onEvent(...)` handler argument and `midiOutput().emitIf(...)` argument). Each context uses a distinct TypeScript type because the values themselves are different things — main-thread fields are plain JS numbers, worklet fields are audio-graph nodes captured into the WASM emission (Q22). Authors never see raw status bytes — the compiler generates serializers and deserializers between these types and the wire format (§4).

```typescript
// Main thread / wire shape — values are plain JS scalars.
type MidiEvent =
  | { type: 'noteOn';          channel: number; note: number; velocity: number; atSample: number }
  | { type: 'noteOff';         channel: number; note: number; velocity: number; atSample: number }
  | { type: 'cc';              channel: number; controller: number; value: number; atSample: number }
  | { type: 'pitchBend';       channel: number; value: number;                     atSample: number }
  | { type: 'programChange';   channel: number; program: number;                   atSample: number }
  | { type: 'channelPressure'; channel: number; pressure: number;                  atSample: number }
  | { type: 'aftertouch';      channel: number; note: number; pressure: number;   atSample: number }
  | { type: 'systemRealtime';  status: number;                                     atSample: number }  // 0xF8 / 0xFA / 0xFB / 0xFC
  | { type: 'sysex';           data: Uint8Array;                                   atSample: number };

// Worklet audio-thread shape — every numeric field is a graph-capture value
// (`Node<'i32'>`), every typed-array field is exposed as a typed-array-field
// proxy (Q36-b). Returned by `midiInput().onEvent(...)` handler, and accepted
// by `midiOutput().emitIf(...)`. See `decisions-log.md` Q46.
type MidiEventGraph =
  | { type: 'noteOn';          channel: Node<'i32'>; note: Node<'i32'>; velocity: Node<'i32'>;     atSample: Node<'i32'> }
  | { type: 'noteOff';         channel: Node<'i32'>; note: Node<'i32'>; velocity: Node<'i32'>;     atSample: Node<'i32'> }
  | { type: 'cc';              channel: Node<'i32'>; controller: Node<'i32'>; value: Node<'i32'>;  atSample: Node<'i32'> }
  | { type: 'pitchBend';       channel: Node<'i32'>; value: Node<'i32'>;                           atSample: Node<'i32'> }
  | { type: 'programChange';   channel: Node<'i32'>; program: Node<'i32'>;                         atSample: Node<'i32'> }
  | { type: 'channelPressure'; channel: Node<'i32'>; pressure: Node<'i32'>;                        atSample: Node<'i32'> }
  | { type: 'aftertouch';      channel: Node<'i32'>; note: Node<'i32'>; pressure: Node<'i32'>;     atSample: Node<'i32'> }
  | { type: 'systemRealtime';  status: Node<'i32'>;                                                atSample: Node<'i32'> }
  | { type: 'sysex';           data: TypedArrayFieldProxy<'u8'>;                                    atSample: Node<'i32'> };
```

The two types share variant tags and field names — only field types differ. Emit-side accepts number / boolean literals through the Q33 literal-lift rule (e.g. `atSample: 0` lifts to `Node<'i32'>` with value 0), so authors write the same literal numbers they would write in `MidiEvent`. Reading a field in a worklet handler returns a `Node<'i32'>` graph value usable in graph expressions: `noteState.store(note)` works because `note: Node<'i32'>` is what `state.i32.store` expects.

The exact set of variants and their fields is closed at v1.0.0. New variants (e.g. MIDI 2.0 high-resolution events) can be added additively in v1.x.0; the `MidiEvent` / `MidiEventGraph` pair grows together.

### 2.3 `atSample` is always present

Every handler argument carries `atSample` — the sample-offset within the current render quantum at which the event arrived. Handlers fire **at that sample-offset, not at block boundary**, so MIDI-driven events maintain sample accuracy through the full ingestion path.

```typescript
midiIn.onEvent('noteOn', ({ note, atSample }) => {
  // atSample tells us "this noteOn arrived 47 samples into the current block"
  // → trigger the envelope from this sample onward, not the block boundary
});
```

Concurrent events at the same sample-offset are processed in arrival order on the wire.

All numeric fields the handler receives — `atSample`, `note`, `velocity`, `channel`, etc. — are `Node<'i32'>` graph-capture values (= the `MidiEventGraph` shape of §2.2). `atSample` specifically is in the same dimension as the `i` parameter of a `forSample` callback (see `01-dsl.md` §10). The handler body runs at the firing sample (the sample whose offset matches `atSample`); typically the handler stores the event details into `state` slots, and a subsequent `forSample` invocation compares `i` against the stored offset for sample-accurate trigger:

```typescript
defineProcessor((ctx) => {
  const midiIn = midiInput({ name: 'midiIn' });
  const noteState = state.i32(-1, { name: 'note' });
  const trigOffset = state.i32(-1, { name: 'trig' });
  // ...

  return {
    process: () => {
      // Handler captures noteOn into state slots. The handler body runs at the firing
      // sample (the sample whose offset matches the event's atSample value).
      midiIn.onEvent('noteOn', ({ note, atSample }) => {
        noteState.store(note);
        trigOffset.store(atSample);
      });

      // Per-sample iteration triggers the envelope at sample-offset i == trigOffset.
      forSample((i) => {
        const fire = eq(i, trigOffset.load());
        // ... use `fire: Node<'bool'>` to gate the envelope start ...
      });
    },
  };
});
```

The `atSample` is in the surrounding render quantum's coordinate system; consumers needing absolute time derive it as `audioContext.currentTime + atSample / sampleRate` on the main thread.

### 2.4 Outbound: emitting MIDI events (worklet → main)

`midiOutput()` returns a handle whose only emission primitive is the `emitIf` **method**: `midiOut.emitIf(condition, event)`. There is no plain `emit(event)` — `emitIf` is the single emission primitive across every audio-thread expression context: `forSample` / `forSample.byN` callbacks, `everyNSamples` callbacks, MIDI / message handler bodies, and the per-block top level (statements in the `process` body outside any `forSample`). See `decisions-log.md` Q4-b for the original footgun reasoning, Q32-a for the cross-context unification. `emitIf` is dispatched off the handle (no free-function form); the same `handle.emitIf(cond, payload)` shape is used by generic `event<T>` declarations (see `01-dsl.md` §4).

The `condition` parameter accepts `Node<'bool'> | boolean`. Inside a `forSample` callback, the conditional must be structural (e.g. a state-edge expression) — a constant-truthy cond is a static-analysis error. Inside a MIDI / message handler body, `emitIf(true, event)` is the canonical spelling for unconditional 1:1 projection: e.g. ingesting `noteOn` and re-emitting it on a different channel (MIDI thru / arpeggiator latching), or projecting an incoming MIDI event onto a generic UI event channel.

```typescript
const drumSequencer = defineProcessor((ctx) => {
  const midiOut = midiOutput({ name: 'midiOut' });
  // ...
  return {
    process: () => {
      midiOut.emitIf(crossedStep, {
        type: 'noteOn',
        channel: 9,
        note: noteToEmit,
        velocity: 100,
        atSample: 0,   // sample-offset within the current render quantum
      });
    },
  };
});
```

`midiOut.emitIf(cond, event)` compiles to a graph node: only on samples where `cond` evaluates true does the event get pushed into the outbound ringbuffer. "Emit only at boundaries / state transitions" is structurally enforced — there is no path to accidentally enqueue events every sample.

The `event` argument has the `MidiEventGraph` shape (§2.2) — all numeric fields are `Node<'i32'>`, with number literals admitted through Q33 literal-lift. The `atSample` field is in the same dimension as the surrounding iteration's sample-offset. Common patterns:

- *Constant offset*: `atSample: 0` emits at the start of the render quantum (legacy / non-sample-accurate consumers).
- *Current sample*: in an explicit-form processor, pass the surrounding `forSample` callback's `i` directly: `atSample: i`. The emitted event then carries the exact sample at which the conditional fired.
- *State-driven offset*: read a previously-stored sample-offset from a `state.i32` slot.

```typescript
defineProcessor((ctx) => {
  const midiOut = midiOutput({ name: 'midiOut' });
  const stepCounter = state.i32(0, { name: 'stepCounter' });

  return {
    process: () => {
      forSample((i) => {
        const c       = stepCounter.load();
        const crossed = eq(c, /* threshold */);
        midiOut.emitIf(crossed, {
          type: 'noteOn',
          channel: 9,
          note: 60,
          velocity: 100,
          atSample: i,                                       // sample-accurate: emit at the firing sample
        });
        stepCounter.store(/* advance */);
      });
    },
  };
});
```

At the per-block phase top level (where `i` is not in scope), the natural sample-accurate equivalent stores the offset in a `state.i32` slot during a `forSample` iteration and uses that slot's value as `atSample` in a subsequent emit.

## 3. Main-thread integration

unworklet exposes a source-agnostic main-thread API. Any code that produces a MIDI event injects it through `.send()`; unworklet has no knowledge of where the event originated.

### 3.1 API surface

```typescript
// (1) Standard Web MIDI bridge — convenience sugar.
//     Internally wires MIDIInput events into (2) .send().
unworkletNode.midi.<name>.connectFromWebMIDI(input: MIDIInput): void;

// (2) Source-agnostic injection.
//     Anyone (Web MIDI subscriber, application logic, network bridge, etc.) calls this.
unworkletNode.midi.<name>.send(event: MidiEvent, atTime?: number): void;
```

`<name>` matches the `name` passed to the worklet-side `midiInput({ name })` declaration. The same namespaced shape applies to every `midiInput` declaration; multi-port processors expose one sub-surface per declared port (Q40, `decisions-log.md`).

### 3.2 Examples of consumers

```typescript
// Web MIDI input device → worklet (single-port, name = 'main')
const access = await navigator.requestMIDIAccess();
const input  = access.inputs.values().next().value;
unworkletNode.midi.main.connectFromWebMIDI(input);

// Application-generated event
button.addEventListener('click', () => {
  unworkletNode.midi.main.send({ type: 'noteOn', channel: 0, note: 60, velocity: 127 });
});

// Network message → MIDI
ws.onmessage = (msg) => {
  unworkletNode.midi.main.send(parseFromNetwork(msg.data), audioCtx.currentTime + 0.05);
};

// Multi-port: keyboard + controller
const kbdAccess = (await navigator.requestMIDIAccess()).inputs.get('keyboard-id');
unworkletNode.midi.keyboard.connectFromWebMIDI(kbdAccess);
unworkletNode.midi.controller.connectFromWebMIDI(controllerInput);
```

The worklet itself does not distinguish between sources within a port; the audio thread sees an ordered ringbuffer per port of MIDI events with sample-offsets and dispatches them through the user-defined `midiIn.onEvent(handler)` (§2).

### 3.3 Outbound direction

For processors that declared `midiOutput({ name })`, the main thread subscribes per port via `unworkletNode.midi.<name>.onEvent(type, handler)`. Typical use is to forward emitted MIDI to a Web MIDI output device or to application logic. Diagnostics are exposed at `unworkletNode.midi.<name>.diagnostics.overflowCount()`.

## 4. Wire format

### 4.1 Slot encoding (fixed-size events)

Both inbound and outbound MIDI events travel on the wire as **raw MIDI status bytes**, not the structured `MidiEvent` union seen by authors. The compiler generates serializers (TS → bytes) and deserializers (bytes → TS) so the wire stays MIDI-standard while the user-facing API stays type-safe.

Each event occupies one fixed-size **slot** in the ring buffer. Slot layout (8 bytes):

```text
| status (u8) | data1 (u8) | data2 (u8) | _pad (u8) | atSample (u32) |
                                                      = 8 bytes per slot
```

Pointers into the ring buffer are slot-indexed (`head` and `tail` increment by 1 per event), not byte-indexed — slot-boundary misreads are structurally impossible.

### 4.2 `atSample` semantics

`atSample` is the sample-offset **within the current render quantum** (block-local) where the event fires. Valid values are 0 through `SAMPLES_PER_BLOCK - 1`; the field is stored as `u32` for headroom against future block-size variation.

A handler subscribed via `midiIn.onEvent` fires at the sample identified by `atSample`, not at the block boundary — sample accuracy is preserved end-to-end. A consumer that needs an absolute timestamp can derive it from `audioContext.currentTime + atSample / sampleRate`.

The compiler converts the `atTime` parameter passed to `unworkletNode.midi.<name>.send(event, atTime)` into the corresponding block-local `atSample` value at injection time.

### 4.3 Sysex (variable-length events)

Sysex events have a `data: Uint8Array` field of arbitrary length and cannot fit into a fixed 8-byte slot. They are stored in a **separate variable-length content buffer** alongside the main ring buffer. The main slot for a sysex event holds the sysex status byte plus an index into the content buffer:

```text
sysex slot in main ring buffer:
| status = 0xF0 | _pad | _pad | _pad | sysexIndex (u32) |

sysex content buffer (separate, variable-length):
| length (u32) | data (length bytes) | length (u32) | data (length bytes) | ...
```

v1.0.0 ships full sysex support. The sysex content buffer has its own capacity and overflow handling consistent with §4.5.

### 4.4 Transport

- **SAB available** (default): events flow through a `SharedArrayBuffer`-backed ring buffer with `Atomics`-based head / tail pointers. Sample-accurate timing is preserved end-to-end.
- **SAB unavailable** (no COOP/COEP headers): falls back to `postMessage` at render-quantum granularity. Sample-accurate timing **within a block** is preserved on the worklet side; main-side delivery picks up block-boundary latency. Full degradation policy lives in Q11.

### 4.5 Capacity and overflow

Inbound and outbound ring buffers have fixed-size capacities chosen at processor instantiation:

```typescript
const midiIn = midiInput({ name: 'midiIn' });                                                  // capacity: CAPACITY_256 (default)
const heavy  = midiInput({ name: 'heavy', capacity: CAPACITY_1024 });                          // override
```

256 slots × 8 bytes = 2 KB; 1024 slots = 8 KB. SAB usage is small either way. The default of 256 covers the vast majority of MIDI workloads; override is available for dense MIDI / sequencer / network-driven loads.

When the producer fills the buffer (head catches tail), overflow handling is **drop-oldest + diagnostics counter**:

- The oldest event in the buffer is overwritten by the new write.
- A monotonic `overflowCount` counter, exposed as `midiIn.diagnostics.overflowCount()`, increments on each drop.

Drop-oldest and drop-newest both break MIDI semantics in different ways (phantom note off vs hanging note); since neither is correct, what matters is **detection**, not the choice. Consumers monitor the counter via the `publish` phase and surface alerts to the UI when it advances.

Overflow is anti-pattern in normal use — capacity should be sized to the workload. The diagnostics counter exists as a defensive measure for unusual conditions (file-load bursts, audio-thread starvation, etc.).

## 5. MIDI clock and transport

MIDI clock messages (`0xF8` timing clock, `0xFA` start, `0xFB` continue, `0xFC` stop) are ingested as ordinary `systemRealtime` events through the same path as any other MIDI event (see §2). unworklet does **not** synthesize a transport (BPM, beat position, play state) from them — that abstraction is **out of scope**.

### What unworklet provides

`systemRealtime` events arrive at the worklet handler with sample-accurate `atSample`, just like any other MIDI event:

```typescript
defineProcessor((ctx) => {
  const midiIn = midiInput({ name: 'midiIn' });

  return {
    process: () => {
      midiIn.onEvent('systemRealtime', ({ status, atSample }) => {
        // status === 0xF8: timing clock (24 PPQN)
        // status === 0xFA: start
        // status === 0xFB: continue
        // status === 0xFC: stop
        // → user code interprets these as needed
      });
    },
  };
});
```

### What unworklet does NOT provide

A built-in transport API (`useTransport()`, `transport.bpm.load()`, `transport.beatPosition.load()`, etc.) is intentionally **not part of unworklet**. Transport models vary across consumer applications (phase-based, step-based, clip-driven, etc.), and unworklet picking one would constrain users whose context expects a different model.

User-level transport abstractions live in consumer code or third-party packages. unworklet's role ends at delivering MIDI clock messages reliably; transport interpretation is the consumer's domain.

Rationale and rejected alternatives: see `decisions-log.md` Q4 (Q4-d) and Q10.
