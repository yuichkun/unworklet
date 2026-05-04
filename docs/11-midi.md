# 11 — MIDI

Sample-accurate MIDI ingestion and emission at the processor boundary. unworklet supports both directions: processors can receive MIDI events from the main thread (synths / MIDI-driven effects) and emit MIDI events back to the main thread (arpeggiators / sequencers / MIDI-effects).

The main thread injects events through a source-agnostic API; unworklet does not concern itself with where events originated (Web MIDI input, application-generated, network bridge, etc.).

## Status

skeleton

## 1. Declaration surface

A processor declares MIDI involvement explicitly in declaration scope. Two declarations exist — `midiInput()` and `midiOutput()` — and either can be omitted. A processor that calls neither has no MIDI surface at all (the concepts are absent from its API and IDE completion).

```typescript
const synth = defineProcessor((ctx) => {
  const midiIn = midiInput();          // declare MIDI ingestion
  // ...
  return { process: () => { /* ... */ } };
});

const arpeggiator = defineProcessor((ctx) => {
  const midiIn  = midiInput();
  const midiOut = midiOutput();        // declare MIDI emission
  // ...
});

const audioOnly = defineProcessor((ctx) => {
  // No midiInput / midiOutput call → MIDI concepts unused, never appear in this processor's surface.
});
```

The exact shape of the `midiInput` / `midiOutput` handles (event subscription on the worklet side, emission primitives, etc.) is settled in §2 and §4 (TBD, Q4-b/c).

## 2. Sample-accurate event handling

### 2.1 Inbound: subscribing to MIDI events (worklet side)

`midiInput()` returns a handle whose primary surface is `onEvent(eventType, handler)`. Handlers are **type-discriminated**: each registered handler observes one event type, and TypeScript narrows the handler's argument shape accordingly.

```typescript
defineProcessor((ctx) => {
  const midiIn = midiInput();

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

Inbound and outbound MIDI events use the same `MidiEvent` discriminated union on the API surface. Authors never see raw status bytes — the compiler generates serializers and deserializers between this union and the wire format (§4).

```typescript
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
```

The exact set of variants and their fields is closed at v0.1.0. New variants (e.g. MIDI 2.0 high-resolution events) can be added additively in v0.1.x.

### 2.3 `atSample` is always present

Every handler argument carries `atSample` — the sample-offset within the current render quantum at which the event arrived. Handlers fire **at that sample offset, not at block boundary**, so MIDI-driven events maintain sample accuracy through the full ingestion path.

```typescript
midiIn.onEvent('noteOn', ({ note, atSample }) => {
  // atSample tells us "this noteOn arrived 47 samples into the current block"
  // → trigger the envelope from this sample onward, not the block boundary
});
```

Concurrent events at the same sample offset are processed in arrival order on the wire.

### 2.4 Outbound: emitting MIDI events (worklet → main)

`midiOutput()` returns a handle whose only emission primitive is `emitIf(condition, event)`. There is no plain `emit(event)` — every emission is conditional, by design (see `decisions-log.md` Q4-b for the reasoning).

```typescript
const drumSequencer = defineProcessor((ctx) => {
  const midiOut = midiOutput();
  // ...
  return {
    process: () => {
      midiOut.emitIf(crossedStep, {
        type: 'noteOn',
        channel: 9,
        note: noteToEmit,
        velocity: 100,
        atSample: 0,   // sample offset within the current render quantum
      });
    },
  };
});
```

`emitIf(cond, event)` compiles to a graph node: only on samples where `cond` evaluates true does the event get pushed into the outbound ringbuffer. "Emit only at boundaries / state transitions" is structurally enforced — there is no path to accidentally enqueue events every sample.

## 3. Main-thread integration

unworklet exposes a source-agnostic main-thread API. Any code that produces a MIDI event injects it through `.send()`; unworklet has no knowledge of where the event originated.

### 3.1 API surface

```typescript
// (1) Standard Web MIDI bridge — convenience sugar.
//     Internally wires MIDIInput events into (2) .send().
unworkletNode.midi.connectFromWebMIDI(input: MIDIInput): void;

