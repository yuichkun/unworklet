<p align="center">
  <img src="./assets/unworklet-logo-chain.svg" alt="unworklet" width="200" />
  <br />
  <img src="./assets/unworklet-logo-text.svg" alt="unworklet" width="240" />
</p>

<p align="center">
  <b>Realtime-safe DSP in plain TypeScript — typed primitives compiled to<br />
  WebAssembly for any audio thread: browser, server, or microcontroller.</b>
</p>

---

The audio thread is unforgiving: one stray allocation, a GC pause, or a botched
WASM linear-memory access and you get an audible glitch. unworklet makes that
impossible by construction.

You compose a processor from small, typed, reusable primitives in plain
TypeScript — audio, params, state, events, MIDI. The compiler proves it's
allocation-free, GC-free, and bounded **before it ever runs**, then emits the
WebAssembly, the `AudioWorkletProcessor` glue, and a typed main-thread node. No
hand-written processor, no `SharedArrayBuffer` wrangling, no linear-memory
bookkeeping.

The primitives snap together like Lego: build an effect, a synth, a MIDI
device — whatever you need. Test it headless in Node / Bun / Deno against the
exact WASM you ship, and X-ray the running audio thread live with zero-config
DevTools.

## Quick start

```bash
npm install @unworklet/core
npm install -D @unworklet/unplugin @unworklet/lang   # ?worklet loader + .uwk.ts editor support
```

```ts
// vite.config.ts
import unworklet from "@unworklet/unplugin";

export default { plugins: [unworklet()] };
```

Add one line to your `tsconfig.json`. The plugin generates a `.unworklet/tsconfig.json`
that wires up the main-thread types **and** the `.uwk.ts` editor checker, so
`node.params.<name>` (and `state` / `events` / `midi` / `inputs` / `outputs`) are
typed and the sugar type-checks with no `@ts-nocheck` — no `vite-env.d.ts` needed:

```jsonc
// tsconfig.json
{ "extends": "./.unworklet/tsconfig.json" }
```

