# 10 — Roadmap

Milestone scoping for v1.0.0, with the smallest possible footprint of forward-looking commitments.

This doc is independent of the component docs and can be picked up at any time.

## Status

partial (§1 written at Q62; §2 implementation phases written; §3.1 mandatory deferred mitigations written; §3.2 placeholder)

## 1. v1.0.0 acceptance criteria

「v1.0.0 ship 可 能」 を impl AI agent が 1 意 判 定 で き る checklist。 1 項 目 で も 落 ち た ら ship 不 可、 全 項 目 OK で ship。 Q62 (`decisions-log.md`)。

### A. Build / compile

- **A1** — 公 開 4 package + 内 部 module の `vp build` 通 過 (= exit 0)。
- **A2** — canonical Ex 1〜8 の WASM emit 通 過 (= 各 Ex の `defineProcessor` body の graph capture + WASM 生 成 成 功)。
- **A3** — `vp check` (= tsgo typecheck + oxlint + oxfmt) 通 過 (= exit 0)。

### B. Functional

- **B1** — canonical Ex 1〜8 の 期 待 output が `@unworklet/offline` で 再 現 (= reference audio / event sequence と bit-exact)。

### C. Safety

- **C1** — realtime-safety invariants 5 件 (= no heap alloc / no unbounded loops / no throw / no blocking I/O / no GC、 `00-foundations.md` §5.1) を `00-foundations.md` §5.2 規 定 通 り の layered enforcement (= L1 / L2 / L3 / Emission / Runtime guard) で 検 出。 各 invariant に 対 す る 違 反 test を 仕 込 ん で 各 enforcement layer が 規 定 通 り に 弾 く こ と を 確 認。

### D. Browser matrix

- **D1** — browser smoke pass、 matrix = `Chromium × Firefox × Safari` × `{COOP/COEP cross-origin isolated, not isolated}` = 6 セ ル 全 て で canonical Ex 1〜3 が 起 動 + 出 音。

  **smoke test 仕 様**: `connectFromWebMIDI` (= Web MIDI 標 準 wrapper) は test 対 象 外 (= emission boundary 外 側、 consumer 責 任、 `08-deployment.md` §2 B1)。 全 browser セ ル で `node.midi.<name>.send(event)` source-agnostic injection (= `11-midi.md` §3) 経 由 で MIDI 動 作 を 統 一 検 証。

### E. Integrity

- **E1** — `open-questions.md` が 空 (= 全 質 問 が `decisions-log.md` に 移 さ れ て こ の file の 質 問 リ ス ト が 0 件 に な っ た 状 態)。

### F. Public surface integrity

- **F1** — `.d.ts` 公 開 surface が `decisions-log.md` Q1〜Q77 全 entry (Q28 は unassigned numbering artifact で 対 象 外) と 整 合 (= 各 ratify が 公 開 surface に 反 映)。

## 2. Implementation phases

v1.0.0 ship を target に 14 phase で 段階 構築。 各 phase = 数 conversation 単位 で 完結、 commit + diff review pause cadence。 各 phase 内 step の 詳細 計画 (= 触る file、 構築 順、 検証 方法) は phase 着手 時 に plan mode で 個別 fix、 ここ で は phase scope と 完了 条件 だけ declare。

phase 順 は dependency 軸 (= 後続 phase が 前 phase の 成果 物 に 依存) で 決まる。 「動く 単位 を 早く 出す」 軸 を 優先、 「foundation を 先 に 完璧 に」 軸 は 後 回し。

### 実装 invariant (HARD CONTRACT)

各 phase で の **minimal / vertical slice 実装 は 設計 上 OK** だ が、 以下 は **絶対 ナシ** (= `AGENTS.md` "Implementation invariant" と zip):

