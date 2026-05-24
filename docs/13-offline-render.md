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

こ れ ら 全 use case で Vite project は 不 要 = 純 Node / Bun / Deno script で `@unworklet/core` (= `defineProcessor(...)` の 戻 り 値 を 提 供) + `@unworklet/offline` (= `renderOffline` を 提 供) を import す る だ け で 動 く。 build pipeline / bundler / browser host を 要 求 し な い (= compile も driver も `renderOffline` 内 で 自 己 完 結、 §3 + §4 参 照)。

## 2. API

```typescript
import { renderOffline } from "@unworklet/offline";
import { myProcessor } from "./my-processor"; // `defineProcessor(...)` の 戻 り 値 (= `CompiledProcessor<C>`) を そ の ま ま import。 vite-plugin 経 由 の `?worklet` import path も 並 列 で OK (= `.processor.ts` 内 で `defineProcessor(...)` を 名 前 付 き export し て お け ば either path で 同 一 artifact を 受 け 取 れ る)。

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
  ], // main → worklet messages、 atQuantum で 配 達 タ イ ミ ン グ を block 番 号 で 指 定 (省 略 = 0 = render 開 始 時)。 online で の Q38-a 「各 render quantum 開 始 時 に drain」 と 直 接 zip。
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
result.events; // Array<{ name, payload, atSample }>   events the processor emitted (= name は declaration の `name`、 payload は online で `.events.<name>.on(handler)` の handler に 渡 さ れ る 値 と 同 形、 atSample は block-local sample offset)
result.state; // Uint8Array       snapshot blob (Q5 format) at end-of-render
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

## 3. Execution model

`renderOffline` は host JS の WebAssembly runtime (= Node.js / Bun / Deno 等 の `WebAssembly.instantiate` を 持 つ environment) で processor の WASM binary を そ の ま ま instantiate し、 host JS 上 で render quantum (= 128 sample) 単 位 に WASM `process()` を 呼 び 出 し て output PCM を 集 め る。 `AudioContext` も audio thread も 介 在 し な い (= browser 不 要、 server-side で も そ の ま ま 走 る)。 production の online 経 路 (= `05-client.md`) が `AudioWorkletNode` 越 し に 走 ら せ る の と 同 一 の WASM binary を、 同 一 の per-quantum entry point で driver す る path = byte-identical な emission を offline で 再 現 す る (= Q17 polynomial approximation は WASM 内 で inline emit、 host JS 側 に 計 算 が 漏 れ な い)。

compile 自 体 も `renderOffline` 内 で 完 結 す る (= `@unworklet/core` の `compile` 関 数 を call し て、 引 数 で 受 け 取 っ た processor (= `defineProcessor(...)` の 戻 り 値) の graph capture + WASM emit を 走 ら せ る)。 Vite 経 由 で 事 前 build 済 の WASM binary を 渡 す 必 要 ナ シ = 純 Node / Bun / Deno script が `defineProcessor(...)` の 戻 り 値 を そ の ま ま `renderOffline` に 渡 せ ば、 graph capture → WASM emit → instantiate → driver が 1 call 内 で 順 に 走 る。 同 一 processor 入 力 + 同 一 compile path = 同 一 WASM binary が emit さ れ る た め、 online (= vite-plugin が build 時 に 同 じ `compile` を call し て 出 し た binary) と byte-identical な artifact が 得 ら れ る (= §4 参 照)。

backend 選 択 肢 は な い (= `renderOffline` config に backend 切 替 field は 持 た な い)。 config (= `sampleRate`, `duration`, `inputs`, `params`, `messages`, `events`) と processor 入 力 が 同 一 で あ れ ば `renderOffline` の 戻 り 値 は host JS environment を 跨 い で bit-exact = test deterministic。 acceptance B2 (= `06-testing.md` §2) は 単 一 binary の 1 path 走 行 で 自 然 と pass す る (= 比 較 対 象 が な い = tolerance 概 念 不 在)。

## 4. Relationship to other packages

- `@unworklet/test` (= `06-testing.md`) builds matchers on top of `renderOffline`.
- `@unworklet/core` (= `05-client.md` + `defineProcessor` + 公 開 `compile` 関 数) は offline runner が 依 存 す る 唯 一 の `@unworklet/` package (= `@unworklet/offline` peer dep)。 `renderOffline` は 引 数 で 受 け 取 っ た processor (= `defineProcessor(...)` の 戻 り 値) を 内 部 で `@unworklet/core` の `compile` 経 由 で WASM 化 + host JS の WebAssembly runtime で instantiate + 駆 動 す る (= §3)。 Vite project に 依 存 し な い 純 Node / Bun / Deno / browser host script で 動 く (= build pipeline / bundler を 要 求 し な い)。
- `@unworklet/vite-plugin` (= `07-vite-plugin.md`) は `@unworklet/core` の `compile` を build pipeline で call す る 1 consumer の 1 つ で あ り、 offline runner は そ れ と は 独 立 に 自 前 で 同 じ `compile` を call す る (= offline は vite-plugin に 依 存 し な い)。 online runtime (= browser AudioWorkletGlobalScope) と offline runtime (= host JS WebAssembly runtime) が **同 一 compile path** (= `@unworklet/core` の `compile` 関 数) を 通 る た め、 emit さ れ る WASM binary + metadata artifact (= `.graph.json` / `.memory.json` / `.schema-hash.json` 相 当) が byte-identical = `schemaHash` も 一 致 す る (= Q5-e で 担 保)。 こ れ に よ り offline 側 で 走 ら せ た blob (= `result.state`) を online `node.restore(blob)` に 渡 し て も schema mismatch reject が 起 こ ら な い (= canonical Ex 7 migration chain test の cross-runtime path)。
- `@unworklet/core`'s client-side surface (= `05-client.md`) is the **online** counterpart: same processor, different runtime path. The snapshot format (Q5) is shared, so a `renderOffline` result's `state` blob can be passed to `node.restore(state)` after `createNode` to continue an offline-prepared session online (Q57; the two-step pattern is the v1.0.0 canonical form, see `05-client.md` §1).
