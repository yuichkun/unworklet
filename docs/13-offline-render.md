# 13 — Offline render (`@unworklet/offline`)

Pure-JS execution of an unworklet processor: no browser, no `AudioContext`, no audio thread. Takes a compiled processor + input PCM (Float32Array) + parameter automation + scheduled messages/events, runs it, returns output PCM (Float32Array). Authoritative rationale: `decisions-log.md` Q23+Q24+Q25.

## Status

skeleton (scope-level shape fixed per Q23 + Q24 + Q25; per-section detail filled incrementally)

## 1. Use cases

The package is intentionally a single primitive — `renderOffline` — applicable across the following first-class scenarios:

| Use case | Description |
|---|---|
| Server-side render | Run a processor in Node.js to generate PCM, then encode to wav / mp3 / opus / etc. with a separate library. |
| Batch processing | Iterate over many configurations or input files; produce PCM arrays for each. |
| Preset preview UI | A web app renders a short PCM preview of a preset without spinning up an `AudioContext` (e.g. for a waveform thumbnail). |
| Test | `@unworklet/test` (= `06-testing.md`) wraps `renderOffline` in vitest matchers (`expectAudioMatches`, `expectNoNaN`, etc.) for deterministic CI runs. |

The package does **not** wrap any I/O concern (no wav writer, no http server, no mp3 encoder, no UI). Output is in-memory `Float32Array`; the consumer composes file I/O / encoders / UI separately. Keeping the surface a pure function maximizes reuse across the four use cases above.

## 2. API

```typescript
import { renderOffline } from '@unworklet/offline';
import MyProcessor from './my.processor.ts?worklet';

const result = await renderOffline(MyProcessor, {
  sampleRate: 48000,
  duration:   1.0,                                              // seconds
  inputs:  { main: [inputLeftPcm, inputRightPcm] },             // audioInput name → Float32Array[] (one entry per channel; mono = length-1 array)
  params:  { cutoff: [1000, 1000, /* per-sample or per-block */ ] },
  messages: [{ name: 'loadPattern', payload: { /* ... */ } }],   // main → worklet messages, delivered before render
  events:   [{ name: 'noteOn', payload: { /* ... */ }, atSample: 100 }],
});

result.outputs.main; // Float32Array[]   per-channel PCM (key = `audioOutput` declared `name`; canonical convention is `'main'`. Length = ceil(duration × sampleRate / 128) × 128, see §2.1.)
result.events;       // Array<{ name, payload, atSample }>   events the processor emitted
result.state;        // Uint8Array       snapshot blob (Q5 format) at end-of-render
```

### 2.1 Duration の 端 数 処 理

`duration × sampleRate` が `SAMPLES_PER_BLOCK` (= 128) で 割 り 切 れ な い 場 合、 `renderOffline` は 内 部 で `ceil(duration × sampleRate / 128) × 128` sample ま で 切 り 上 げ て render し、 余 剰 sample を silence で pad す る。 入 力 PCM (= `inputs.<name>`) も 同 長 さ ま で silence auto-pad (= user 側 で pre-pad 不 要)。 戻 り 値 `result.outputs.<name>` の length は 切 り 上 げ 後 の sample 数 = block boundary を 跨 が ず reference output と bit-exact 比 較 が 可 能。 ち ょう ど `duration × sampleRate` sample だ け 必 要 な consumer は `pcm.subarray(0, Math.floor(duration * sampleRate))` で 自 力 truncate (= framework は user 制 約 ゼ ロ で 一 意 path を 採 る)。

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

## 3. Backend choice

<!-- - Default: pure-JS interpreter of the captured AST DAG (= no WASM dependency at offline-render time).
     - Optional: WASM backend, cross-validated against the pure-JS interpreter for bit-identity (= Q17 polynomial approximation is shared between the two backends; documented FP diff is "none"、 全 演 算 が bit-exact)。
     - Backend selection: opt-in flag on `renderOffline` config; default is pure-JS for the test/CI case where WASM toolchain availability is variable. -->

## 4. Relationship to other packages

- `@unworklet/test` (= `06-testing.md`) builds matchers on top of `renderOffline`.
- `@unworklet/vite-plugin` (= `07-vite-plugin.md`) emits the compiled processor that `renderOffline` consumes; the `?worklet` import resolves to a shape the offline runner can also load.
- `@unworklet/core`'s client-side surface (= `05-client.md`) is the **online** counterpart: same processor, different runtime path. The snapshot format (Q5) is shared, so a `renderOffline` result's `state` blob can be passed to `node.restore(state)` after `createNode` to continue an offline-prepared session online (Q57; the two-step pattern is the v1.0.0 canonical form, see `05-client.md` §1).