The plugin writes `.unworklet/` (the tsconfig above plus a `worklets.d.ts` carrying
your processors' types) on `vite dev` / `vite build`; add `.unworklet/` to
`.gitignore` (a generated artifact, like Nuxt's `.nuxt/`). Adding processors only
regrows `worklets.d.ts` — you never touch your tsconfig again. Don't put your own
`include` on this tsconfig: `extends` doesn't merge `include`, so the generated one
must own it (need your own? use the manual setup below).

In VS Code, run **“TypeScript: Select TypeScript Version → Use Workspace
Version”** (the editor plugin loads only under the workspace TypeScript). For
build / CI, `@unworklet/lang` ships `unworklet-tsc`, a drop-in `tsc` that checks
`.uwk.ts` too.

<details>
<summary>Can’t extend (an existing tsconfig you can’t restructure)?</summary>

Write the same three settings into your own `tsconfig.json` directly — still no
`vite-env.d.ts`:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "types": ["@unworklet/unplugin/client"],
    "plugins": [{ "name": "@unworklet/lang/typescript-plugin" }],
  },
  "include": ["src", ".unworklet/worklets.d.ts"],
}
```

List `.unworklet/worklets.d.ts` explicitly in `include` — a `**/*` glob skips the
dot-folder. If this is the first `types` entry in your config, also list the type
packages you already rely on (e.g. `"node"`), since `types` disables automatic
`@types` loading.

</details>

A processor is a `.uwk.ts` file — write the DSP as plain expressions and
unworklet lowers it to the core primitives, compiles it to WASM, and proves it's
realtime-safe:

```ts
// distortion.uwk.ts — soft-clip distortion, compiled to a WASM AudioWorklet
const input = audioInput({ channels: 2, name: "main" });
const out = audioOutput({ channels: 2, name: "main" });
const drive = param.f32({ default: 4, min: 1, max: 20, automationRate: "a-rate" }).named();

process(() => {
  forSample((i) => {
    const l = input.left[i] * drive[i];
    const r = input.right[i] * drive[i];
    out.left[i] = l > 1 ? 1 : l < -1 ? -1 : l; // soft clip
    out.right[i] = r > 1 ? 1 : r < -1 ? -1 : r;
  });
});
```

```ts
// main.ts — you get back a typed node
import { createNode } from "@unworklet/core";
import distortion from "./distortion.uwk.ts?worklet"; // the ?worklet query is required

const ctx = new AudioContext();
const node = await createNode(ctx, distortion);

// an unworklet node is a normal AudioNode — feed it anything, route it anywhere:
const osc = new OscillatorNode(ctx, { frequency: 110 });
osc.connect(node.inputs.main);
node.outputs.main.connect(ctx.destination);
node.params.drive.value = 8; // the AudioParam, fully typed
osc.start();
```

Browsers start an `AudioContext` only after a user gesture, so call
`ctx.resume()` from a click handler to actually hear it.

Prefer explicit method calls over operator sugar? Write the same processor as a
plain `.processor.ts` with the core API (`input.left.at(i).mul(drive.at(i))`) —
the sugar is opt-in and lowers to exactly that.

## What you can build

The primitives — `audioInput` / `param` / `state` / `state.buffer` / `event` /
`event.midi`, the math ops, `forSample`, and reusable `defineSubgraph` blocks —
compose into anything: effects, synths, samplers, MIDI processors, sysex
bridges. MIDI is first-class and sample-accurate, so a processor can _receive_
notes and synthesize, or _emit_ notes like an arpeggiator.

Here's a monophonic synth driven by Web MIDI — it receives `noteOn` / `noteOff`
on the audio thread and oscillates:

```ts
// synth.uwk.ts — a monophonic MIDI sine voice
const out = audioOutput({ channels: 1, name: "main" });
const keys = event.midi({ from: "main", name: "keys" });

const hz = state.f32(440).named();
const gate = state.f32(0).named();
const phase = state.f32(0).named();

process(() => {
  keys.onEvent("noteOn", ({ note }) => {
    hz.write(exp(f32(note - 69) * (Math.LN2 / 12)) * 440); // MIDI note → Hz
    gate.write(1);
  });
  keys.onEvent("noteOff", () => gate.write(0));

  forSample((i) => {
    phase.write((phase + hz / 48000) % 1); // advance the oscillator
    out.ch(0)[i] = sin(phase * (Math.PI * 2)) * gate * 0.2;
  });
});
```

```ts
// wire it to a Web MIDI input — no app code on the audio thread
import synth from "./synth.uwk.ts?worklet";

const node = await createNode(ctx, synth);
node.outputs.main.connect(ctx.destination);

const midi = await navigator.requestMIDIAccess();
node.midi.keys.connectFromWebMIDI([...midi.inputs.values()][0]);
```

Ten worked examples — EQ, lookahead limiter, granular sampler, arpeggiator,
convolution reverb with state migration, polyphonic synth, sysex bridge, a live
coding REPL — live in [`docs/12-canonical-examples.md`](./docs/12-canonical-examples.md).

## Realtime-safe by construction

Writing real DSP for an `AudioWorklet` is a trap for a JavaScript developer.
Allocation is invisible (a `[]`, a closure — the GC does the rest), but on the
audio thread it causes dropouts. Sharing state across threads means
`SharedArrayBuffer` + `Atomics` + COOP/COEP headers. Reaching for WASM to go
faster means managing linear-memory offsets and lifetimes by hand. And you can't
even `console.log` to debug — that isn't realtime-safe either.

unworklet removes the whole class of problem. Because your TypeScript runs only
at **build time** to capture the graph, the audio thread runs nothing but the
emitted WASM — and the compiler statically guarantees every shipped `process`
path is:

- **allocation-free** — all `state`, buffers, and ringbuffers are pre-sized at
  compile time; `memory.grow` is never emitted.
- **bounded** — every loop has a build-time-known iteration count; there is no
  unbounded-loop primitive in the surface.
- **non-throwing & non-blocking** — no exception, no synchronous main-thread
  wait, ever reaches the audio thread.

If it compiles, those bugs are gone. The framework owns the `SharedArrayBuffer`
transport, the linear-memory layout, and the worklet/main marshalling — you
write one TypeScript file.

## Render & test — no browser needed

The emitted WASM runs under any host JS runtime, so you can render and test a
processor headlessly. `renderOffline` runs the **exact binary you ship** — tests
are real, deterministic, and bit-exact, not a simulation.

```ts
import { renderOffline, encodeWav } from "@unworklet/offline";
import distortion from "./distortion.uwk.ts?worklet";

const r = await renderOffline(distortion, {
  sampleRate: 48000,
  duration: 2,
  inputs: { main: [left, right] },
  params: { drive: [8] },
});

await Bun.write("out.wav", encodeWav(r.outputs.main, r.sampleRate));
```

`@unworklet/test` adds Vitest matchers on top — audio, events, MIDI, and state:

```ts
import { renderOffline } from "@unworklet/offline";
import { sine, expectNoNaN, expectStable } from "@unworklet/test";
import distortion from "./distortion.uwk.ts?worklet";

const r = await renderOffline(distortion, {
  sampleRate: 48000,
  duration: 0.5,
  inputs: { main: [sine({ freqHz: 220, durationSamples: 24000, sampleRate: 48000 })] },
  params: { drive: [8] },
});
expectNoNaN(r);
expectStable(r); // finite, no runaway DC / clipping
```

## DevTools

The audio thread is normally a black box. unworklet's Vite DevTools panel X-rays
it. Every value it shows is read bit-exact from WASM memory, so the inspector
never lies; in a production build the plugin compiles to nothing and your app is
byte-for-byte unchanged.

- **Live state** — every `state` / buffer slot, live from WASM memory (waveform / bar / list per type)
- **Audio graph** — the running `AudioContext` topology
- **Signals & performance** — per-output waveform / spectrum + per-quantum latency
- **MIDI** — event activity + a virtual keyboard to inject notes

<table>
  <tr>
    <td width="50%"><img src="./screenshots/live_state.png" alt="DevTools — Live state" /><br /><sub><b>Live state</b> — every <code>state</code> / buffer slot, live from WASM memory</sub></td>
    <td width="50%"><img src="./screenshots/audio_graph.png" alt="DevTools — Audio graph" /><br /><sub><b>Audio graph</b> — the running <code>AudioContext</code> topology</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="./screenshots/signals.png" alt="DevTools — Signals & performance" /><br /><sub><b>Signals &amp; performance</b> — per-output waveform / spectrum + latency</sub></td>
    <td width="50%"><img src="./screenshots/midi_view.png" alt="DevTools — MIDI" /><br /><sub><b>MIDI</b> — event log + a virtual keyboard to inject notes</sub></td>
  </tr>
</table>

### Enabling it

The panel is a dock inside the [Vite DevTools](https://devtools.vite.dev) overlay,
so you install that host (plus its client kit, which the panel's page bridge
imports) and add it to your config. The unworklet plugin itself needs no extra
config — it auto-docks once the host is present.

```sh
npm install -D @vitejs/devtools @vitejs/devtools-kit
```

```ts
// vite.config.ts
import { DevTools } from "@vitejs/devtools";
import unworklet from "@unworklet/unplugin";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [
    unworklet(),
    // Dev only — the DevTools host runs a long-lived server, pointless in a build
    // and it would keep the test runner from exiting.
    ...(command === "serve" ? [DevTools({ builtinDevTools: false })] : []),
  ],
}));
```

Run your dev server, open the Vite DevTools overlay, and pick the **unworklet** dock.

Two gotchas worth knowing up front:

- **Install `@vitejs/devtools-kit` as a direct dependency too**, matching the
  version `@unworklet/unplugin` builds against (`0.2.x` at the time of writing).
  The panel's page bridge imports `@vitejs/devtools-kit/client`, which must resolve
  from your app — a transitive copy is not enough.
- **Cross-origin isolation.** The plugin makes the dev server cross-origin
  isolated by default (COOP `same-origin` + COEP `credentialless`) so
  `SharedArrayBuffer` works with no config — `credentialless` rather than
  `require-corp`, which would block the DevTools iframe (`/__unworklet/`). If
  isolation conflicts with a cross-origin resource or the DevTools panel, opt out
  with `unworklet({ crossOriginIsolation: false })`; unworklet then uses the
  postMessage transport in dev. Production headers remain your server's job.

The panels can't be deployed as a static demo: the host is a dev-time server, so
clone the repo and start an example locally to try them live.

## Packages

| package                                                | what it does                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [`@unworklet/core`](./packages/core/README.md)         | The DSL, the WASM compiler, the worklet runtime, and the typed main-thread node.   |
| [`@unworklet/unplugin`](./packages/unplugin/README.md) | Loads `.processor.ts` / `.uwk.ts` via `?worklet`; ships the DevTools panel.        |
| [`@unworklet/lang`](./packages/lang/README.md)         | The `.uwk.ts` authoring sugar (infix operators, index access) that lowers to core. |
| [`@unworklet/offline`](./packages/offline/README.md)   | Render a processor to PCM headlessly in Node / Bun / Deno.                         |
| [`@unworklet/test`](./packages/test/README.md)         | Audio / event / MIDI / state assertions and signal generators for Vitest.          |

## Docs

- **Start here:** [`docs/00-foundations.md`](./docs/00-foundations.md) — vocabulary, the type system, the realtime-safety invariants.
- **The DSL:** [`docs/01-dsl.md`](./docs/01-dsl.md) · **MIDI:** [`docs/11-midi.md`](./docs/11-midi.md) · **Offline render:** [`docs/13-offline-render.md`](./docs/13-offline-render.md) · **Testing:** [`docs/06-testing.md`](./docs/06-testing.md).
- **Worked examples:** [`docs/12-canonical-examples.md`](./docs/12-canonical-examples.md).
- **For AI agents / LLMs:** [`llms.txt`](./llms.txt) carries the exact call forms.

## Contributing

A pnpm monorepo driven through the [Vite+](https://viteplus.dev) CLI (`vp`):

```bash
vp install        # install dependencies
vp check          # lint + format + typecheck (vp check --fix to auto-fix)
vp test run       # vitest (node-side + browser SAB / postMessage)
```

`core` and `unplugin` form a build cycle, so packages build in an explicit
order rather than `vp run -r build`:

```bash
vp run --filter @unworklet/lang build && \
vp run --filter @unworklet/unplugin build && \
vp run --filter @unworklet/core build && \
vp run --filter @unworklet/offline build && \
vp run --filter @unworklet/test build
```

Conventions and design rationale: [`AGENTS.md`](./AGENTS.md).

License: MIT.
