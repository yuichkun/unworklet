# unworklet patcher

A Max/MSP-style node-based patching environment built on top of unworklet — sandboxed under `apps/patcher` to demonstrate that the library's primitives are expressive enough to power a real DAW-grade live coding environment without a single change to the core packages.

> **Demo / 素振り**. Don't take it as production. Take it as proof: drag an oscillator onto a canvas, wire it to a `dac~`, hit play, you get audio. Add a node mid-playback, the patch hot-swaps with a 50ms crossfade so you don't hear a click.

## What it is

- **A live patcher canvas**. Right-click to open a node palette; drag boxes; wire inlets to outlets with cords.
- **120 MSP-equivalent nodes**, each implemented using unworklet primitives. Oscillators, math, filters, delays, envelopes, dynamics, routing, conversion, sampling, viz, MIDI — everything that comes up in 95% of real Max patches. (Verified live by `scripts/audit.ts` — 120 types loaded from the runtime registry.)
- **A real compilation pipeline**: every patch edit re-runs `patchToProcessor → compileToWasm → createWasmNode`, the resulting `AudioWorkletNode` is crossfaded against the previous one over 50ms.
- **A `gen~`-equivalent inline code node**: double-click, get a real **Monaco editor** (with TypeScript IntelliSense for the unworklet DSL), write a `defineSubgraph` body (every unworklet symbol is in scope, no imports), apply, get a WASM-compiled DSP block.
- **A `patcher` (subpatch) node**: an inner canvas that compiles to a `defineSubgraph`, so each instance has its own state. **Double-click descends** into the subpatch; a breadcrumb in the toolbar walks you back up.
- **Live mic input**: toolbar "🎤 enable mic" wires `getUserMedia` to every `adc~` in the live patch.
- **Web MIDI**: toolbar "🎹 enable MIDI" opens `requestMIDIAccess` and routes incoming MIDI to `notein` / `ctlin` / `pitchbend` AudioParams. Outgoing `noteout` / `ctlout` / `midiout` forward to every connected `MIDIOutput.send()`.
- **Real visualization components**: `scope~` draws the latest 1024 samples; `meter~` shows VU + peak hold; `spectroscope~` runs an FFT on the published buffer; `number~` prints the latest sample.
- **A breakpoint curve editor (`function`)**: drag points around; sample with a phasor; the build emits piecewise-linear interpolation at audio rate.
- **`tapin~` / `tapout~` shared bus**: matching `attrs.bus` strings causes both nodes to share a single underlying delay buffer (Max convention). Multiple `tapout~` on one bus = multi-tap delay.
- **25 example patches** that all play audio in the browser, every registered node appears in at least one example (smoke + audit verified):

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
| 09 | oscillator tour | All 8 oscillators routed through `selector~` + `umenu`. |
| 10 | filter bank | One saw fans out to all 8 filters; per-filter `gain~`. |
| 11 | waveshaping | All 16 unary signal-rate transforms in series. |
| 12 | multi-tap delay | One `tapin~`, three `tapout~` on the same bus. |
| 13 | sidechain compressor | `compand~` ducked by a kick via `peakamp~`; `limit~` on output. |
| 14 | stereo routing | `matrix~` M/S, `gate~`, `pong~` panning, `mute~`. |
| 15 | SaH step seq | `sah~` on noise, `count~`, `rate~`, `adsr~` gated by metro. |
| 16 | function envelope | Drag breakpoints in `function`; sampled by phasor → carrier amp. |
| 17 | line~ smoothing | Slider→`line~` smooths cutoff at audio rate; `scope~`/`meter~`/`number~`. |
| 18 | conversion tour | `mtof~` / `ftom~` / `dbtoa~` / `atodb~`. |
| 19 | control routing | `loadbang`/`bang`/`t`/`metro`/`counter`/`sel`/`route`/`pak`/`unpack`/`random`/`expr`/`scale`/`abs`/`min`/`max`. |
| 20 | control arithmetic | All control-rate `+`/`-`/`*`/`/`/`==`/`!=`/`<`/`>`/`<=`/`>=`/`gate`/`line`. |
| 21 | UI tour | Every UI node placed once; the active path drives a cycle~. |
| 22 | MIDI CC + note + pb | `notein` → mtof~, `ctlin`/`pitchbend` modulating filter cutoff/freq. |
| 23 | MIDI out | `noteout`/`ctlout`/`midiout` forward to `MIDIOutput.send()`. |
| 24 | signal math | `-~`/`/~`/`min~`/`max~` summed. |
| 25 | adc~ passthrough | Mic → `biquad~` (with synth fallback for headless smoke). |

## How to run

```sh
vp install              # workspace deps
vp run dev              # serves apps/patcher at http://localhost:5174
```

Pick an example from the dropdown, click **▶ play**. Audio plays. Drag any dial; you'll hear the parameter change with no click.

To verify everything still produces audio in a fresh headless browser:

