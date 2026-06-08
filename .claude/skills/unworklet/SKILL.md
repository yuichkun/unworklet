---
name: unworklet
description: Write correct unworklet audio code. Use when building or editing anything with unworklet — an AudioWorklet DSP processor via the declarative TypeScript DSL (defineProcessor / .uwk.ts), loading a processor with the ?worklet import, rendering offline, or testing audio/MIDI/state. Carries the exact DSL call forms so you don't guess them and don't hallucinate APIs.
---

# unworklet

unworklet compiles a declarative TypeScript graph into a WASM AudioWorklet
processor. You describe DSP with typed primitives — no hand-written
`AudioWorkletProcessor`, no `postMessage`, no manual WASM. A processor that
compiles is realtime-safe (the compiler forbids heap allocation, unbounded
loops, exceptions, blocking I/O, and GC on the audio thread).

**The source code is the source of truth.** The forms below are exact and are
covered by tests (`packages/offline/src/docs-examples.test.ts`). Do not
substitute API shapes from memory. If you need a form not shown here, read the
package READMEs in `node_modules/@unworklet/*/README.md` or
`docs/12-canonical-examples.md`.

## Packages

| package                     | role                                                    |
| --------------------------- | ------------------------------------------------------- |
| `@unworklet/core`           | the DSL + compiler + main-thread client (always needed) |
| `@unworklet/unplugin` (dev) | load processors via `?worklet`; DevTools panel          |
| `@unworklet/lang`           | optional `.uwk.ts` sugar (`a * b` for `a.mul(b)`)       |
| `@unworklet/offline`        | render a processor to PCM in Node/Bun/Deno              |
| `@unworklet/test`           | audio/event/MIDI/state assertions for Vitest            |

## Workflow

1. Author `name.processor.ts` exporting `defineProcessor(() => ...)` (or
   `name.uwk.ts` for sugar).
2. In the app, import it with the `?worklet` query and call `createNode`.
3. Verify with `@unworklet/offline` + `@unworklet/test` before shipping.

## A complete processor (verified)

```ts
import { audioInput, audioOutput, defineProcessor, forSample, param, state } from "@unworklet/core";

export const stereoGain = defineProcessor(() => {
  const input = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const gain = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" }).named("gain");
  const meterL = state.f32(0).expose({ name: "meterL", publish: { rateFps: 30 } });

  return {
    process: () => {
      forSample((i) => {
        const l = input.left.at(i).mul(gain.at(i));
        out.left.at(i).write(l);
        out.right.at(i).write(input.right.at(i).mul(gain.at(i)));
        meterL.write(l.abs().max(meterL.read()));
      });
      meterL.write(meterL.read().mul(0.95));
    },
  };
});
```

## A MIDI synth (verified)

```ts
import {
  audioOutput,
  defineProcessor,
  event,
  f32,
  f64,
  forSample,
  select,
  state,
} from "@unworklet/core";

export const midiSynth = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  const notes = event.midi({ from: "main", name: "notes" });
  const phase = state.f64(0).named("phase");
  const note = state.i32(69).named("note");
  const gate = state.bool(false).named("gate");

  return {
    process: () => {
      notes.onEvent("noteOn", ({ note: n }) => {
        note.write(n);
        gate.write(true);
      });
      notes.onEvent("noteOff", () => {
        gate.write(false);
      });
      forSample((i) => {
        const freqHz = f32(note.read())
          .sub(69)
          .mul(Math.LN2 / 12)
          .exp()
          .mul(440);
        const p = phase
          .read()
          .add(f64(freqHz.mul((2 * Math.PI) / ctx.sampleRate)))
          .mod(2 * Math.PI);
        out
          .ch(0)
          .at(i)
          .write(f32(p.sin()).mul(select(gate.read(), 0.3, 0)));
        phase.write(p);
      });
    },
  };
});
```

## DSL surface (exact)

**Declarations** (top of the body):

```ts
audioInput({ channels, name })       audioOutput({ channels, name })
param.f32({ default, min, max, automationRate: "a-rate" | "k-rate" }).named("g")
state.f32(0).named("s")              // .f64 / .i32 / .i64 / .bool too
state.buffer.f32({ size }).named("b")    // arrays; element types incl .u8
event({ to: "main", name })          event({ from: "main", name })
event.midi({ to: "main", name })     event.midi({ from: "main", name })
```

**Read / write** (the most-guessed-wrong part):

|              | read                                       | write                                                 |
| ------------ | ------------------------------------------ | ----------------------------------------------------- |
| audio input  | `in.left.at(i)`, `in.ch(c).at(i)`          | —                                                     |
| audio output | —                                          | `out.left.at(i).write(v)`, `out.ch(c).at(i).write(v)` |
| param        | `g.at(i)`                                  | from main via `node.params.<name>`                    |
| state scalar | `s.read()`                                 | `s.write(v)`                                          |
| state buffer | `buf.read(i)`, `buf.readInterpolated(pos)` | `buf.write(i, v)`                                     |

**Operations** — free function or method form (identical):
`add sub mul div mod neg` · `eq lt lte gt gte` · `not select` · `abs min max
clamp floor ceil frac` · `sin cos tan tanh exp log sqrt` · `pipe`.
Scalar constructors / casts: `f32(x) f64(x) i32(x) i64(1n) bool(true) num(x)` —
`f32(node)` also casts any scalar `Node` to `Node<"f32">` (the `i32`→`f32` bridge,
e.g. a MIDI field; see the synth above).

