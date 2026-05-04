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

<!-- - `midi.onEvent('noteOn', ({ note, velocity, atSample }) => ...)` and similar shape.
     - Sample-accuracy: events carry an in-block sample offset; handlers fire at that offset, not at block boundary like ordinary `messages` (see 02-messaging.md).
     - Concurrent events at the same sample offset are processed in arrival order. -->

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

<!-- - Per-event encoding: raw MIDI status byte + data bytes, or structured (status, channel, data1, data2, atSample).
     - Ring buffer (SAB-backed when available) vs postMessage path; degradation rules align with 02-messaging.md.
     - Fixed-size event slots; overflow → onError per the messaging contract. -->

## 5. MIDI clock and transport

<!-- - MIDI clock messages (0xF8 timing clock, 0xFA start, 0xFC stop, 0xFB continue) ingest as ordinary events; unworklet does not synthesize a transport from them.
     - Transport-sync convention: deferred — see `10-roadmap.md` §3. -->