1. **docs 規定 と 乖離 し た ad hoc 実装** — 公開 API surface (= 公開 type / 引数 形 / 戻り値 形、 09-repo-structure.md §2.1 + §2.2 + 各 component doc 規定) は docs 規定 と zip。 phase 内 で 「とりあえず 違う 形 で 出して 後 で 直す」 は 不可。
2. **前方 互換性 ナシ 実装** — 後続 phase で 追加 さ れる surface (= declaration kind 追加 / new primitive / main side method 拡張 / messaging surface 拡張 等) と 衝突 する 設計 は 不可。 phase 内 で 実装 する 範囲 は 必ず 最終 アーキテクチャ 像 の **subset** で あり、 後続 phase で **superset** に 拡張 し て いく shape。

各 phase 着手 時、 触る surface に 関わる docs (= `00-foundations.md` / `01-dsl.md` / 各 component doc / `decisions-log.md` の 該当 Q entry) を 必ず 参照、 最終 像 の subset と し て 実装 す る。 「minimal = 動く だけ で OK」 と 「ad hoc = 後 で 大幅 rewrite」 は 違う = 前 者 は 許 容、 後 者 は phase 完了 条件 違 反 と し て retract 対 象。

skeleton 段階 (= Phase 2) で **公開 type は 最終 形 で declare、 中身 は stub 実装** (= `throw new Error('not implemented')` 等) で OK。 後続 phase は declared surface の 中身 を 順次 fill。 これ で 「全 公開 surface declared 済 + 一部 実装」 state を 後 戻り なし で 進める。

### Phase 1 — WASM emit 動作 確認

WASM emit pipeline の foundation phase。 binaryen (= WASM toolkit JS package、 IR を 組み立てて WASM binary を 吐く build-time library) を 使って、 host JS (= Node.js / Bun / Deno) で 最小 WASM module を build + 実行 + `.wat` (= WASM の text 形式、 人間 が 読める) 出力 を 段階 的 に 試す。

binaryen は v1.0.0 で の 確定 WASM emit path = 採用 是非 の 検討 phase で は ない。 この phase の 目的 = 「必要 opcode が binaryen IR API 経由 で 正しく emit され、 emit 済 WASM が host JS の `WebAssembly.instantiate()` で 走る」 を 段階 的 に 確認 + WASM 動作 (= memory model / function signature / instruction set) を 把握 する こと。

各 step で 「binaryen で 構築 → `.wat` 出力 → Node で `instantiate` + 実行 → output 確認」 の loop。 PoC は repo 内 専用 directory で 単発 完結 (= monorepo 構造 と は 独立、 後続 phase で 直接 import し ない)。 binaryen は `@unworklet/core` の dependency と し て 配置、 `@unworklet/core` か ら 公 開 さ れ る `compile` 関 数 (= Phase 3 で 露 出) の 内部 実装 に 限って 使用、 dynamic import で 静 的 path consumer の production runtime bundle から 除外 (= consumer の 出荷 bundle に は 含まれ ない、 09-repo-structure.md §2.4 と zip)。

完了 条件: 最小 WASM (= constant 出力 / passthrough / scalar 乗算 / runtime param 経由 乗算 / forSample loop 相当 の bounded loop) が binaryen 経由 で emit + Node で 動く こと が 順次 確認 済み。 各 step の `.wat` 出力 を 一緒 に 読 ん で WASM の 動作 が 把握 済 み の 状態 で Phase 2 に 進む。

### Phase 2 — Foundation: repo + 4 package skeleton

pnpm workspace + `vp` CLI gate + MIT license + TS 5.5+ + vitest 設定 (= 09-repo-structure.md §1 / §3 / §4 / §5 通り)。 公開 4 package + `/simd` subpath の 空 entry + dependency 線 (= 09-repo-structure.md §2.4 通り)。 各 package の `package.json` + `tsconfig.json` + `src/index.ts` (= 空 export) を 立てる。

