# @unworklet/core

Write an AudioWorklet processor as a declarative TypeScript graph; unworklet
compiles it to WASM that runs on the audio thread. You describe the DSP with
typed primitives — no manual `AudioWorkletProcessor`, no `postMessage`
plumbing, no hand-written WASM.

> **For AI agents / LLMs:** the call forms below are exact and complete — do
> **not** invent alternatives or guess method names. Scalar state read/write is
> `.read()` / `.write(v)`; main↔worklet messaging is the `event` family
> (`event<T>({ from | to: "main" })`, `event.midi`). When unsure, copy one of the
> exact examples in this README rather than guessing. The source is the source of
> truth.

```bash
npm install @unworklet/core
# Almost always paired with the Vite plugin to load processors:
npm install -D @unworklet/vite-plugin
```

## A complete processor

A stereo gain with a per-channel peak meter — an effect that reads an input and
writes an output:

```ts
import { audioInput, audioOutput, defineProcessor, forSample, param, state } from "@unworklet/core";

export const stereoGain = defineProcessor(() => {
  // 1) Declarations — run once, at the top of the body.
  const input = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const gain = param
    .f32({ default: 1.0, min: 0.0, max: 4.0, automationRate: "a-rate" })
    .named("gain");

  const meterL = state.f32(0).expose({ name: "meterL", publish: { rateFps: 30 } });
  const meterR = state.f32(0).expose({ name: "meterR", publish: { rateFps: 30 } });

  // 2) process — runs every 128-sample render block.
  return {
    process: () => {
      forSample((i) => {
        const l = input.left.at(i).mul(gain.at(i));
        const r = input.right.at(i).mul(gain.at(i));
        out.left.at(i).write(l);
        out.right.at(i).write(r);
        meterL.write(l.abs().max(meterL.read()));
        meterR.write(r.abs().max(meterR.read()));
      });
      meterL.write(meterL.read().mul(0.95)); // decay
      meterR.write(meterR.read().mul(0.95));
    },
  };
});
```

Load and run it in the browser (with `@unworklet/vite-plugin`):

```ts
import { createNode } from "@unworklet/core";
import stereoGain from "./processor.ts?worklet"; // the `?worklet` query is required (default import)

const ctx = new AudioContext();
const node = await createNode(ctx, stereoGain);
source.connect(node.inputs.main);
node.outputs.main.connect(ctx.destination);
node.params.gain.value = 2.0;
node.state.meterL.subscribe((db) => (meterEl.style.height = `${db}px`));
```

`?worklet` hands you the file's `defineProcessor` export as the **default import** —
you write `export const stereoGain = …` in the processor file and import it as the
default here; the plugin bridges the two, so don't add `export default`. (`source`
and `meterEl` are your own input node and DOM element.) One browser rule: an
`AudioContext` starts **suspended**, so call `ctx.resume()` from a user gesture (a
click) — otherwise you wire everything up and hear nothing.

## Generate a tone

A processor needs no input. This is a 440 Hz sine, synthesized from a phasor —
so the body takes `ctx` to read the host `sampleRate` (the phase step depends on
it), and writes a **mono** output through `.ch(0)`:

```ts
import { audioOutput, defineProcessor, forSample, state } from "@unworklet/core";

const TWO_PI = 2 * Math.PI;

export const sine = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  const phase = state.f32(0); // a 0..1 phasor
  const step = 440 / ctx.sampleRate; // cycles advanced per sample

  return {
    process: () => {
      forSample((i) => {
        const next = phase.read().add(step).frac(); // advance, wrap to [0, 1)
        phase.write(next);
        const sample = next.mul(TWO_PI).sin().mul(0.2); // 0.2 amplitude
        out.ch(0).at(i).write(sample);
      });
    },
  };
});
```

## The DSL surface (exact forms)

Everything below is what you call. A `Node<T>` is a typed audio-rate value;
`T` is `'f32' | 'f64' | 'i32' | 'i64' | 'bool'`.

### Declarations — at the top of `defineProcessor(() => { ... })`

```ts
audioInput({ channels, name })      // → .left/.right (stereo) or .ch(c); read with .at(i)
audioOutput({ channels, name })     // → .left/.right or .ch(c); write with .at(i).write(v)
param.f32({ default, min, max, automationRate: "a-rate" | "k-rate" }).named("x")  // read .at(i)
state.f32(0).named("x")             // also .f64/.i32/.i64/.bool; read .read(), write .write(v)
state.buffer.f32({ size }).named("x")   // fixed array; .read(i), .write(i, v), .readInterpolated(pos)
event<T>({ to: "main", name })      // worklet → main; emit with .emitIf(cond, payload)
event<T>({ from: "main", name })    // main → worklet; receive with .onReceive(payload => ...)
event.midi({ from: "main", name })  // inbound MIDI; .onEvent("noteOn", e => ...)
event.midi({ to: "main", name })    // outbound MIDI; .emitIf(cond, midiEvent)
```