// (2) Source-agnostic injection.
//     Anyone (Web MIDI subscriber, application logic, network bridge, etc.) calls this.
unworkletNode.midi.send(event: MIDIEvent, atTime?: number): void;
```

### 3.2 Examples of consumers

```typescript
// Web MIDI input device → worklet
const access = await navigator.requestMIDIAccess();
const input  = access.inputs.values().next().value;
unworkletNode.midi.connectFromWebMIDI(input);

// Application-generated event
button.addEventListener('click', () => {
  unworkletNode.midi.send({ type: 'noteOn', channel: 0, note: 60, velocity: 127 });
});

// Network message → MIDI
ws.onmessage = (msg) => {
  unworkletNode.midi.send(parseFromNetwork(msg.data), audioCtx.currentTime + 0.05);
};
```

The worklet itself does not distinguish between sources; the audio thread sees an ordered ringbuffer of MIDI events with sample offsets and dispatches them through the user-defined `midi.onEvent(handler)` (§2).

### 3.3 Outbound direction

For processors that declared `midiOutput()`, the main thread receives emitted events through a subscription API. Exact shape is settled in §4 (TBD, Q4-c). Typical use is to forward emitted MIDI to a Web MIDI output device or to application logic.

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

`atSample` is the sample offset **within the current render quantum** (block-local) where the event fires. Valid values are 0 through `renderQuantum - 1`; the field is stored as `u32` for headroom against future block-size variation.

A handler subscribed via `midi.onEvent` fires at the sample identified by `atSample`, not at the block boundary — sample accuracy is preserved end-to-end. A consumer that needs an absolute timestamp can derive it from `audioContext.currentTime + atSample / sampleRate`.

The compiler converts the `atTime` parameter passed to `unworkletNode.midi.send(event, atTime)` into the corresponding block-local `atSample` value at injection time.

### 4.3 Sysex (variable-length events)

Sysex events have a `data: Uint8Array` field of arbitrary length and cannot fit into a fixed 8-byte slot. They are stored in a **separate variable-length content buffer** alongside the main ring buffer. The main slot for a sysex event holds the sysex status byte plus an index into the content buffer:

```text
sysex slot in main ring buffer:
| status = 0xF0 | _pad | _pad | _pad | sysexIndex (u32) |

sysex content buffer (separate, variable-length):
| length (u32) | data (length bytes) | length (u32) | data (length bytes) | ...
```

v0.1.0 ships full sysex support. The sysex content buffer has its own capacity and overflow handling consistent with §4.5.

### 4.4 Transport

- **SAB available** (default): events flow through a `SharedArrayBuffer`-backed ring buffer with `Atomics`-based head / tail pointers. Sample-accurate timing is preserved end-to-end.
- **SAB unavailable** (no COOP/COEP headers): falls back to `postMessage` at render-quantum granularity. Sample-accurate timing **within a block** is preserved on the worklet side; main-side delivery picks up block-boundary latency. Full degradation policy lives in Q11.

### 4.5 Capacity and overflow

Inbound and outbound ring buffers have fixed-size capacities chosen at processor instantiation:

```typescript
const midiIn = midiInput();                            // capacity: 256 (default)
const heavy  = midiInput({ capacity: 1024 });          // override
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
  const midiIn = midiInput();

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

A built-in transport API (`useTransport()`, `transport.bpm.load()`, `transport.beatPosition.load()`, etc.) is intentionally **not part of unworklet**. Transport models vary by DAW culture (Ableton Link phase, Tone.js Transport step, Bitwig clip-driven, etc.), and unworklet picking one would constrain users whose context expects a different model.

User-level transport abstractions live in consumer code or third-party packages. unworklet's role ends at delivering MIDI clock messages reliably; transport interpretation is the consumer's domain.

Rationale and rejected alternatives: see `decisions-log.md` Q4 (Q4-d) and Q10.