完了 条件: `vp install` + `vp check` + `vp test` が 全 package で exit 0 + 4 package 間 の workspace ref が 正しく 解決 + **09-repo-structure.md §2.1 + §2.2 + 各 component doc 規定 の 公開 named exports / 公開 type を 全 declare 済 (= stub 実装 OK、 中身 は `throw new Error('not implemented')` 等)、 external consumer が TypeScript で 全 surface に 対して type check 通る state を 確立** (= 実装 invariant の 「公開 surface skeleton 先行 declare」 path)。

### Phase 3 — Vertical slice: stereo gain (meter なし) を `renderOffline` で 動かす

最小 vertical slice として canonical Ex 1 の meter cut 版 を end-to-end で 走らせる。 触る 範囲:

- `Node<T>` proxy (= branded type + AST node 構築 base)
- declaration helper 最小 (= `audioInput` / `audioOutput` / `param.f32.named`)
- `defineProcessor` の graph capture (= proxy 経由 で AST DAG 構築)
- `forSample` + 最小 primitive (= `mul`、 method form `.mul` も)
- WASM emission の core path (= literal / mul / audio I/O marshalling / param marshalling / forSample loop)
- `compile(processor)` 関 数 を `@unworklet/core` か ら export (= 引 数 = `defineProcessor()` 戻 り 値 = graph capture 済 AST、 戻 り 値 = `{ wasm, graph, memory, diagnostics, schemaHash }` 一 括 async。 内部 で binaryen を dynamic import で 呼び出す = Phase 1 PoC で 検証 済 の binaryen 経由 path を core compile module 内 に 配置)
- `renderOffline()` の WASM 駆動 path (= `compile` を 内部 で 自前 invoke + `WebAssembly.instantiate()` + input PCM を render quantum 単位 で WASM に 流す + output PCM 集める = `renderOffline` 単独 で graph capture + compile + 駆動 を 自己 完結、 Vite plugin に 依存 し ない)

meter 部分 (= `state.publish`) は Phase 6 (= messaging) で 拡張 する 設計 で、 Phase 3 で は cut。 Phase 1 PoC の binaryen 経験 を 元 に WASM emission module を `@unworklet/core` 内部 に 置く。

完了 条件: Ex 1 minus meter が `renderOffline()` で 動き、 input × param の gain が output PCM に 反映 される。

### Phase 4 — Test infrastructure

`@unworklet/test` の declared surface 全 43 件 + chain form (= `06-testing.md` §2-§6) を `renderOffline` 上 に 載 せ る:

- matcher 20 件 (= audio 3 / sample-level 10 / event 3 / MIDI 2 / state 2)
- signal utility 7 件 (= sine / silence / impulse / sineSweep / whiteNoise / dc / ramp)
- MIDI utility 10 件 (= `midi` namespace + `sequence`)
- sample/time utility 6 件 (= samplesToMs / msToSamples / samplesToSec / secToSamples / bpmToSamples / bpmToMs)
- chain form (= `@unworklet/test/extend` side-effect import で vitest `expect.extend(...)` 全 件 登 録 + TS-only `WhenResult<T, M>` guard で `RenderOfflineResult` 以 外 chain method を `never` 化)

vitest snapshot path 経 由 wav auto-write + bit-exact 比 較 (= `expectAudioMatchesSnapshot` / `expectAudioMatchesGolden`) で canonical Ex 1 (= meter なし 版) の reference PCM を 取 っ て 回 帰 防 止。 `expectStateValue` は 上 流 `inspect` (= 05-client.md §2.6) fill 待 ち で Phase 11 同 ship。

`renderOffline` 内 で compile + 駆動 自己 完結 (= Phase 3 で 確立 した shape) の 帰結 と し て、 test は Vite plugin 不要 で 動く (= Vitest 標準 環境 だけ で test 走る、 build pipeline 統合 は Phase 5 の Vite plugin 責務)。

完了 条件: Vitest で Ex 1 (= meter なし) の audio output が tolerance=0 で reference と 一致、 CI で 安定 pass。

