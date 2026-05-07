<script setup>
const tryItCode0 = `import { defineProcessor, audioInput, audioOutput, forSample } from "@unworklet/core";

// Swap left + right channels.
export const swap = defineProcessor(() => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });

  return {
    process: () => {
      forSample((i) => {
        out.set(0, i, main.at(1, i));  // L = old R
        out.set(1, i, main.at(0, i));  // R = old L
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

<TryIt label="ping-pong copy" :code="tryItCode0" />

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
  out.set(0, i, buf.read(next));
});

// ✗ throws (toPrimitive trap)
forSample((i) => {
  out.set(0, i, buf.read(i + 1));  // i is a graph node, not a number
});
```

## Multiple outputs

```ts
const wet = audioOutput({ channels: 2, name: "wet" });
const dry = audioOutput({ channels: 2, name: "dry" });

return {
  process: () => {
    forSample((i) => {
      wet.set(0, i, /* processed L */);
      wet.set(1, i, /* processed R */);
      dry.set(0, i, main.at(0, i));
      dry.set(1, i, main.at(1, i));
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

## Static-analysis guarantees

The compiler refuses to ship a processor that:

- Declares an `audioOutput` and never writes to it (`audio-output-not-written` error).
- Uses `forSample.byN(7, ...)` where 7 doesn't divide the render quantum (`loop-stride-not-divisor` warning).
- Writes the same channel twice in one `forSample` body (`duplicate-output-write` warning — the second write shadows the first).

Run `unworklet analyze ./my-processor.ts` to see the full report before booting.