```sh
# 1. start the dev server
npm --prefix apps/patcher run dev &
# 2. smoke each example
node --experimental-strip-types apps/patcher/scripts/smoke.ts
# expected:  25/25 examples produced audio
# 3. structural + coverage audit
node --experimental-strip-types apps/patcher/scripts/audit.ts
# expected:  120/120 covered, 0 fatals/errors
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

## Limitations / out of scope

Only items genuinely outside what the unworklet primitive surface and a single-page Vue app can carry:

- **No `groove~` / `play~` sample player.** Sample upload would require a `message<{data: f32[]}>` round-trip from the main thread to the worklet, plus a UI for file selection. The plumbing is feasible but wasn't wired in this round; document and defer.
- **No persistence beyond JSON copy/paste** — the user can clipboard a patch but there's no project file format yet.
- **No undo/redo.** Browser back-button-style state isn't wired.
- **WebMIDI on Safari.** Browsers without `requestMIDIAccess` show a notice rather than crashing. Chrome, Edge, and Chromium-based browsers work.
- **No real-time peer collaboration**, no native `.maxpat` import, no OSC. Out of scope by design.

## Files at a glance

```
apps/patcher/
├── package.json                # @vue-flow/core + @unworklet/* + monaco-editor
├── vite.config.ts              # COOP/COEP, port 5174
├── index.html
├── src/
│   ├── main.ts                 # Monaco worker registration + boot
│   ├── App.vue                 # toolbar (mic/MIDI/play/meter), breadcrumb, canvas, inspector
│   ├── style.css
│   ├── types.ts                # Patch, NodeDef, BuildCtx, ParamSpec, MidiSpec, Cord
│   ├── compiler/
│   │   ├── compile.ts          # patchToProcessor — paramSpecs[], midi I/O routes, shared bus, feedback breaks
│   │   └── topo.ts             # topological sort over audio cords (with feedback-break support)
│   ├── runtime/
│   │   ├── AudioRuntime.ts     # createWasmNode + 50 ms crossfade + Web MIDI in/out + ensureMic/ensureMidi
│   │   └── runtime-singleton.ts # singleton AudioRuntime so visualization components can subscribe
│   ├── registry/               # 120 node defs grouped by category
│   │   ├── store.ts            # registry storage (avoids ESM TDZ)
│   │   ├── index.ts            # public surface + side-effect registration
│   │   ├── audio-osc.ts        # cycle~/saw~/tri~/rect~/pulse~/phasor~/noise~/pinknoise~
│   │   ├── audio-math.ts       # +~/-~/*~//~/%~/min~/max~/pow~ + abs~/neg~
│   │   ├── audio-trig.ts       # sin~/cos~/tan~/tanh~/exp~/log~/sqrt~/floor~/ceil~/round~
│   │   ├── audio-filters.ts    # onepole~/onepoleHP~/lores~/hires~/bandpass~/biquad~/comb~/allpass~
│   │   ├── audio-delays.ts     # delay~/tapin~/tapout~ (shared bus via attrs.bus)
│   │   ├── audio-envelopes.ts  # adsr~/curve~
│   │   ├── audio-dynamics.ts   # peakamp~/compand~/limit~
│   │   ├── audio-routing.ts    # selector~ (8-way)/gate~/mute~/pong~/matrix~/gain~
│   │   ├── audio-conv.ts       # mtof~/ftom~/dbtoa~/atodb~/mstosamps~/sampstoms~/clip~/scale~
│   │   ├── audio-sampling.ts   # sah~/count~/rate~
│   │   ├── audio-viz.ts        # scope~/meter~/spectroscope~/number~ (publish to main thread)
│   │   ├── audio-io.ts         # adc~/dac~
│   │   ├── control.ts          # +/-/*/// + comparisons + sel/route/t/pak/unpack/random/expr/scale/abs/min/max/gate
│   │   ├── control-time.ts     # metro/counter/line/bang/loadbang
│   │   ├── midi.ts             # notein/ctlin/pitchbend/midiin (in) + noteout/ctlout/midiout (out)
│   │   ├── ui.ts               # slider/vslider/dial/live.dial/live.slider/number-box/flonum/button/toggle/kslider (note+gate)/multislider/umenu/comment
│   │   ├── ui-function.ts      # function (breakpoint curve editor)
│   │   ├── gen.ts              # gen~ — inline-code defineSubgraph
│   │   └── patcher.ts          # patcher (subpatch) + inlet/outlet
│   ├── components/
│   │   ├── Canvas.vue          # Vue Flow integration + node-palette + descend forwarding
│   │   ├── InspectorPanel.vue
│   │   └── nodes/              # per-type renderers
│   │       ├── AudioNodeView.vue
│   │       ├── SliderView.vue, VSliderView.vue, DialView.vue
│   │       ├── LiveDialView.vue, LiveSliderView.vue
│   │       ├── NumberBoxView.vue, ButtonView.vue, ToggleView.vue
│   │       ├── KsliderView.vue (multi-paramSpec note+gate)
│   │       ├── MultisliderView.vue, UMenuView.vue, CommentView.vue
│   │       ├── ScopeView.vue (real oscilloscope canvas)
│   │       ├── MeterView.vue (real VU + peak hold)
│   │       ├── SpectroscopeView.vue (main-thread FFT)
│   │       ├── NumberView.vue (live numeric readout)
│   │       ├── FunctionView.vue (drag-to-edit breakpoint curve)
│   │       ├── GenView.vue (Monaco editor + GEN_DTS for IntelliSense)
│   │       ├── gen-monaco-types.ts (type declarations injected into Monaco)
│   │       └── PatcherView.vue (double-click to descend into subpatch)
│   └── examples/               # 25 .json patches loaded via import.meta.glob
└── scripts/
    ├── smoke.ts                # headless playwright: 25/25 examples → audio
    ├── smoke-debug.ts          # single-example deep-error capture
    ├── audit.ts                # coverage matrix + structural assertions
    ├── coverage-matrix.json    # generated by audit.ts: type → [example files]
    └── list-types.ts           # dev-server probe: dump runtime registry
```
