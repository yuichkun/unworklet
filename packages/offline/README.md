# @unworklet/offline

Render an unworklet processor to PCM with no browser — pure JS over
`WebAssembly.instantiate`, in Node / Bun / Deno. Feed it audio, param
automation, MIDI, and main→worklet events; get back the output samples, the
events the processor emitted, and the end-of-render snapshot blob. Ideal for
tests, golden-file regressions, and offline bounce.

```bash
npm install @unworklet/offline @unworklet/core
```

## Usage

```ts
import { writeFileSync } from "node:fs";

import { renderOffline, encodeWav } from "@unworklet/offline";
import { myProcessor } from "./processor.ts"; // a defineProcessor(...) export

const result = await renderOffline(myProcessor, {
  sampleRate: 48000,
  duration: 2.0, // seconds (rounded up to a 128-sample block boundary)
  inputs: { main: [leftChannel, rightChannel] }, // per audioInput({ name }) port
  params: { gain: [0.5, 0.5, 0.8] }, // per param.named() slot (automation curve)
});

result.outputs.main; // Float32Array[] per channel
result.events; // worklet → main events (event({to:'main'}) + outbound MIDI), with atSample
result.state; // snapshot blob captured at the end of the render

writeFileSync("out.wav", encodeWav(result.outputs.main, result.sampleRate)); // Bun/Deno: use their own write API
```

In a Node + TypeScript project, install Node's types and let `tsc` import the
`.ts` processor source directly:

```bash
npm install -D @types/node
```

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "module": "nodenext",
    "types": ["node"],
    "allowImportingTsExtensions": true,
    "noEmit": true,
  },
}
```

Run it with any TS runner — `tsx`, or `node` ≥ 22.6 (which strips types natively).

## `RenderOfflineConfig`

| field        | meaning                                                                      |
| ------------ | ---------------------------------------------------------------------------- |
| `sampleRate` | render sample rate                                                           |
| `duration`   | seconds; rounded up to the next 128-sample block                             |
| `inputs?`    | `{ [audioInputName]: Float32Array[] }` per-channel input                     |
| `params?`    | `{ [paramName]: number[] }` automation (1 value = constant)                  |
| `messages?`  | `[{ name, payload, atQuantum? }]` — main→worklet `event({from:'main'})`      |
| `events?`    | `[{ name, payload, atSample }]` — inbound MIDI (`event.midi({from:'main'})`) |
| `profile?`   | snapshot profile to capture (default: union of all persistent)               |
| `restore?`   | initial state blob (migrated to the current schema before rendering)         |

## Also exported

- `encodeWav(channels, sampleRate, opts?)` / `decodeWav(bytes)` — 8/16/24/32-bit
  integer and 32f/64 float PCM WAV (`opts.bitDepth`, default `"32f"`).

## Related packages

- `@unworklet/core` — define the processor you render here (`defineProcessor`, the DSL primitives).
- `@unworklet/test` — Vitest matchers built on top of `renderOffline`.
- `@unworklet/lang` — write processors in `.uwk.ts` sugar.
- `@unworklet/vite-plugin` — load processors in the browser via `?worklet`, plus DevTools.

License: MIT.
