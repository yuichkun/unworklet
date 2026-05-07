<script setup>
const tryItCode0 = `import {
  defineProcessor, audioInput, audioOutput, state, midiInput, midiOutput, forSample,
  add, mul, mod, eq, gt, gte, select,
} from "@unworklet/core";

export const arp = defineProcessor((ctx) => {
  // Even processors with no audio input still need an audio I/O — Web Audio
  // requires it to schedule processing.
  const _in = audioInput({ channels: 1, name: "in" });
  const out = audioOutput({ channels: 1, name: "out" });

  const midiIn = midiInput({ name: "midi" });
  const midiOut = midiOutput({ name: "out" });

  const heldNote = state.i32(-1, { name: "heldNote" });
  const stepIdx = state.i32(0, { name: "stepIdx", publish: { rateFps: 30 } });
  const sampleCounter = state.i32(0, { name: "sampleCounter" });

  // 1/8 notes at 120 BPM → 12000 samples per step at 48 kHz.
  const SAMPLES_PER_STEP = 12000;
  const STEPS = 8;
  // Pattern: octave + arpeggio offsets in semitones.
  const OFFSETS = [0, 4, 7, 12, 7, 4, 0, -3];

  return {
    process: () => {
      midiIn.onEvent("noteOn", ({ note }) => heldNote.store(note));
      midiIn.onEvent("noteOff", ({ note }) => {
        heldNote.store(select(eq(heldNote.load(), note), -1, heldNote.load()));
      });
      forSample((i) => {
        const c = add(sampleCounter.load(), 1);
        const tick = gte(c, SAMPLES_PER_STEP);
        sampleCounter.store(select(tick, 0, c));
        const note = heldNote.load();
        const playing = gt(note, -1);
        // Fan out the offset table at compile time.
        for (let k = 0; k < STEPS; k++) {
          const isStep = select(tick, eq(stepIdx.load(), k), false);
          midiOut.emitIf(select(isStep, playing, false), {
            type: "noteOn", channel: 0,
            note: add(note, OFFSETS[k]),
            velocity: 96,
            atSample: i,
          });
        }
        stepIdx.store(select(tick, mod(add(stepIdx.load(), 1), STEPS), stepIdx.load()));
        out.set(0, i, 0);  // arp doesn't make audio itself
      });
    },
  };
});
`;
</script>

# MIDI

`midiInput` / `midiOutput` give you typed MIDI handlers without parsing raw bytes.

## midiInput

```ts
const midi = midiInput({ name: "midi" });

return {
  process: () => {
    midi.onEvent("noteOn", ({ note, velocity, channel, atSample }) => {
      // runs at block start — fan out across voice slots, etc.
      voiceNote[allocCursor.load()].store(note);
    });
    midi.onEvent("noteOff", ({ note }) => {
      // ...
    });
    midi.onEvent("cc", ({ controller, value }) => {
      // controller 1 = mod wheel, etc.
    });
    forSample((i) => { /* synthesis */ });
  },
};
```

Supported event types: `noteOn`, `noteOff`, `cc`, `pitchBend`, `programChange`, `channelPressure`, `aftertouch`, `systemRealtime`. Sysex content buffer is reserved for v1.x.0.

## midiOutput

```ts
const arpOut = midiOutput({ name: "arpOut" });

forSample.byN(64, (i) => {
  arpOut.emitIf(stepNow, {
    type: "noteOn",
    channel: 0,
    note: nextNote,
    velocity: 100,
    atSample: i,
  });
});
```

## Connecting Web MIDI

```ts
const node = await createWasmNode(ctx, processor, "name");
const access = await navigator.requestMIDIAccess();
for (const input of access.inputs.values()) {
  node.midi.connectFromWebMIDI(input);
}

// Send programmatically:
node.midi.send({ type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 });
// atTime is honoured (in seconds, host time):
node.midi.send({ type: "noteOff", channel: 0, note: 60, velocity: 0, atSample: 0 }, ctx.currentTime + 1);

// Subscribe to outbound MIDI:
node.midi.onEvent("noteOn", (e) => console.log("arp out:", e));
```

## Live arpeggiator

A 16-step arpeggiator that takes inbound MIDI and emits an arp pattern:

<TryIt label="arpeggiator" size="tall" source="silent" :code="tryItCode0" />
