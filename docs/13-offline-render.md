# 13 — Offline render (`@unworklet/offline`)

Pure-JS execution of an unworklet processor: no browser, no `AudioContext`, no audio thread. Takes a compiled processor + input PCM (Float32Array) + parameter automation + scheduled messages/events, runs it, returns output PCM (Float32Array). Authoritative rationale: `decisions-log.md` Q23+Q24+Q25.

## Status

skeleton (scope-level shape fixed per Q23 + Q24 + Q25; per-section detail filled incrementally)

## 1. Use cases

The package is intentionally a single primitive — `renderOffline` — applicable across the following first-class scenarios:

| Use case           | Description                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-side render | Run a processor in Node.js to generate PCM, then encode to wav / mp3 / opus / etc. with a separate library.                                           |
| Batch processing   | Iterate over many configurations or input files; produce PCM arrays for each.                                                                         |
| Preset preview UI  | A web app renders a short PCM preview of a preset without spinning up an `AudioContext` (e.g. for a waveform thumbnail).                              |
| Test               | `@unworklet/test` (= `06-testing.md`) wraps `renderOffline` in vitest matchers (`expectAudioMatches`, `expectNoNaN`, etc.) for deterministic CI runs. |

The package does **not** wrap any I/O concern (no wav writer, no http server, no mp3 encoder, no UI). Output is in-memory `Float32Array`; the consumer composes file I/O / encoders / UI separately. Keeping the surface a pure function maximizes reuse across the four use cases above.

None of the above use cases require a Vite project. A plain Node / Bun / Deno script that imports `@unworklet/core` (which provides the `defineProcessor(...)` return value) and `@unworklet/offline` (which provides `renderOffline`) is sufficient. No build pipeline, bundler, or browser host is required — compilation and the render driver are both self-contained inside `renderOffline` (see §3 and §4).

## 2. API

```typescript
import { renderOffline } from "@unworklet/offline";
import { myProcessor } from "./my-processor"; // Import the return value of `defineProcessor(...)` (i.e. `CompiledProcessor<C>`) directly. The `?worklet` import path via vite-plugin also works in parallel — as long as `defineProcessor(...)` is a named export inside the `.processor.ts` file, either import path yields the same artifact.

const result = await renderOffline(myProcessor, {
  sampleRate: 48000,
  duration: 1.0, // seconds
  inputs: { main: [inputLeftPcm, inputRightPcm] }, // audioInput name → Float32Array[] (one entry per channel; mono = length-1 array)
  params: { cutoff: [1000, 1000 /* per-sample or per-block */] },
  messages: [
    {
      name: "loadPattern",
      payload: {
        /* ... */
      },
      atQuantum: 0,
    },
  ], // Main-to-worklet messages. `atQuantum` specifies the delivery timing as a block index (omitted = 0 = at the start of the render). Directly mirrors the Q38-a online behavior of draining the message queue at the start of each render quantum.
  events: [
    {
      name: "noteOn",
      payload: {
        /* ... */
      },
      atSample: 100,
    },
  ],
});

result.outputs.main; // Float32Array[]   per-channel PCM (key = `audioOutput` declared `name`; canonical convention is `'main'`. Length = ceil(duration × sampleRate / 128) × 128, see §2.1.)
result.events; // Array<{ name, payload, atSample }>   events emitted by the processor. `name` matches the declaration's `name`; `payload` has the same shape as the value passed to the `.events.<name>.on(handler)` callback in the online path; `atSample` is the block-local sample offset.
result.state; // Uint8Array       snapshot blob (Q5 format) at end-of-render
result.sampleRate; // number          the sample rate used for the render (carries `config.sampleRate` through as-is, enabling self-describing output for wav encoding, re-renders, and consumer automation)
```

### 2.1 Duration rounding

When `duration × sampleRate` is not evenly divisible by `SAMPLES_PER_BLOCK` (= 128), `renderOffline` internally rounds up to `ceil(duration × sampleRate / 128) × 128` samples and pads the surplus with silence. Input PCM (`inputs.<name>`) is also silence-padded to the same length automatically — no pre-padding is required on the caller's side. The length of `result.outputs.<name>` equals the rounded-up sample count, which means bit-exact comparisons against a reference output never straddle a block boundary. Consumers that need exactly `duration × sampleRate` samples can truncate with `pcm.subarray(0, Math.floor(duration * sampleRate))` — the framework takes the unambiguous path with no constraints imposed on the user.

