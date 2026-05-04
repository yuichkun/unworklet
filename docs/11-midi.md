# 11 — MIDI

Sample-accurate MIDI-event ingestion at the processor boundary. The main thread receives MIDI from any source (Web MIDI API, the host runtime, manual injection); unworklet delivers events to the worklet with sample-offset timestamps that the user handles inside `process`.

## Status

skeleton

## 1. Declaration surface

<!-- midiInput() declaration in `defineProcessor`. Resolved details slot in once the MIDI integration design question is settled. -->

## 2. Sample-accurate event handling

<!-- - `midi.onEvent('noteOn', ({ note, velocity, atSample }) => ...)` and similar shape.
     - Sample-accuracy: events carry an in-block sample offset; handlers fire at that offset, not at block boundary like ordinary `messages` (see 02-messaging.md).
     - Concurrent events at the same sample offset are processed in arrival order. -->

## 3. Main-thread integration

<!-- - Direct send: `unworkletNode.midi.send(event, atTime?)` for application-driven MIDI.
     - Web MIDI API bridge: `unworkletNode.midi.connectFromWebMIDI(input)` for hardware/virtual MIDI inputs (browser hosts only).
     - Host-runtime bridge: when the host runtime supplies MIDI (e.g. a VST host via `unaudio`), the same `.send` pathway is used by the runtime layer — unworklet itself sees only the standard `unworkletNode.midi.send` surface. -->

## 4. Wire format

<!-- - Per-event encoding: raw MIDI status byte + data bytes, or structured (status, channel, data1, data2, atSample).
     - Ring buffer (SAB-backed when available) vs postMessage path; degradation rules align with 02-messaging.md.
     - Fixed-size event slots; overflow → onError per the messaging contract. -->

## 5. MIDI clock and transport

<!-- - MIDI clock messages (0xF8 timing clock, 0xFA start, 0xFC stop, 0xFB continue) ingest as ordinary events; unworklet does not synthesize a transport from them.
     - Transport-sync convention: deferred — see `10-roadmap.md` §3. -->
