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
result.events;       // Array<{ name, payload, atSample }>   events the processor emitted (= name は declaration の `name`、 payload は online で `.events.<name>.on(handler)` の handler に 渡 さ れ る 値 と 同 形、 atSample は block-local sample offset)
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

`renderOffline` config に `backend?: 'js' | 'wasm'` field を 持 つ:

- **`'js'` (default)** — pure-JS interpreter of the captured AST DAG。 WASM toolchain 不 要 で test / CI で 安 定。
- **`'wasm'`** — WASM backend、 production と 同 一 emission を offline で 走 ら せ る path。

1 回 の `renderOffline` 呼 び 出 し は 1 backend だ け を 走 ら せ る (= config + 戻 り 値 が 1 path で 単 純)。 pure-JS と WASM の cross-validation は `@unworklet/test` 側 の matcher (= `expectBitExactAcrossBackends(processor, config, { tolerance })`) に 別 出 し し、 内 部 で `renderOffline` を 2 回 呼 ん で 比 較 す る 形 (= `06-testing.md` §2)。 Q17 polynomial approximation が 両 backend で 共 通 実 装 の た め、 documented FP diff は 不 在 = `tolerance` default = `0` で acceptance B2 が pass す る。

## 4. Relationship to other packages

- `@unworklet/test` (= `06-testing.md`) builds matchers on top of `renderOffline`.
- `@unworklet/vite-plugin` (= `07-vite-plugin.md`) emits the compiled processor that `renderOffline` consumes; the `?worklet` import resolves to a shape the offline runner can also load. **Online と offline は 同 一 artifact set を 共 有** = vite-plugin が 1 度 build し た `.graph.json` / `.memory.json` / `.schema-hash.json` (= `07-vite-plugin.md` §6.3) を offline runner が internal API 経 由 で 直 接 load、 同 一 `schemaHash` を 提 示 す る (= Q5-e で 担 保)。 これ に よ り offline 側 で 走 ら せ た blob (= `result.state`) を online `node.restore(blob)` に 渡 し て も schema mismatch reject が 起 こ ら な い (= canonical Ex 7 migration chain test の cross-runtime path)。
- `@unworklet/core`'s client-side surface (= `05-client.md`) is the **online** counterpart: same processor, different runtime path. The snapshot format (Q5) is shared, so a `renderOffline` result's `state` blob can be passed to `node.restore(state)` after `createNode` to continue an offline-prepared session online (Q57; the two-step pattern is the v1.0.0 canonical form, see `05-client.md` §1).