### Phase 5 — Vite plugin (= 基本 機能 + 初期 DevTools panel)

`@unworklet/vite-plugin` の bundler 統合 機能 を 早期 ship。 後続 phase の vertical slice 検証 が dev server 上 で 即 試せ る state を ここ で 立てる。 触る 範囲:

- `?worklet` query resolution (= `import processorUrl from './x.processor.ts?worklet'` を vite が 解決、 plugin が `@unworklet/core` の `compile` 関 数 を call)
- source-change 検知 + build pipeline 統合 (= dev server / production build で `compile` を invocation)
- metadata artifact emit (= `dist/<processor>.graph.json` / `.memory.json` / `.diagnostics.json` / `.schema-hash.json`、 07-vite-plugin.md §6.3)
- Vite DevTools Kit 統合 path (= panel host) を 立てる + 初期 3 panel ship: 「Build errors / warnings」 (= 3-layer error model、 stable error ID) + 「Graph viewer」 (= AST DAG dump) + 「Memory budget」 (= declaration auto-sum、 07-vite-plugin.md §6.1)

HMR boundary (= `replaceProcessor` 依存) と source maps (= `.ts` → AST → `.wasm` 位置 propagation、 sidecar `.wasm.map`) は Phase 12 で 切り出し。 本 phase は 「dev server で `?worklet` 動く + metadata artifact emit + 初期 3 panel」 まで。

完了 条件: real Vite project で `?worklet` import が 動く + 4 metadata artifact JSON が emit + 初期 3 panel (= build errors / graph viewer / memory budget) が Vite DevTools 上 で 動く。

### Phase 6 — AudioWorklet 統合 (real audio thread)

worklet runtime template (= `AudioWorkletProcessor` 派生 class、 WASM module を audio thread で instantiate、 `process()` で WASM 呼ぶ) + main thread `UnworkletNode<C>` 最小 surface (= `createNode` / `node.node` raw / `dispose` / `node.params.<name>` / `node.inputs.<name>` / `node.outputs.<name>`)。

完了 条件: Ex 1 (= meter なし) が browser で 鳴る + Vitest browser mode で smoke test 通る + DevTools panel 「Live latency monitor」 (= render-quantum cost P50/P95/P99/Max、 07-vite-plugin.md §6.1) が AudioWorklet 上 で 動く。

### Phase 7 — Messaging

- `state.publish` (= per-slot rate-gated copy + version counter + shared region、 04-worklet-runtime.md §7 通り)
- main 側 `.state.<name>.subscribe()` / `.value`
- SAB Atomics path
- postMessage fallback (= SAB unavailable 環境)
- `event<T>` (= worklet → main ringbuffer、 `emitIf` + `atSample`)
- `message<T>` (= main → worklet、 `onReceive` handler、 block-boundary drain)

完了 条件: canonical Ex 1 が full (= meter 含む) で 動く + browser で meter が 30fps で UI に 流れる + DevTools panel 「Live state inspector」 (= named state slot + `state.publish` の live 値、 07-vite-plugin.md §6.1) が 動く。

### Phase 8 — DSL surface 拡張

各 後続 phase が 必要 と する primitive / declaration を 揃える phase。 candidate:

- 残り primitive (= 算術 / 比較 / math / `select`、 全 inventory は 01-dsl.md §2.1)
- `state.i32` / `state.bool` / `state.f64` / `state.i64`
- `buffer.f32` 等 + `buf.read` / `buf.write` / `buf.readInterpolated` / `buf.copyFrom`
- `forSample.byN`
- `everyNSamples` (= forSample callback 第 2 引数 経由、 Q43)
- L1 helper (= 純粋 TS 関数、 inline 展開)
- L2 subgraph (= `defineSubgraph` + `createSubgraph`、 state slot 持ち inline 展開)
- `num()` literal helper (= chain 起点 用)

単独 phase で 一括 fill する path も、 後続 phase (= MIDI / snapshot / SIMD) で 必要 に なる ごと に 順次 足す path も 取れる。 plan mode で 確定。