In an inbound-MIDI handler — `keys.onEvent("noteOn", e => …)` — the event `e`
carries `note`, `velocity`, `channel`, `atSample` as **`Node<"i32">`** (graph
values, not JS numbers). Reach the oscillator by writing them into `state` in the
handler and reading that `state` back in `process`; lift one into float math with
`f32(e.note)`. A worklet→main `event` has only `.emitIf(cond, payload)` (no bare
`emit`), so "fire on note start" is: set a flag `state` in the handler, then
`out.emitIf(flag.read(), …)` in `process`.

`.named("x")` (quick) and `.expose({ name, snapshot, publish })` (full) both name
a slot for main-thread access. `publish` (state/buffer, `{ rateFps }`) streams a
value to `node.state.<name>.subscribe(...)`. A named scalar `state` is **persistent
by default** — captured in `node.snapshot()` and offline `result.state`; pass
`snapshot: "transient"` to opt a named slot out. Buffers are the reverse (transient
unless `snapshot: "persistent"`). Naming is required for `publish`/`persistent`.

### Read / write (the part most often guessed wrong)

| What         | Read                                     | Write                                                  |
| ------------ | ---------------------------------------- | ------------------------------------------------------ |
| audio input  | `input.left.at(i)` / `input.ch(c).at(i)` | —                                                      |
| audio output | —                                        | `out.left.at(i).write(v)` / `out.ch(c).at(i).write(v)` |
| param        | `gain.at(i)`                             | — (driven from main via `node.params.<name>`)          |
| state scalar | `s.read()`                               | `s.write(v)`                                           |
| state buffer | `buf.read(i)`                            | `buf.write(i, v)`                                      |

`i` is the `forSample` loop counter. A literal offset must be `0..127`.

### Operations — free function **or** method form (identical)

```ts
add sub mul div mod neg            // arithmetic (f32/f64/i32/i64)
eq lt lte gt gte                   // comparison → Node<'bool'>
not select                        // select(cond, then, else)
abs min max clamp floor ceil frac  // numeric
sin cos tan tanh exp log sqrt      // float math
pipe                               // pipe(x, f, g) or x.pipe(f).pipe(g)
```

Both forms work: `mul(a, b)` ≡ `a.mul(b)`; `tanh(x)` ≡ `x.tanh()`. Scalar
constructors: `f32(0.5)`, `i32(1)`, `i64(1n)`, `bool(true)`, `num(x)` (loose f32).
Each also **casts a `Node`**: `f32(node)` reinterprets any scalar `Node` to
`Node<"f32">` — the `i32`→`f32` bridge float math needs (e.g. on a MIDI field).

### The loop

```ts
forSample((i) => {
  /* per sample, i = 0..127 */
});
forSample.byN(4, (i) => {
  /* SIMD stride; 4 | 128 */
});
```

## Public API (beyond the DSL)

- `defineProcessor(body)` / `defineSubgraph(body)` / `createSubgraph(decl, ...args)` — compose graphs. `defineProcessor` already returns a ready `CompiledProcessor` — hand it straight to `createNode` or `renderOffline` (`@unworklet/offline`).
- `compile(processor, opts?)` — graph → `{ wasm, driver, graph, memory, diagnostics, schemaHash }` (`driver` instantiates the WASM; the offline renderer uses it). You rarely call this yourself; the Vite plugin and the offline renderer compile for you.
- `createNode(context, processor, options?)` — main-thread `UnworkletNode<C>` (`node`, `inputs`, `outputs`, `params`, `state`, `events`, `midi`, `snapshot`, `restore`, `onError`, `diagnostics`, `dispose`).
- `replaceProcessor(oldNode, newProcessor)` — hot-swap a running processor.
- `inspect(blob)` — decode a snapshot without an `AudioContext`.
- Snapshot codec: `encodeSnapshot` / `decodeSnapshot` / `inspectSnapshot` / `runMigrations` / `SNAPSHOT_VERSION`.
- MIDI wire codec: `midiEventToWire` / `wireToMidiEvent`.
- Capacity constants: `CAPACITY_16` … `CAPACITY_16384`, `SAMPLES_PER_BLOCK` (= 128).

## Realtime safety

The compiler enforces the audio-thread contract at build time: no heap
allocation, no unbounded loops, no exceptions, no blocking I/O, no GC. A
processor that compiles is realtime-safe.

## Related packages

- `@unworklet/vite-plugin` — load processors via `?worklet`, plus DevTools.
- `@unworklet/lang` — write processors in `.uwk.ts` sugar (infix operators, index access).
- `@unworklet/offline` — render a processor to PCM in Node/Bun/Deno.
- `@unworklet/test` — audio/event/MIDI assertions for Vitest.

License: MIT.
