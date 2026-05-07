# unworklet patcher

A Max/MSP-style node-based patching environment built on top of unworklet — sandboxed under `apps/patcher` to demonstrate that the library's primitives are expressive enough to power a real DAW-grade live coding environment without a single change to the core packages.

> **Demo / 素振り**. Don't take it as production. Take it as proof: drag an oscillator onto a canvas, wire it to a `dac~`, hit play, you get audio. Add a node mid-playback, the patch hot-swaps with a 50ms crossfade so you don't hear a click.

## What it is

- **A live patcher canvas**. Right-click to open a node palette; drag boxes; wire inlets to outlets with cords.
- **~80 MSP-equivalent nodes**, each implemented using unworklet primitives. Oscillators, math, filters, delays, envelopes, dynamics, routing, conversion, sampling, viz — everything that comes up in 95% of real Max patches.
- **A real compilation pipeline**: every patch edit re-runs `patchToProcessor → compileToWasm → createWasmNode`, the resulting `AudioWorkletNode` is crossfaded against the previous one over 50ms.
- **A `gen~`-equivalent inline code node**: double-click, write a `defineSubgraph` body (every unworklet symbol is in scope, no imports), apply, get a WASM-compiled DSP block.
- **A `patcher` (subpatch) node**: an inner canvas that compiles to a `defineSubgraph`, so each instance has its own state.
- **8 example patches** that play audio in the browser:

| # | Patch | What it shows |
| --- | --- | --- |
| 01 | hello sine | The 5-second tutorial — `cycle~` → `*~` → `dac~`. |
| 02 | FM synth | Two-operator FM with detuned modulator. Drag the dials. |
| 03 | monosynth | Detuned `saw~` × 2 → `lores~` resonant filter → vca → out. |
| 04 | noise + comb | White noise → `comb~` (internal feedback) — Karplus-Strong-ish. |
| 05 | kick drum | `metro` → `curve~` envelopes → `cycle~` → vca. |
| 06 | tremolo + scope | Sine carrier × LFO modulator, with `scope~` and `meter~`. |
| 07 | Karplus-Strong (gen~) | Plucked-string algorithm written inline as user code. |
| 08 | subpatch chorus | A reusable single-voice chorus implemented as a `patcher`. |

## How to run

```sh
vp install              # workspace deps
vp run dev              # serves apps/patcher at http://localhost:5174
```

Pick an example from the dropdown, click **▶ play**. Audio plays. Drag any dial; you'll hear the parameter change with no click.

To verify everything still produces audio in a fresh headless browser:

```sh
node --experimental-strip-types apps/patcher/scripts/smoke.ts
# expected:  8/8 examples produced audio
```

## Architecture

```
   patch JSON ──┐
                ↓
   ┌────────────────────────────────────────┐
   │  src/compiler/compile.ts               │
   │  patchToProcessor(patch)               │
   │   → topo sort cords                    │
   │   → emit a defineProcessor body that   │
   │     calls each node's build(ctx)       │
   │   → return CompiledProcessor + IO map  │
   └────────────────────────────────────────┘
                    │
                    ↓ CompiledProcessor
   ┌────────────────────────────────────────┐
   │  src/runtime/AudioRuntime.ts           │
   │  swap(patch):                          │
   │   compileToWasm → createWasmNode       │
   │   → connect to a fresh GainNode        │
   │   → 50ms linear ramp on old + new      │
   │   → dispose old after fade             │
   └────────────────────────────────────────┘
                    │
                    ↓
              [AudioContext.destination]
```

### Node registry

Every node type is registered in `src/registry/*.ts` via `register({...})`. A `NodeDef` declares:

- `inlets` / `outlets` (with `kind: "audio" | "control"`)
- `attrs` (UI-editable settings)
- `paramSpec` (for slider/dial/number-box — declares an `AudioParam` on the compiled processor)
- `ioSpec` (for `dac~` / `adc~` — declares `audioInput`/`audioOutput`)
- `build(ctx, args, attrs) → Node<f32>[]` — the heart: contributes to the captured graph at compile time.

Audio cords landing on a single inlet **sum** (Max convention). Control cords replace the literal default. Control-rate sources flow into audio inlets fine — both sides are `Node<f32>` at the captured-graph level.

### Hot-swap

- A swap that produces an identical processor (same JSON, no edits) is a no-op.
- A swap with structural changes builds a new `WasmUnworkletNode`, connects it through a new `GainNode` at gain 0, simultaneously ramps old → 0 and new → 1 over 50 ms, then disposes the old node 70 ms later.
- Param-only edits (slider drag, number box change) update the `AudioParam.value` directly — no recompile, no AudioWorkletNode churn.

### gen~

A `gen~` node holds a code string in `attrs.code`. At compile time the build wraps it in a `defineSubgraph`:

