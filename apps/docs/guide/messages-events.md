<script setup>
const tryItCode0 = `import {
  defineProcessor, audioInput, audioOutput, state, buffer, message, forSample,
  add, mul, lt, select,
} from "@unworklet/core";

export const sampler = defineProcessor(() => {
  const main = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });

  // 4-second sample buffer + state for playback head + length.
  const buf = buffer.f32({ size: 48000 * 4, name: "buf", snapshot: "persistent" });
  const playHead = state.i32(0, { name: "playHead" });
  const sampleLen = state.i32(0, { name: "sampleLen" });

  // upload message: typed-array payload of f32 samples, max 4 seconds.
  const upload = message({
    name: "upload",
    capacity: 4,
    payload: { samples: { type: "f32", maxLength: 48000 * 4 } },
  });
  const trigger = message({ name: "trigger", capacity: 8 });

  return {
    process: () => {
      upload.onReceive(({ samples }) => {
        // copyTo lowers to memory.copy in WASM — single instruction, no loop.
        samples.copyTo(buf, 0, samples.length());
        sampleLen.store(samples.length());
      });
      trigger.onReceive(() => {
        playHead.store(0);
      });
      forSample((i) => {
        const pos = playHead.load();
        const len = sampleLen.load();
        const playing = lt(pos, len);
        const v = select(playing, buf.read(pos), 0);
        playHead.store(select(playing, add(pos, 1), pos));
        out.set(0, i, add(main.at(0, i), v));  // mix sample with input
      });
    },
  };
});
`;
</script>

# Messages + events

unworklet has two message channels:

- `message<T>` — main → audio. UI events, sample uploads, preset changes.
- `event<T>` — audio → main. Note triggers, peak markers, transient detections.

Both are SAB-backed ringbuffers. Per-slot fields go in fixed memory; typed-array payloads (e.g. `Float32Array` sample uploads) go in a per-slot content buffer.

## message — main → audio

Declare with a payload schema:

```ts
const ping = message<{ delta: number }>({
  name: "ping",
  capacity: 8,
});

return {
  process: () => {
    ping.onReceive(({ delta }) => {
      // Runs at block start, before the per-sample loop.
      counterState.store(add(counterState.load(), delta));
    });
    forSample((i) => { /* ... */ });
  },
};
```

From the host:

```ts
const node = await createWasmNode(ctx, processor, "name");
node.messages.ping({ delta: 0.5 });
node.messages.ping.diagnostics.overflowCount();  // 0 unless you flooded it
```

## Variable-length typed-array payloads

For sample / IR / pattern uploads, declare the typed-array fields:

<TryIt label="upload + play" size="tall" :code="tryItCode0" />

The `samples.copyTo(buf, dstOffset, count)` lowers to a single `memory.copy` instruction — no per-element JS loop, no allocation. There's also `samples.read(idx)` for individual reads, `samples.length()` for the length, and `samples.copyToIf(cond, ...)` for guarded fan-out.

## event — audio → main

The audio thread emits, the main thread subscribes:

```ts
const grainSpawned = event<{ voice: number; pos: number }>({
  name: "grainSpawned",
  capacity: 64,
});

forSample((i) => {
  // emit when a new grain starts
  grainSpawned.emitIf(spawnNow, {
    atSample: i,        // sample-accurate timestamp within the block
    voice: voiceIdx,
    pos: grainStart,
  });
});
```

```ts
node.events.grainSpawned.on((payload) => {
  console.log("grain", payload);
});
node.events.grainSpawned.diagnostics.overflowCount();
```

The audio thread writes through Atomics; the main thread reads through Atomics. Drop-oldest on overflow, with the count surfaced for monitoring.

## atSample — sample-accurate timestamps

`emitIf({ atSample: i, ... })` records exactly which sample within the block the event happened on. Main-side handlers receive the (block-relative) sample index for sequencing.

## Capacity + overflow

`{ capacity: N }` is rounded up to the next power of 2. When the producer outruns the consumer, the framework drops the oldest entry and bumps `overflowCount()`. Your UI never blocks the audio thread.