完了 条件: 01-dsl.md §2-§10 の DSL surface が 公開 type と 整合、 canonical Ex 2 / Ex 4 / Ex 5 / Ex 6 / Ex 8 の declarative path が type check 通る。

### Phase 9 — MIDI

- `midiInput` / `midiOutput` declaration (= 11-midi.md §1)
- `.onEvent(type, handler)` worklet 側 (= type-discriminated、 11-midi.md §2)
- ringbuffer + `atSample` (= 02-messaging.md §5.5 と 同 protocol)
- main 側 `.midi.<name>.send()` / `.onEvent()` / `.diagnostics.overflowCount()`
- `connectFromWebMIDI` (= Web MIDI bridge、 source-agnostic injection)
- sysex (= `buffer.u8` + variable-length content buffer、 Q49)

完了 条件: canonical Ex 5 (= granular sampler、 MIDI note in)、 Ex 6 (= MIDI arpeggiator)、 Ex 8 (= polyphonic synth)、 Ex 9 (= sysex bridge) が 動く + DevTools panel 「MIDI flow / overflow」 (= `node.midi.<name>.diagnostics`、 07-vite-plugin.md §6.1) が 動く。

### Phase 10 — SIMD subpath

- `@unworklet/core/simd` package export
- vec primitive (= `vec4` / `splat` / `addVec` / `mulVec` / `subVec` / `divVec` / `sumLanes` / `lane`、 01-dsl.md §7.2)
- `buffer.loadVec` / `storeVec` method (= 01-dsl.md §3.2 SIMD 部分)
- `forSample.byN(4, ...)` SIMD pattern

完了 条件: canonical Ex 3 (= linear-phase EQ partitioned convolution) の SIMD path が 動く + scalar-only author の import が 影響 受け ない (= 旧 SIMD なし processor が 既 動作 維持)。

### Phase 11 — Snapshot / restore + migration

snapshot/restore + migration chain + `replaceProcessor` を 後 寄り に 配置 する 理由: 他 phase (= core DSL / messaging / MIDI / SIMD) が 揃 っ た 上 で の state persistence + version 跨 ぎ migration が 検証 価 値 を 持 つ た め。 触 る 範 囲:

- schema hash 計算 (= AST structural hash、 declarations から derive)
- blob format (= version + schemaHash + slot records、 Uint8Array)
- `snapshot()` / `restore()` API + block-atomic memcpy (= 05-client.md §6.1)
- migration chain executor + `MigrationHelpers` API (= 01-dsl.md §8.3)
- transient vs persistent profile (= per-slot snapshot flag、 01-dsl.md §3 + §8.2)
- `inspect(blob)` free function (= Q48)
- `replaceProcessor` raw primitive (= 05-client.md §8、 Q50)

完了 条件: canonical Ex 7 (= convolution reverb with snapshot/restore migration) と Ex 10 (= live coding REPL bridge、 ただし HMR boundary は Phase 12 で fill) の snapshot/restore + migration path が 動く + Q63 swap 累積 warning surface 自体 (= `console.warn` を 51 回目 で 1 度 出す path) が 用意 さ れる + DevTools panel 「Snapshot inspector」 (= `snapshot()` + `inspect(blob)` の panel UI 形) + 「Swap history」 (= `replaceProcessor` invocations + `ReplaceResult` log、 07-vite-plugin.md §6.1) が 動く。

### Phase 12 — HMR boundary + source maps + 残り Vite plugin 機能

Phase 5 で 基本 機能 (= `?worklet` resolution + metadata artifact + 初期 3 panel) は ship 済。 Phase 11 で `replaceProcessor` raw primitive が 揃った 後、 Phase 12 で HMR 依存 部分 + source map propagation を fill:

- HMR boundary (= `replaceProcessor` を user-land で 呼べる shape、 `?worklet` import を hot-acceptable に mark、 07-vite-plugin.md §4)
- HMR recipe sketch (= user-land で の `import.meta.hot.accept` 経由 orchestrate path、 07-vite-plugin.md §4)
- 累積 swap warning surface (= Q63、 51 回目 で `console.warn` を 1 度 だけ)
- source maps (= `.ts` → AST → `.wasm` 位置 propagation、 sidecar `.wasm.map`、 07-vite-plugin.md §5)

完了 条件: real Vite project で source edit → `import.meta.hot.accept` 経由 で `replaceProcessor` が user-land で 呼べる + canonical Ex 10 (= live coding REPL bridge) の HMR path が 動く + 51 回目 の swap で console warning が 出る + source map が browser DevTools で source code 紐付き で 読める。

### Phase 13 — 残り canonical examples の 整合 確認

Phase 3 で Ex 1 minus meter、 Phase 7 で Ex 1 full、 Phase 9 で Ex 5/6/8/9、 Phase 10 で Ex 3、 Phase 11 で Ex 7/10 (= ただし Ex 10 の HMR path は Phase 12 で 完成) が 動く 見込み。 Phase 13 で 残る Ex 2 (= 3-band biquad EQ) + Ex 4 (= lookahead limiter) と 既 動作 Ex 全件 を 改めて 通し で 走らせる、 互換 性 確認。 動か ない Ex が 出たら そこ で 必要 な primitive / surface を 補修。

完了 条件: canonical Ex 1〜10 全 件 が `renderOffline` で reference PCM と bit-exact、 browser でも 鳴る。

### Phase 14 — Acceptance criteria 全 項目 検証 + ship

§1 全 項目 (= A1-A3 / B1 / C1 / D1 / E1 / F1) を impl AI agent が 1 意 判定。 1 項目 で も 落ちたら ship 不可、 全 項目 OK で v1.0.0 ship。

完了 条件: v1.0.0 release tag + npm publish + 4 package が 公開 dependency graph (= 09-repo-structure.md §2.4) と 整合。

## 3. Explicitly deferred

The following items are intentionally postponed past v1.0.0. Each has a forward-compatible API surface — consumer code does not change when the upgrade lands.

### 3.1 Mandatory mitigations (must ship in v1.x.0)

- **Double-buffered `buffer.publish` regions** — eliminates torn reads on multi-byte published regions and variable-length `event<T>` / `message<T>` payloads. v1.0.0 ships single-buffered (acknowledged limitation in `decisions-log.md` Q27-f and `02-messaging.md` §5.4). v1.x.0 introduces 2× region per published slot with atomic index switch from the audio thread; main-side readers consume the most-recent-completed region. **Mandatory, not optional** — the v1.0.0 surface explicitly promises this upgrade.

### 3.2 Additive surface extensions (no v1.0.0 promise; rolled out as demand surfaces)

- **Standard MIDI File loader for `@unworklet/test`** — `loadSmf(path, opts)` / `parseSmf(bytes, opts)` を `@unworklet/test` に 追 加、 `.mid` file を `OfflineEvent[]` に 変 換 し て `renderOffline` に 渡 す path。 既 知 reference song / MIDI seq を 入 力 と し て synth / arp の audio 出 力 を 検 証 す る ユ ー ス 想 定。 第 三 者 SMF parser (= `midi-file` 等) を `@unworklet/test` 内 部 依 存 と し て 持 つ か 自 前 emit か は 採 用 時 別 grill。 v1.0.0 ship 範 囲 か ら 外 し、 demand が 出 た 段 で additive 追 加。

<!-- Other candidates (to be filled in as additional resolutions settle in decisions-log.md):
       - Variable-rate iteration (`forSampleRange(start, end, callback)`)
       - rAF-driven `state.publish` rate variants
       - SIMD f64x2 / i32x4 / shuffle / gather-scatter
       - Time-unit sub-rate primitives (`everyTimeMs`)
     -->