```ts
const sub = core.defineSubgraph((...inputs) => {
  const fn = new Function(
    "core", "in1", "in2", "in3", "in4",
    "add", "sub", "mul", ..., "state", "buffer",  // all unworklet bindings
    code,                                          // the user's body
  );
  return fn(/* the bindings */);
});
const outs = sub(ctx.inAudio(0), ctx.inAudio(1), ...);
```

The user just writes:

```ts
const phase = state.f32(0);
const inc = in1.div(48000);
const next = phase.load().add(inc).mod(1);
phase.store(next);
return [next.mul(2).sub(1)];
```

— no imports, no boilerplate. Each `gen~` instance has its own state pool because each is a different subgraph call site.

### patcher (subpatch)

A `patcher` node holds a child `Patch` in `attrs.patch`. Its inner `inlet` / `outlet` placeholders mark the subgraph boundary. The compiler walks the inner patch in subgraph mode (see `registry/patcher.ts` `compileInnerPatch`), wires `inlet[i]` to the subgraph's `i`-th argument, and returns the inner `outlet[j]` values as the subgraph result. The outer patch calls the subgraph at the `patcher` node's position.

Example 08 instantiates a chorus voice this way and could just as easily instantiate it twice (once per L / R channel) — each call site gets its own delay-line state.

### Why no library changes

The whole patcher is just **using** unworklet's public API:

- `defineProcessor`, `defineSubgraph`, `state`, `buffer`, `param`, `audioInput`, `audioOutput`, `forSample`
- The chain method surface (`.add`, `.mul`, `.sin`, `.gte`, ...)
- `compileToWasm`, `createWasmNode`, `generateWorkletBundle`

Nothing under `packages/` is touched. The patcher proves that the library surface is enough.

## Limitations / out of scope (for this PR)

- No persistence beyond JSON copy/paste — the user can clipboard a patch but there's no project file format yet.
- No undo/redo. (Browser back-button-style state isn't wired.)
- No `tapin~`/`tapout~` cross-cord feedback (use `comb~`/`allpass~` for now — they have internal feedback).
- No `groove~`/`play~` sample player (would need user-supplied audio file uploads).
- Drum machine example is a single kick — a full step sequencer with `counter`/`sel` works in WASM but the `metro`-pulse + `curve~`-tracking interaction was finicky to tune for the smoke test, so the demo is intentionally minimal.

## Files at a glance

```
apps/patcher/
├── package.json                # @vue-flow/core + @unworklet/* + monaco
├── vite.config.ts              # COOP/COEP, port 5174
├── index.html
├── src/
│   ├── main.ts
│   ├── App.vue                 # toolbar + canvas + inspector
│   ├── style.css
│   ├── types.ts                # Patch, NodeDef, BuildCtx, Cord
│   ├── compiler/
│   │   ├── compile.ts          # patchToProcessor — the heart
│   │   └── topo.ts             # topological sort over audio cords
│   ├── runtime/
│   │   └── AudioRuntime.ts     # createWasmNode + 50 ms crossfade swap
│   ├── registry/               # ~80 node defs grouped by category
│   │   ├── store.ts            # registry storage (avoids ESM TDZ)
│   │   ├── index.ts            # public surface + side-effect registration
│   │   ├── audio-osc.ts
│   │   ├── audio-math.ts
│   │   ├── audio-trig.ts
│   │   ├── audio-filters.ts
│   │   ├── audio-delays.ts
│   │   ├── audio-envelopes.ts
│   │   ├── audio-dynamics.ts
│   │   ├── audio-routing.ts
│   │   ├── audio-conv.ts
│   │   ├── audio-sampling.ts
│   │   ├── audio-viz.ts
│   │   ├── audio-io.ts
│   │   ├── control.ts
│   │   ├── control-time.ts
│   │   ├── midi.ts
│   │   ├── ui.ts
│   │   ├── gen.ts              # gen~ — inline-code defineSubgraph
│   │   └── patcher.ts          # patcher (subpatch) + inlet/outlet
│   ├── components/
│   │   ├── Canvas.vue          # Vue Flow integration + node-palette
│   │   ├── InspectorPanel.vue
│   │   └── nodes/              # per-type renderers
│   │       ├── AudioNodeView.vue
│   │       ├── SliderView.vue, VSliderView.vue, DialView.vue
│   │       ├── NumberBoxView.vue, ButtonView.vue, ToggleView.vue
│   │       ├── KsliderView.vue, MultisliderView.vue, UMenuView.vue
│   │       ├── CommentView.vue
│   │       ├── GenView.vue, PatcherView.vue
│   └── examples/               # 8 .json patches loaded via import.meta.glob
└── scripts/
    └── smoke.ts                # headless playwright: 8/8 examples → audio
```