**Loop:** `forSample((i) => ...)` (i = 0..127) · `forSample.byN(4, (i) => ...)`.

**SIMD (`.ts` only, opt-in):** `import { vec4, splat, addVec, mulVec, sumLanes } from "@unworklet/core/simd"` — then `v = buf.loadVec(i)`, `v.lane(0..3)`, `buf.storeVec(i, v)` (f32 buffers; pairs with `forSample.byN(4)`).

**Subgraphs:** `defineSubgraph((args) => ({ run: (x) => ... }))` + `createSubgraph(sg, ...args, { name })` in declaration scope (`$prev` feedback is `.uwk.ts`-only).

**Migrations:** `defineProcessor(body, { migrations: [{ from, to, migrate(blob, h) { ... } }] })` (`migrate` is sync).

**Events / MIDI bodies:**
`ev.emitIf(cond, { field: value })` (worklet→main) ·
`ev.onReceive(({ a, b }) => ...)` (main→worklet) ·
`midiIn.onEvent("noteOn", ({ note, velocity, channel }) => ...)` ·
`midiOut.emitIf(cond, { type: "noteOn", channel, note, velocity })`.
An inbound handler's fields (`note` / `velocity` / `channel` / `atSample`) are
`Node<"i32">`, not JS numbers — cast with `f32(note)` for float math and write them
into `state` to reach `process` (see the synth above). A worklet→main `event` has
only `.emitIf` (no bare `.emit`).

## Loading + driving (main thread)

```ts
import { createNode } from "@unworklet/core";
import stereoGain from "./stereo-gain.processor.ts?worklet"; // ?worklet is required (default import)

const node = await createNode(ctx, stereoGain);
node.outputs.main.connect(ctx.destination);
source.connect(node.inputs.main);
node.params.gain.value = 2;                    // AudioParam
node.state.meterL.subscribe((v) => { ... });   // published value
node.midi.notes.send({ type: "noteOn", channel: 0, note: 60, velocity: 100 });   // main → worklet
node.midi.out.onEvent("noteOn", (e) => { ... });   // outbound MIDI: worklet → main
node.events.tempo.on((p) => { ... });          // worklet → main event
node.events.setCount.emit({ value: 42 });      // main → worklet send (event({ from: "main" }))
const blob = await node.snapshot();            // ASYNC; const res = await node.restore(blob); if (!res.ok) {...}
```

Every `node.*` surface above (params / state / events / midi / inputs / outputs)
is typed per-processor — names complete, an undeclared name errors — when
`vite-env.d.ts` references both `@unworklet/unplugin/client` and the
plugin-generated `./.unworklet/worklets.d.ts`. The plugin writes `.unworklet/` on
dev/build; gitignore it.

## Verify

```ts
import { renderOffline } from "@unworklet/offline";
import { sine, expectNoNaN, expectStable, expectGainAtFreq } from "@unworklet/test";

const r = await renderOffline(stereoGain, {
  sampleRate: 48000,
  duration: 1,
  inputs: { main: [sine({ freqHz: 440, durationSamples: 48000, sampleRate: 48000 })] },
  params: { gain: [2] },
  // drive inbound too: messages: [{ name, payload }], events: [{ name, payload, atSample }] (events = inbound MIDI)
});
expectNoNaN(r);
expectStable(r);
```

## Do NOT (common hallucinations)

- State is `s.read()` / `s.write(v)` — never `.load()/.store()`, `.get()/.set()`, or `s = v` (bare assignment is not a scalar write).
- Index audio I/O & params with `.at(i)`; buffers with `.read(i)` / `.write(i, v)`.
- Every port needs a `name`; constructors take an options object, never positional args.
- No standalone `message<T>()`: main→worklet delivery is `event({ from: "main", name })`.
- No `midiInput()/midiOutput()`: use `event.midi({ from | to: "main", name })`.
- Import a processor with `?worklet`; don't import the raw module into the app.
- Infix operators (`a * b`, `a + b`) on `Node`s are `.uwk.ts`-only. In `.ts` / `.processor.ts` use methods or free functions (`a.mul(b)` / `mul(a, b)`).
- Don't mix `.uwk.ts` sugar with the plain `.ts` API in one file. A `.uwk.ts` needs a `// @ts-nocheck` header UNLESS the `@unworklet/lang` editor plugin is set up (then the sugar type-checks and the header is dropped).

## `.uwk.ts` sugar (optional)

`.uwk.ts` desugars to the same primitives: `a * b` → `a.mul(b)`, `out.left[i] = v`
→ `out.left.at(i).write(v)`, `buf[i]` → `buf.read(i)`, a bare `state` in a value
position → `state.read()`. Scalar writes are still explicit `state.write(v)`.
The body is wrapped in ambient `process(() => { ... })`. For IDE type-checking of
the sugar (drop `// @ts-nocheck`), add `@unworklet/lang/typescript-plugin` to
`tsconfig` `plugins` — that single entry is the whole setup; the plugin auto-injects
the shipped ambient `.d.ts`, so there is no `files` / `types` entry to add. For a
build-time check, use `unworklet-tsc` in place of `tsc`. See `@unworklet/lang`'s
README → IDE support.