<!-- TODO §2.x:
     - Full type signature with generics over processor declarations (output names, event types, message types).
     - Per-sample vs per-block parameter input shape rules (= Q18 length 1 / 128 / 0 normalization at the offline boundary).
     - Initial-state injection: follows the same 2-step pattern as online (= produce
       the `state` blob first via a prior `renderOffline` call or a saved `node.snapshot()`
       blob, then inject through a `restore`-style config field). The 1-step
       `config.initial: Uint8Array` shape is NOT part of v1.0.0 — that would
       collide with online `CreateNodeOptions.initial` (= param initial values,
       per Q57) and re-introduce the 1-step pattern Q57 retracted. Concrete
       offline `restore` field shape is impl-phase fill per Q61.
     - Snapshot profile selection: `config.profile?: string` selects which `'persistent'`
       profile the returned `result.state` blob covers (zips with online
       `node.snapshot({ profile })`, 05-client §2.6). Omitted = the union of every
       `'persistent'` profile (= same default as online `node.snapshot()` no-arg).
     - Determinism guarantee. -->

## 3. Execution model

`renderOffline` instantiates the processor's WASM binary directly in the host JavaScript WebAssembly runtime (any environment with `WebAssembly.instantiate`, such as Node.js, Bun, or Deno), then drives the WASM `process()` entry point in 128-sample render quanta on the host JS side, collecting the output PCM. No `AudioContext` and no audio thread are involved — no browser is required, and it runs identically server-side. The same WASM binary that the production online path (see `05-client.md`) drives through an `AudioWorkletNode` is driven here through the same per-quantum entry point, reproducing byte-identical emission offline. (Q17 polynomial approximations are inlined inside the WASM; no computation leaks to the host JS side.)

Compilation is also self-contained inside `renderOffline`: it calls `@unworklet/core`'s `compile` function on the processor passed as an argument (the return value of `defineProcessor(...)`), running graph capture and WASM emit internally. There is no need to supply a pre-built WASM binary via Vite. A plain Node / Bun / Deno script can pass the `defineProcessor(...)` return value directly to `renderOffline`, and graph capture → WASM emit → instantiate → driver all run sequentially within that single call. Because the same processor input and the same compile path always produce the same WASM binary, the resulting artifact is byte-identical to what the vite-plugin produces at build time (see §4).

There is no backend selection option — `renderOffline`'s config has no field for switching backends. Given identical config (`sampleRate`, `duration`, `inputs`, `params`, `messages`, `events`) and identical processor input, `renderOffline`'s return value is bit-exact across host JS environments, making it fully deterministic for tests. Acceptance criterion B2 (see `06-testing.md` §2) is satisfied naturally by a single binary on a single code path — there is no comparison target, so the concept of tolerance does not arise.

## 4. Relationship to other packages

- `@unworklet/test` (= `06-testing.md`) builds matchers on top of `renderOffline`.
- `@unworklet/core` (see `05-client.md`; provides `defineProcessor` and the public `compile` function) is the only `@unworklet/` package the offline runner depends on (peer dep of `@unworklet/offline`). `renderOffline` compiles the processor it receives (the return value of `defineProcessor(...)`) via `@unworklet/core`'s `compile`, instantiates the resulting WASM binary in the host JS WebAssembly runtime, and drives it (see §3). It works in plain Node / Bun / Deno / browser host scripts without a Vite project — no build pipeline or bundler is required.
- `@unworklet/vite-plugin` (see `07-vite-plugin.md`) is one consumer of `@unworklet/core`'s `compile` within a build pipeline. The offline runner independently calls that same `compile` function without depending on the vite-plugin. Because both the online runtime (browser `AudioWorkletGlobalScope`) and the offline runtime (host JS WebAssembly runtime) go through the **same compile path** (the `compile` function in `@unworklet/core`), the emitted WASM binary and metadata artifacts (equivalent to `.graph.json` / `.memory.json` / `.schema-hash.json`) are byte-identical, and `schemaHash` values match (guaranteed by Q5-e). As a result, a blob produced by `renderOffline` (`result.state`) can be passed to the online `node.restore(blob)` without triggering a schema-mismatch rejection (the cross-runtime path in the canonical Ex 7 migration chain test).
- `@unworklet/core`'s client-side surface (= `05-client.md`) is the **online** counterpart: same processor, different runtime path. The snapshot format (Q5) is shared, so a `renderOffline` result's `state` blob can be passed to `node.restore(state)` after `createNode` to continue an offline-prepared session online (Q57; the two-step pattern is the v1.0.0 canonical form, see `05-client.md` §1).
