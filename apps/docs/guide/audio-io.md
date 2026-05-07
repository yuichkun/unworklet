<script setup>
const tryItCode0 = `import { defineProcessor, audioInput, audioOutput, forSample } from "@unworklet/core";

// Swap left + right channels.
export const swap = defineProcessor(() => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });

  return {
    process: () => {
      forSample((i) => {
        // .left/.right are stereo shorthand for .at(0, i) / .at(1, i).
        out.left.set(i,  main.right.at(i));
        out.right.set(i, main.left.at(i));
      });
    },
  };
});
`;
</script>

# Audio I/O + forSample

## audioInput / audioOutput

Every processor declares its ports up front:

```ts
const main = audioInput({ channels: 2, name: "main" });
const sidechain = audioInput({ channels: 2, name: "sidechain" });
const out = audioOutput({ channels: 2, name: "main" });
```

Each port has:

- A `name` (used as the key in `node.inputs.<name>` / `node.outputs.<name>`).
- A `channels` count (mono = 1, stereo = 2; up to 16 supported).

Multiple inputs and outputs are first-class. The framework wires them to the AudioWorkletNode's input/output port indices in declaration order.

## Reading + writing samples

Inside `forSample`, `main.at(channel, i)` reads sample `i` of channel `channel`. `out.set(channel, i, value)` writes.

### Stereo shorthand: `.left` / `.right`

When a port is declared `channels: 2`, the handle exposes `.left` (channel 0) and `.right` (channel 1) views — sugar that drops the channel index:

```ts
out.left.set(i, main.left.at(i));        // identical to out.set(0, i, main.at(0, i))
out.right.set(i, main.right.at(i));      // identical to out.set(1, i, main.at(1, i))
```

The shorthand is type-gated: `.left` / `.right` are only present when `channels === 2`. For mono or N-channel ports, use `at(c, i)` / `set(c, i, v)`.

<TryIt label="ping-pong copy" :code="tryItCode0" />

### Iterating channels at capture time

For 3+ channels you can fan out with a normal JS `for` loop — `forSample` runs once at capture time, so the loop is unrolled before WASM emission:

```ts
const surround = audioInput({ channels: 6, name: "main" });
const out6 = audioOutput({ channels: 6, name: "main" });
forSample((i) => {
  for (let c = 0; c < 6; c++) {
    out6.set(c, i, mul(surround.at(c, i), gain.at(i)));
  }
});
```

The captured graph contains six explicit `audio-out-set` statements — the loop itself disappears.

## forSample.byN

If your DSP can update at a slower rate (e.g. filter coefficient updates, LFO ticks), `forSample.byN(stride, ...)` runs every `stride`-th sample only. The stride must be a power of 2 that divides the render quantum (128); the static analyzer warns otherwise.

```ts
forSample.byN(4, (i) => {
  // runs at sample 0, 4, 8, ..., 124 — 32 times per block instead of 128.
});
```

## everyNSamples

For DSP that runs strictly less often (envelope coefs, smoothing), nest `everyNSamples` inside `forSample`:

```ts
forSample((i) => {
  everyNSamples(64, () => {
    // runs once every 64 samples on average — twice per 128-sample block.
    coefSlot.store(/* updated coefficient */);
  });
  // ... per-sample work using the coefficient
});
```

## Channel up/down mix

The framework follows Web Audio's standard up/down-mix rules **before** the processor runs. If your processor declares `channels: 2` but the source connects mono audio, the worklet sees the mono channel duplicated to L+R. You don't need to handle this case in your DSL.

## Sample-position semantics

`i` inside `forSample` is a `Node<'i32'>` — a graph node, not a JS integer. Use `add(i, 1)` for arithmetic, not `i + 1`:

```ts
// ✓ correct
forSample((i) => {
  const next = add(i, 1);
  out.left.set(i, buf.read(next));
});

// ✗ throws (toPrimitive trap)
forSample((i) => {
  out.left.set(i, buf.read(i + 1));  // i is a graph node, not a number
});
```

## Multiple outputs

```ts
const wet = audioOutput({ channels: 2, name: "wet" });
const dry = audioOutput({ channels: 2, name: "dry" });

return {
  process: () => {
    forSample((i) => {
      wet.left.set(i,  /* processed L */);
      wet.right.set(i, /* processed R */);
      dry.left.set(i,  main.left.at(i));
      dry.right.set(i, main.right.at(i));
    });
  },
};
```

The host accesses each output by name:

```ts
const node = await createWasmNode(ctx, processor, "name");
node.outputs.wet.connect(reverbInput);
node.outputs.dry.connect(ctx.destination);
```

## Processor context

`defineProcessor((ctx) => …)` receives a context object with the host's runtime configuration plus a couple of unit-conversion helpers:

```ts
defineProcessor((ctx) => {
  ctx.sampleRate;       // 48000 in most browsers
  ctx.renderQuantum;    // 128 in Web Audio (the forSample iteration count)

  // ms → samples (rounded), at this processor's sample rate
  const tail = buffer.f32({ size: ctx.samples(2000), name: "tail" });   // 2s

  // MIDI note → Hz (A4 = 440)
  const aRef = ctx.hz(69);   // 440
  const c4 = ctx.hz(60);     // ≈ 261.63
});
```

`ctx.samples` and `ctx.hz` return plain JS numbers, not graph nodes — use them at setup time (`buffer({ size })`, initial state values) or as constants inside the process body. They keep code sample-rate-portable: don't hardcode `96000` for "two seconds at 48 kHz."

## Static-analysis guarantees

The compiler refuses to ship a processor that:

- Declares an `audioOutput` and never writes to it (`audio-output-not-written` error).
- Uses `forSample.byN(7, ...)` where 7 doesn't divide the render quantum (`loop-stride-not-divisor` warning).
- Writes the same channel twice in one `forSample` body (`duplicate-output-write` warning — the second write shadows the first).

Run `unworklet analyze ./my-processor.ts` to see the full report before booting.
