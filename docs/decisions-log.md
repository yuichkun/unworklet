# Decisions log

Cross-cutting reference: every resolved design question, recorded with its rationale and the alternatives that were rejected. Component docs link here for the "why" rather than restating it inline.

## Status

populated (Q1–Q62 ratify complete; Q28 is unassigned — a numbering artifact, not a withheld decision)

## Index

| # | Topic | Decision | Authoritative section |
|---|---|---|---|
| Q1 | Scalar type defaults | f32 literal default; explicit conversion only; no implicit widening (literal lift scope finalized at Q33) | `00-foundations.md` §4 |
| Q2 | Third-party DSP helper integration layer | resolved — 2 layers (L1 + L2), no L3; L1/L2 surfaces and instantiation rules settled | `01-dsl.md` §5 |
| Q3 | SIMD scope for v1.0.0 | resolved — opt-in via `@unworklet/core/simd`; v1.0.0 = f32x4 MVP; parallel families | `00-foundations.md` §4 + `01-dsl.md` §7 |
| Q4 | MIDI integration design | resolved — input+output; type-discriminated events; raw-bytes wire; transport API out of scope | `11-midi.md` |
| Q5 | State snapshot / restore API | resolved — `Uint8Array` blob; hybrid profile (short form + per-profile record); block-atomic timing; declarative migration chain; full surface in v1.0.0 | `01-dsl.md` §3, §8 + `05-client.md` §2.6, §6 |
| Q6 | Multi-output processors | resolved — declaration helpers (`audioInput` / `audioOutput`); always explicit (no default I/O sugar); required `name`; typed `node.inputs.<name>` / `node.outputs.<name>` access | `01-dsl.md` §1 |
| Q7 | Sub-rate computation | resolved — `everyNSamples(N, () => ...)` callable only inside `forSample` callbacks (per-sample phase); param automation rate untouched | `01-dsl.md` §9 |
| Q8 | Multi-block lookahead | resolved — out of scope (raw materials `buffer` + `state` + `defineSubgraph` + `createDelay` are sufficient; framework abstraction would violate either AudioContext ownership or declarative core philosophy) | `05-client.md` §7 (recipe) |
| Q9 | Cross-processor communication | resolved — out of scope ((a)(b)(e) audio routing covered by Q6 `connect()`; (c) message relay covered by upcoming generic messaging Q; (d) audio-thread SAB sharing left to consumer via `processorOptions`) | `decisions-log.md` Q9 |
| Q10 | Transport / tempo sync | resolved — out of scope (third-party domain) | `11-midi.md` §5 |
| Q11 | Browser quirk normalization scope | resolved — unworklet が normalize す る の は **WASM emission boundary 内 側** の quirk (= render quantum 128 / channel count / `parameters[name]` 1·128·0 length / subnormal flush / SAB-postMessage 自 動 切 替 / MIDI ringbuffer overflow drop-and-report / MIDI clock raw 配 送 の 7 件)、 boundary 外 側 (= Web MIDI device permission/hotplug / AudioContext lifecycle / COOP/COEP HTTP header の 3 件) は consumer 責 任、 boundary 跨 ぎ は unworklet API (= `connectFromWebMIDI` / `createNode` / runtime SAB detect / `node.onError`) で 支 え る; future quirk も 「unworklet WASM module が 触 る か?」 1 軸 で 判 定 可; 既 Q18 / Q19 / Q21 / Q27 / Q4-c / Q4-d 7 件 と 完 全 整 合; 案 α (= minimal、 Q27 と 矛 盾) / 案 β (= full normalize、 Non-goals 違 反 scope balloon) / 案 δ (= config flag、 mental model 崩 壊 portability 喪 失) 棄 却 | `00-foundations.md` §3 (Emission boundary) + `08-deployment.md` §2 |
| Q12 | Monorepo tool | (open) | `09-repo-structure.md` §1 |
| Q13 | Initial package layout | resolved — Q52 で 自 動 派 生 確 定 (= 公 開 4 package `@unworklet/core` + `@unworklet/vite-plugin` + `@unworklet/offline` + `@unworklet/test` + 内 部 module `compiler` / `worklet runtime`、 `@unworklet/core/simd` opt-in subpath) | `09-repo-structure.md` §2 + Q52 |
| Q14 | v1.0.0 acceptance criteria | (open) | `10-roadmap.md` §1 |
| Q15 | License | (open) | `09-repo-structure.md` §3 |
| Q16 | npm scope | (open) | `09-repo-structure.md` §4 |
| Q17 | Math precision variants | resolved — `@unworklet/core` の math primitive (sin / cos / tan / tanh / exp / log / sqrt 等) を v1.0.0 で polynomial approximation 1 variant 強 制 (= 5-7 次 minimax polynomial、 WASM 関 数 と し て 直 接 emit、 全 WASM 内 部 完 結 で FFI / JS-WASM boundary cross 不 使 用、 audio thread realtime safe); 最 大 誤 差 約 1e-4 で audio 24-bit dynamic range で 不 可 聴; v1.x.0 で `/precise` (= WASM 内 bundle libm) / `/table` (= precomputed table lookup) を additive 追 加 検 討; 数 値 解 析 用 途 は unworklet scope 外 と し て doc 明 示 | `01-dsl.md` §2 |
| Q18 | Render quantum handling | resolved — WASM emission で 128 を fully bake (= forSample loop bound / audio I/O buffer offset / SIMD lane mapping を 全 て コ ン パ イ ル 時 確 定、 runtime block size 参 照 ナ シ で 最 適 化 最 大 化); worklet `process(inputs, outputs)` 関 数 開 始 時 に `outputs[0][0].length === 128` を runtime check し て 違 反 時 error + 停 止 (= silent 不 動 作 を 避 け る); 将 来 ブ ラ ウ ザ 仕 様 変 動 へ の adaptive emission は v1.x.0 で additive 追 加 検 討 | `04-worklet-runtime.md` §3 |
| Q19 | Channel-count specialization | resolved — `channels: C` を declare 時 に WASM へ 焼 き 込 む (= mono / stereo 別 code path、 sample ご と の channel 判 定 分 岐 ナ シ、 SIMD lane mapping コ ン パ イ ル 時 確 定); 帰 結 と し て main 側 で `createNode` の AudioWorkletNode option (numberOfInputs / numberOfOutputs / outputChannelCount) を 上 書 き 不 可 (= 仕 様 ホ ー ル #62 同 時 解 決); 同 一 processor で の 動 的 channel 切 替 が 必 要 な ら 別 `defineProcessor` で 出 す | `04-worklet-runtime.md` §4 + `05-client.md` §1 |
| Q20 | Pre-warm correctness | resolved — v1.0.0 で framework 側 の pre-warm 機 構 を 提 供 し な い (= WASM は ブ ラ ウ ザ で AOT compile な の で JIT spike が 起 きな い、 branch predictor 等 ハ ー ド ウ ェ ア の warmup は runtime 数 quantum 内 に 自 動 で 落 ち 着 き audio 出 力 と し て 不 可 聴); framework が user code に 暗 黙 で silent block を 走 ら せ る の は declarative 原 則 違 反 寄 り; v1.x.0 で 必 要 性 が 出 れ ば opt-in option (= `createNode(..., { preWarm: {...} })`) を additive 追 加 検 討 | `04-worklet-runtime.md` §5 |
| Q21 | Denormal handling | resolved — `state.f32` / `state.f64` の `.store(v)` で コ ン パ イ ル 時 に subnormal ガ ー ド を 自 動 insertion (= `\|v\| < 1e-30` な ら 0 に 落 と す)、 audio thread の CPU spike 防 止; v1.0.0 で opt-out 機 能 ナ シ (= audio DSP で subnormal 保 持 use case 稀)、 必 要 性 が 出 た 時 v1.x.0 で opt-out option 追 加 検 討; declarative 原 則 と の 微 妙 な 衝 突 は audio DSP 業 界 慣 行 (= JUCE 等 で 標 準 FTZ) + footgun 撤 廃 で 例 外 正 当 化 | `04-worklet-runtime.md` §6 |
| Q22 | Graph capture model and process body structure | resolved (a / aprime / b / c / d all fixed; d = Rust-style error template per `03-compiler.md` §2.5) | `00-foundations.md` §3 + `01-dsl.md` §1, §10 + `03-compiler.md` §2 |
| Q23 | Hot reload semantics + Q24 bundler integration + Q25 source maps を 1 entry に 統 合 (= primitive vs user land の 仕 分 け、 user land = consumer's app と third-party tooling ecosystem の 2 layer で 区 別) | resolved — unworklet 側 CLI ナ シ、 framework は raw primitive と `@unworklet/vite-plugin` で build / asset / source maps + **DevTools 8 panel (build errors + graph viewer + memory budget + live state inspector + live latency monitor + MIDI flow + snapshot inspector + swap history) + analysis JSON / dev-time live channel** を 巻 き 取 り (= devtools panel は consumer の app に 見 え な い 開 発 者 DX surface、 全 author が 同 一 machinery を 見 た い universal な も の、 framework が opinionated に ship す べ き 領 域); HMR orchestration / 動 的 swap の audio 連 続 制 御 / consumer's app の DSP UI (spectrum / oscilloscope 等) は user land (= consumer's app への 踏 み 込 み は declarative 違 反); 動 的 swap primitive `replaceProcessor(oldNode, newProcessor)` を `@unworklet/core` に 新 規 追 加 (= Q50 で 詳 細); vite plugin の HMR 関 与 は 「`?worklet` import を Vite HMR boundary と し て 整 え る」 だ け、 swap 動 作 は user-land code が `replaceProcessor` を 明 示 で 呼 ぶ; offline rendering は `@unworklet/offline` 別 package (= 変 更 ナ シ); test matchers は `@unworklet/test` 別 package (= 変 更 ナ シ); 他 bundler plugin は v1.x.0 additive | `07-vite-plugin.md` + `05-client.md` §8 + `13-offline-render.md` + `06-testing.md` + `08-deployment.md` §1 |
| Q24 | Bundler integration scope | resolved — Q23 に 統 合 | `07-vite-plugin.md` + `08-deployment.md` §1 |
| Q25 | Source maps | resolved — Q23 に 統 合 (= `@unworklet/vite-plugin` が sidecar `.wasm.map` で 出 す) | `07-vite-plugin.md` §5 |
| Q50 | 動 的 processor swap primitive (= HMR / live coding / visual programming の 共 通 根) | resolved — `replaceProcessor(oldNode: UnworkletNode<Old>, newProcessor: New): Promise<ReplaceResult<New>>` を `@unworklet/core` か ら free function で expose; 内 部 動 作 = (1) `oldNode.snapshot()` で blob 化、 (2) 新 WASM を unique name で `registerProcessor` (= Web Audio spec の duplicate-name 禁 止 + `removeModule()` 不 存 在 制 約 を 隠 蔽)、 (3) 新 AudioWorkletNode 生 成 + `restore(blob)` (= Q5 + Q45 migration 再 利 用)、 (4) 新 typed wrapper を 戻 り 値 で 返 す; framework は graph 切 断 / 接 続 / 旧 node destroy / crossfade を 触 ら ず consumer 責 任 (= raw primitive、 declarative 純 度 維 持、 magic ナ シ); 戻 り 値 で 新 wrapper を 返 す 形 = declarations 変 化 (rename / 追 加 / 削 除) は typed `.d.ts` 経 由 で TS error と し て consumer code に 即 露 出 (= silent fail せ ず); accumulation warning (= 同 AudioContext 内 で N 回 swap 累 積 で `console.warn`) は framework が 出 す (= Web Audio `removeModule()` 不 存 在 制 約 を consumer 認 知 surface に); HMR は user-land で `import.meta.hot.accept` + `replaceProcessor` の recipe、 live coding / visual programming も 同 primitive を 使 う | `05-client.md` §8 + `07-vite-plugin.md` §4 |
| Q51 | per-block で の sample-offset primitive (audioIn.at / audioOut.set) 開 放 + JUCE / AudioWorklet process メ ン タ ル の docs 明 文 化 (audit followup) | resolved — `audioIn.at(c, 0)` / `audioOut.set(c, 0, v)` を per-block で 呼 び 可 と し て open (= 既 Q36-a の method signature `i: Node<'i32'> \| number` を そ の ま ま 適 用、 `param.at(0)` と 対 称); 旧 prose 「the equivalent literal positions for audioIn / audioOut are not opened by Q36 and remain a separate decision」 を 撤 去; 同 時 に 00-foundations.md §3 「Process body」 entry を 強 化 し て 「JUCE AudioProcessor::processBlock / AudioWorklet `process` と 同 じ mental model = body は top-to-bottom 実 行、 forSample は loop primitive、 user は process 内 で 好 き な 順 序 で sample-offset primitive を 呼 ぶ、 loop は 何 回 で も 書 け る、 同 sample 位 置 を 上 書 き 可 (Q37 last-write-wins)」 を 明 文 化; declaration は declaration scope (= body 先 頭) 限 定 と い う 構 造 ル ー ル は 維 持、 そ れ 以 外 の 順 序 / 書 き 込 み ル ー ル は 親 ホ ス ト と 一 致 | `00-foundations.md` §3 (Process body / Sample-offset / Per-block phase) + `01-dsl.md` §1 |
| Q26 | TypeScript version | (open) | `09-repo-structure.md` §5 |
| Q27 | Generic typed messaging core surface | resolved — 5-surface uniform (param / state.publish / event / message / midi); SAB+Atomics with postMessage fallback; bulk via state.buffer.publish or event/message variable-length payloads | `02-messaging.md` + `01-dsl.md` §3, §4 |
| Q28 | — | unassigned (numbering artifact, no decision under this number) | — |
| Q29 | variable-rate iteration の v1.0.0 提 供 判 断 | resolved — v1.0.0 で `forSample` + `forSample.byN` の み (= 既 ratify 維 持); `forSampleRange(start, end, callback)` は v1.x.0 で additive 追 加 検 討 (= 表 現 力 は v1.0.0 forSample + build-time if で カ バ ー 済 み、 効 率 化 用 途); `forSamplesUntil(cond, callback)` (= runtime early-exit) と runtime variable stride は 永 久 排 除 (= realtime safety 違 反 / declarative 原 則 違 反) | `01-dsl.md` §10.5 |
| Q30 | memory budget policy | resolved — processor 内 の 全 declaration (= state / buffer / message・event payload content / MIDI ringbuffer) を build-time に 自 動 sum し て WASM linear memory を そ の サ イ ズ で alloc; user 側 で の explicit `memoryLimit` option ナ シ で v1.0.0 出 し (= 必 要 性 出 れ ば v1.x.0 で additive); 64 MB 越 え で build-time warning (= ロ ー エ ン ド device で の load 遅 延 配 慮)、 WASM 上 限 (= 4 GB) 越 え で build-time エ ラ ー; audio thread で の `memory.grow` 永 久 排 除 (= realtime safety 違 反) | `03-compiler.md` §2.4 + `03-compiler.md` §4 |
| Q44 | ringbuffer capacity を power-of-2 制 約 で 受 け 取 る 形 (audit P1 #61 仕 様 ホ ー ル) | resolved — `midiInput` / `midiOutput` / `event<T>` / `message<T>` の `capacity` option 値 を `@unworklet/core` の top-level SCREAMING_SNAKE constant `CAPACITY_16 / CAPACITY_32 / CAPACITY_64 / CAPACITY_128 / CAPACITY_256 / CAPACITY_512 / CAPACITY_1024 / CAPACITY_2048 / CAPACITY_4096 / CAPACITY_8192 / CAPACITY_16384` (= 2^4 〜 2^14) で export (= 既 `SAMPLES_PER_BLOCK` (Q35) 同 軸)、 type は `Capacity = typeof CAPACITY_16 \| ...` literal union; option 名 (= `capacity`) と prefix (= `CAPACITY_`) を 揃 え て user は 「`capacity: CAPACITY_<N>`」 と 1:1 一 致 で 書 く、 任 意 数 字 / 直 接 数 字 リ テ ラ ル は TS narrow で 別 物 扱 い で 弾 か れ る; build-time / runtime check 不 要 で IDE 段 階 で 即 TS エ ラ ー; 内 部 実 装 jargon (= ring / slot) を user 露 出 し な い | `01-dsl.md` §4.1, §4.2 + `11-midi.md` §1 |
| Q45 | migration 関 数 が throw し た 時 の framework 振 る 舞 い (audit #63 仕 様 ホ ー ル) | resolved — `migrate` 関 数 内 で throw が 出 た 時 framework が catch し て chain 全 体 stop (= 後 続 step の input が 不 完 全 で 危 険 ため、 部 分 restore せ ず); processor は default 値 で 起 動 (= 既 Q5 「default で 動 く」 通 り、 audio 出 力 が pending に な ら な い); main 側 `node.restore(blob)` の 戻 り 値 を discriminated union `{ ok: true, ... } \| { ok: false, error: { step, message, cause }, ... }` に 拡 張 (= 既 `{ restored, skipped, missing }` は 維 持、 `ok` discriminant + `error` で 失 敗 情 報 を narrow); audio thread 上 で の 例 外 propagate ナ シ で realtime safety 維 持 | `01-dsl.md` §8.3.3 + `05-client.md` §2.6 |
| Q46 | `MidiEvent` / `event<T>` の cross-thread 型 view 分 離 (audit Phase 2 #8、 #47) | resolved — main thread / wire 用 と worklet audio-thread 用 で **TypeScript 型 を 2 つ に 分 け る**; `MidiEvent` (= 全 numeric field `number`、 typed-array field 生 `Uint8Array` 等) は `node.midi.<name>.send(...)` / `.onEvent(...)` の main 側 surface 専 用、 `MidiEventGraph` (= 全 numeric field `Node<'i32'>`、 typed-array field は §4.3 typed-array-field proxy) は `midiInput().onEvent(...)` handler arg + `midiOutput().emitIf(...)` arg 専 用; emit 側 で の number / boolean literal は Q33 literal-lift で 自 動 に Node 化 す る た め user code は main / worklet で 同 じ literal を 書 け る; `event<T>` も 同 様 に main 側 `T & { atSample: number }` / worklet 側 lifted view (= 全 number → Node<'i32'>、 全 boolean → Node<'bool'>、 全 typed-array → §4.3 proxy) で 2 view 派 生; mapped 型 (= 1 型 + `ToGraph<T>` 派 生) は IDE hover で `ToGraph<MidiEvent & ...>` が 出 て user 認 知 負 担 高 い た め 棄 却、 明 示 2 型 で 命 名 直 接 | `11-midi.md` §2.2, §2.3, §2.4 + `01-dsl.md` §4.1 |
| Q47 | diagnostics surface 統 一 (audit Phase 2 #10、 #49) | resolved — diagnostics counter (= `overflowCount` 等) を **main 側 だ け で 提 供**、 worklet 側 handle (= `midiIn.diagnostics.X()`) を spec か ら 削 除; 全 channel (= event / message / MIDI) で `node.<kind>.<name>.diagnostics.X()` の 統 一 形 (= 既 Q40 namespaced shape と 整 合)、 「diagnostics は 外 部 観 測」 を declarative 原 則 (= 副 作 用 観 測 は main の 役 割、 worklet `process` body は feedback loop を 持 た な い) と し て 確 立; worklet 内 で の self-throttle pattern が 必 要 な ら main 経 由 で feedback (= 1 周 余 計 だ が 構 造 明 確)、 v1.x.0 で worklet handle へ の `.diagnostics` 後 付 け は additive 可 | `11-midi.md` §4 overflow + `decisions-log.md` Q4-c-iv prose |
| Q48 | `inspect(blob)` を free function に 留 め る か node method に 動 か す か (audit Phase 2 #9、 #48) | resolved — `inspect(blob: Uint8Array): InspectionResult` を **free function 維 持** (= `@unworklet/core` か ら import)、 node method に 動 か さ な い; `snapshot()` / `restore(blob)` は node 依 存 (= 現 state を 読 む / 書 く) で 必 然 的 に node method、 `inspect` は blob を decode す る pure function で node 不 要 (= preset library tool / server-side blob analyzer / debug script で audio context 起 動 ナ シ で 動 く); 「依 存 性 で 形 が 決 ま る = node 依 存 操 作 は method、 blob-only 操 作 は free function」 を 1 行 ル ー ル と し て 明 文 化、 視 覚 的 対 称 (= snapshot/restore/inspect 揃 い) よ り 依 存 性 の 実 体 通 り の form を 優 先; node method 形 (= `node.inspect(blob)`) は 嘘 の 依 存 性 を user に 強 制 し て fakeNode ハ ッ ク 招 く た め 棄 却 | `05-client.md` §2 |
| Q49 | worklet 側 sysex emit の data 構 築 経 路 (audit Phase 2 #17 / H9、 #54) | resolved — worklet → main sysex emit を **declared `Buffer<'u8'>` + `length: Node<'i32'>` 経 由 で v1.0.0 完 全 spec**、 sunset は ナ シ; `buffer.u8({ size, name })` を 新 規 構 築 用 byte buffer 専 用 factory と し て 導 入 (= 既 `Buffer<T>` handle と 同 形、 read/write は `Node<'i32'>` で 受 け て 下 位 8 bit を 扱 う、 `Node<'u8'>` 型 は 導 入 し な い で ScalarType 拡 張 ナ シ で 整 合); `MidiEventGraph` sysex variant を `{ type: 'sysex'; data: Buffer<'u8'> \| TypedArrayFieldRef<'u8'>; length: Node<'i32'>; atSample: Node<'i32'> }` に refine、 ingested proxy を そ の ま ま re-emit (= MIDI thru) も 同 path で 表 現; main 側 `MidiEvent` sysex は そ の ま ま `data: Uint8Array` (= framework が buffer の `data[0..length-1]` を copy し て 届 け る)、 main 側 は length 不 要 (= Uint8Array.length で 取 れ る); `new Uint8Array(...)` 経 路 は 永 久 排 除 (= realtime safety / declarative pattern と 整 合) | `11-midi.md` §2.2, §2.5, §4.3 + `01-dsl.md` §3.2 |
| Q31 | onReceive execution contract + bulk copy primitive (audit B1) | resolved — handler runs on audio thread (per Q27-c); audio-thread loops require build-time-constant bounds; `buf.copyFrom(typedArrayField)` for bulk transfer; state-slot-array copy via build-time unroll + `select`/`lt` mask | `02-messaging.md` §1 + `01-dsl.md` §3.2 |
| Q32 | `emitIf` callable in MIDI / message handler context (audit B2) | resolved — `emitIf` is the single emission primitive across all expression contexts (forSample / forSample.byN, everyNSamples, MIDI handler, message handler, per-block top level); cond accepts `Node<'bool'> \| boolean` so handler-context / per-block unconditional emission is `emitIf(true, payload)`; static-analysis rejects constant-truthy cond inside `forSample` to preserve the Q4-b footgun barrier | `01-dsl.md` §4 + `02-messaging.md` §1 + `11-midi.md` §2.4 |
| Q33 | Literal lifting in i32 / bool / context (audit B3) | resolved — Q1 拡 張: primitive 引 数 で の literal は context-dependent lift (周 辺 引 数 から `T` 推 論)、 ambiguous case は default `'f32'`、 対 象 type は f32 / f64 / i32 / bool; declaration / 全 lit 等 暗 黙 lift 対 象 外 は scalar constructor (`f32` / `f64` / `i32` / `i64` / `bool`) で explicit; i64 暗 黙 lift ナシ (BigInt 必 要) | `00-foundations.md` §4 + `01-dsl.md` §2 |
| Q34 | Subgraph instantiation scope (audit Phase 1 #2、 Q22-c-Round2 解 決) | resolved — `createSubgraph(subgraph, ...args)` で declaration scope に instance 生 成 (state slot alloc); subgraph body は record return で key 名 著 作 者 free; method は forSample / handler / per-block 全 context で 呼 べる; method 戻 り 値 で の context 制 限 ナシ; nested subgraph は declaration scope で OK | `01-dsl.md` §5.6 |
| Q35 | Render quantum length の user code 露 出 形 (audit Phase 1 #6) | resolved — `SAMPLES_PER_BLOCK: 128` を `unworklet` package の top-level constant と し て export; `ctx.renderQuantum` ナシ (= run-time 値 と build-time 定 数 を 区 別); ctx が 在 域 し な い build-time JS 文 脈 で も 引 用 可 | `01-dsl.md` §1.7 |
| Q36 | method 引 数 で の literal lift + typed-array-field proxy semantics + emitIf cond 型 確 定 (audit P0-1) | resolved — Q33 拡 張: method の 引 数 型 が `Node<X>` な ら literal は 自 動 で `Node<X>` に lift (= `param.at(0)` per-block / `emitIf(true, ...)` / `main.at(0, i)` 等 を 型 と 整 合); typed-array-field proxy = `.length: Node<'i32'>` + `.at(idx: Node<'i32'> \| number)` で runtime read / build 時 折 り 畳 み を 引 数 種 類 で 自 然 分 岐; emitIf cond 型 を `Node<'bool'> \| boolean` で 確 定 (= Q32-b の B3 pending を close) | `00-foundations.md` §4 + `01-dsl.md` §2, §3.3, §4.1, §4.3 |
| Q37 | 出 力 channel の 書 き 込 み ル ー ル を 親 ホ ス ト (AudioWorklet) と 揃 え る (audit P0-2) | resolved — `out.set(c, i, v)` は 自 由 に 何 度 で も 書 け る、 同 sample 位 置 を 複 数 回 書 け ば source 順 で 後 書 き が 勝 つ、 触 ら な い sample 位 置 / channel は silence (= 0); 複 数 forSample 分 担 / 重 ね 書 き 全 部 OK; 静 的 解 析 で 弾 く の は real-time safety 違 反 の み (= 「全 sample カ バ ー」 「exactly once」 系 制 約 を 撤 去); forSample.byN 中 で の `out.set` も legal、 stride は 128 を 割 る 値 (= 1, 2, 4, 8, 16, 32, 64, 128) 限 定 | `01-dsl.md` §1.3, §10.1 + `03-compiler.md` §2.4 |
| Q38 | `onReceive` (= main → worklet message handler) の 振 る 舞 い (audit P0-3、 Phase 1 #4) | resolved — (a) timing = 当 1 塊 開 始 時 (= worklet 視 点 で current、 main 視 点 の 「next」 表 記 は 視 点 違 い、 worklet 視 点 で 統 一); (b) 実 行 順 序 = 全 handler が 1 塊 開 始 時 に 先 行、 そ の あ と per-block 計 算 + forSample が source 順 で 走 る (= AudioWorklet `onmessage` 振 る 舞 い と 整 合); (c) 1 message に 複 数 `onReceive` OK、 登 録 順 で 全 部 走 る (= 上 書 き で は な い); (d) handler 内 `state.load()` = 前 1 塊 末 尾 の 値、 `state.store()` は 当 1 塊 の per-block 計 算 + forSample で 観 測 可 | `01-dsl.md` §4.2 + `02-messaging.md` §1 |
| Q39 | publish の 版 counter increment ル ー ル + main 側 dedupe 政 策 (audit P0-4) | resolved — audio thread は due tick で 無 条 件 に 値 を SAB store + 版 counter inc (= 既 値 比 較 + branch ナ シ で real-time 友 好); main 側 は 版 advance 時 に handler を 必 ず 呼 ぶ (= framework で 値 比 較 / dedupe ナ シ); user が 同 値 dedupe 欲 し い な ら handler 内 で 1 行 で 比 較。 既 仕 様 02 §5.4 「値 変 化 時 だ け inc」 + 05 §5.2 「identical re-publish は coalesce」 prose は magic anti-pattern と し て 撤 去 | `02-messaging.md` §5.4 + `04-worklet-runtime.md` §7 + `05-client.md` §1, §5.2 |
| Q40 | `node.midi` の main 側 surface 形 (audit P0-5、 Phase 1 #5) | resolved — `node.midi.<name>.send(...)` / `.onEvent(...)` / `.connectFromWebMIDI(...)` / `.diagnostics.overflowCount(...)` の namespaced 形 で 統 一 (= 既 Q4-a で ratify 済 み だ っ た が 11-midi §3 / 05-client §1 / canonical で flat 表 記 が 残 っ て いた、 audit で 反 映 不 足 が 露 出); 他 全 declaration (= node.inputs.<name> / node.events.<name> / node.state.<name> 等) と 一 貫、 multi-port も natural に 表 現 (= dualPort 等); single-port で も namespaced 形 で 書 く | `11-midi.md` §3, §4 + `05-client.md` §1 + Q4-a |
| Q41 | `createSubgraph` の instance name 渡 し 方 (audit P0-6、 Phase 2 #16) | resolved — signature を `createSubgraph(subgraph, ...lambdaArgs, options?: { name?: string })` に 拡 張 (= Q34 既 form の 末 尾 options 追 加)、 **options 自 体 も optional、 name property も optional** (= snapshot 不 要 な subgraph で boilerplate ナ シ); snapshot を 取 る 場 面 で name ナ シ subgraph instance が あ れ ば build-time エ ラ ー で 弾 く、 snapshot path = `'<instance-name>/<inner-slot-name>'` (= 例 「'lpfL/z1'」) で 統 一 | `01-dsl.md` §5.6.2, §8.1 |
| Q42 | `state.publish` 対 応 type と state.bool の WASM 表 現 (audit P0-7) | resolved — publish を 渡 せ る type を **f32 / i32 / bool の 3 つ に 限 定 ** (= 全 て 32 bit 1 word で 完 結、 JS `Atomics` で audio thread / main 両 方 が 安 全 に 1 回 で 読 み 書 き 可)、 state.bool は 内 部 で `i32` の 0/1 を 持 ち main 側 で boolean に cast、 main 側 `.value` 型 は state.bool→boolean / state.f32 と state.i32→number; state.f64 / state.i64 で publish オ プション を 渡 す と TypeScript エ ラ ー (= 64 bit が 2 回 に 分 け て 触 る ため torn read の 危 険、 v1.x.0 で mitigation と セ ット で 検 討) | `01-dsl.md` §3.1 + `02-messaging.md` §5.4 + `05-client.md` §1 |
| Q43 | `everyNSamples` を forSample callback 引 数 経 由 で 取 る (audit P0-8) | resolved — `everyNSamples` を free function import か ら `forSample((i, everyNSamples) => ...)` の callback 第 2 引 数 に refine (= Q7 既 ratify form の callback 引 数 化、 既 `i` と 同 軸); forSample.byN も 同 形; scope は TypeScript scoping で 自 然 に 弾 か れ る (= handler / per-block top で TypeScript reference error、 build-time context tracking 不 要); subgraph method 内 で の 自 前 forSample で 自 然 解 決 (= caller context tracking 不 要); counter は 呼 び 出 し ご と に 独 立、 1 塊 を 越 え て 連 続 で reset ナ シ | `01-dsl.md` §9, §10.1 + Q7 |
| Q52 | Public package layout の docs-side enforcement (Q23 派 生、 L1-d) | resolved — 公 開 npm package 4 個 (= core / vite-plugin / offline / test、 Q23 strict)、 公 開 import path 5 種 (= 上 記 4 + `@unworklet/core/simd` subpath)、 DSL 識 別 子 約 50 個 は `@unworklet/core` root に flat export (= dsp subpath / 独 立 package ナ シ)、 `@unworklet/compiler` / `@unworklet/worklet` / `@unworklet/dsp` は 公 開 package で は な い (= compiler / worklet runtime は `@unworklet/core` internal module、 dsp surface は core root に flat); doc 章 タ イ ト ル の 表 記 規 則 = 公 開 package doc は タ イ ト ル に package 名 + internal module doc は タ イ ト ル か ら package 名 削 除 + 冒 頭 prose で 内 部 明 記; Q13 (initial package layout) が 自 動 派 生 確 定 | `01-dsl.md` L1 + `03-compiler.md` L1 + `04-worklet-runtime.md` L1 + `07-vite-plugin.md` L26 + `08-deployment.md` L13 |
| Q53 | 仕 様 invariant vs 型 declaration の 形 — ratify 範 囲 確 定 (L1-c re-scope) | resolved — 設 計 ratify 範 囲 を 「仕 様 invariant」 (= 振 る 舞 い / 制 約 / mental model / 公 開 surface に 何 が 出 て く る か / 仕 様 内 矛 盾 / dangling) に 限 定、 「TS signature 細 部 / 識 別 子 名 の 好 み / generic constraint 表 現」 は impl AI agent が TS compiler 経 由 で 機 械 的 に 確 定 す る 領 域 と し て 委 譲 (= 「曖 昧 さ を 残 す」 で は な く 「適 切 な layer に 委 譲」、 既 ai-agent-paradigm スタンス と 整 合); L1-c の 当 初 19 種 type 階 層 分 類 議 論 を 撤 退、 dangling 1 件 (`SubgraphInstance<S>` invariant prose 不 在) を L1-c に 残 し て 別 grill; L2-a (loadVec / everyNSamples 命 名) + L2-b (param.at(0) framing) も impl AI 領 域 / L1-a 自 動 解 消 と し て open-questions か ら 撤 去 | `open-questions.md` 冒 頭 「ratify 範 囲」 セ ク シ ョ ン + Q23 (AI agent paradigm の 既 ratify) + 既 memory `ai-agent-paradigm-implementation-cost` |
| Q54 | defineSubgraph wrapper の 真 の 役 割 + `SubgraphInstance<S>` 撤 廃 (L1-c 完 全 close) | resolved — `defineSubgraph` / `createSubgraph` wrapper を v1.0.0 で 維 持 (= 関 数 統 一 棄 却)、 wrapper の 真 の 役 割 = (1) framework-level identification (= Q30 memory budget + Q23 DevTools graph instance grouping + snapshot path namespacing の hook) + (2) name scope (= Q41 instance name = snapshot path prefix の framework 担 保); `SubgraphInstance<S>` 名 を 公 開 surface か ら 撤 廃 (= §1.6.1 export list か ら 削 除)、 `createSubgraph(...)` の 戻 り 値 = **subgraph body の return record そ の も の** と invariant 直 接 規 定、 user が 型 引 用 し た い 時 は `ReturnType<typeof subgraphDecl>` (TS 標 準); §5.2 / §5.6.2 prose 強 化 で wrapper の 真 の 役 割 を 明 文 化 (= 関 数 統 一 棄 却 理 由 + canonical Ex 2 / Ex 8 vs Ex 5 対 比 引 用) + L1-c dangling 完 全 close | `01-dsl.md` §1.6.1 + §5.2 + §5.6.2 + Q2 / Q34 / Q41 / Q53 |
| Q55 | priority filter 軸 = impl 矛 盾 リ ス ク + L1-a 「phase」 wording sweep (Q53 補 強、 Q51 followup) | resolved — v1.0.0 ship 前 docs 読 者 = impl AI agent、 user-facing docs は v1.0.0 完 成 後 別 phase で 関 心 範 囲 外; priority filter の 唯 一 の 軸 = 「impl AI agent が 手 放 し で 実 装 し た 時 に 矛 盾 が 出 る か」 = 異 な る agent が 異 な る judgment に 達 す る prose 内 矛 盾 / dangling だ け が ★★★、 「user 視 点」 「user 誤 解」 「mental model 揺 れ る」 は priority 評 価 軸 外 (= mechanical sweep 領 域); L1-a 構 造 名 詞 「phase」 撤 廃 sweep (= Q51 followup) を 同 commit で 完 了、 adjective 「per-block / per-sample」 維 持、 §6 heading `The process phase` → `The process body`、 §10.4.1 `Single-phase` → `Per-sample-only`、 §10.4.2 `Multi-phase` → `Mixed`、 canonical Ex 3 description rename、 SIMD example `Phase 1/2/3` → `Step 1/2/3`、 oscillator phase counter / minimum-phase / linear-phase / 音 響 phase / compiler phase は 別 意 で retain | `open-questions.md` 冒 頭 「ratify 範 囲 と priority filter」 section + L1-a entry 削 除 + Q53 + Q51 |
| Q56 | Handler body の expression scope (= L1-b、 Q51 followup) | resolved — `messageDecl.onReceive(...)` / `midiInput().onEvent(...)` handler body の expression scope rule を `forSample` callback と 完 全 一 致 さ せ る (= primitive op / `state.load/store` / buffer access / audio I/O `audioIn.at` / `audioOut.set` / `param.at` / `emitIf` / subgraph methods / L1 helpers が 全 て legal、 新 規 declaration `state.*` / `buffer.*` / `param.*` / `createSubgraph(...)` は 不 可); sample-offset 引 数 は `Node<'i32'> | number` を 一 律 受 け 入 れ (= handler arg の `atSample` / state slot value / buffer read / JS literal の ど れ も OK)、 surrounding `forSample` の `i` だ け が scope 外 (= 既 規 定 通 り、 handler は forSample の 前 に drain); `01-dsl.md` §4.2 L500 「Inside a handler, only state writes, buffer writes, and scalar arithmetic are allowed」 prose を 「same expression-scope rules as a forSample callback」 に 書 き 換 え、 §4.1 / §5.6.4 / §6 / Q32 既 規 定 と 整 合 (= L500 が 唯 一 の 狭 prose だ っ た dangling 解 消); 案 (d) 一 切 禁 止 (= state 書 き 込 み 専 用 segment) 棄 却 (= user に 覚 え る context rule を 1 個 追 加、 forSample / handler の 2 種 別 ル ー ル、 公 開 surface の 概 念 量 増、 no-artificial-constraint 違 反); 案 (a) JS literal だ け / (b) `Node<'i32'>` だ け も 不 自 然 例 外 規 則 で 棄 却 | `01-dsl.md` §4.2 + `02-messaging.md` §1 + `11-midi.md` §2.3 + `00-foundations.md` §3 (Expression scope、 既 整 合) + Q22 / Q32 / Q36 / Q51 |
| Q57 | `createNode({ restore })` option 廃 止 (= L2-c) | resolved — `CreateNodeOptions<C>.restore?: Uint8Array` を v1.0.0 surface か ら 廃 止、 `createNode` 戻 り 値 形 は 常 に `Promise<UnworkletNode<C>>` で 統 一、 snapshot 復 元 は `createNode` → `await node.restore(blob)` の **2 step pattern** が canonical (= Q45 `RestoreResult` discriminated union で 失 敗 surface 取 得); 案 (A) 戻 り 値 を `{ node, restore }` に 拡 張 棄 却 (= restore option 渡 し た 時 だ け wrap 形 = 戻 り 値 形 が option 有 無 で 2 種、 TS overload 2 種 増、 surface 概 念 量 増)、 案 (B) `onError` event で 通 知 棄 却 (= error event は worklet trap / queue overflow 等 の **起 動 後 非 同 期 event** 用、 migration throw は **node 起 動 時 の 同 期 flow** で 性 質 違 う、 mental model 衝 突); canonical Ex 群 で `createNode({ restore })` 使 用 ナ シ = consumer は 既 に 2 step pattern で 書 い て い る fact、 ergonomic loss は +1 行 軽 微; v1.x.0 で 「1 step」 必 要 性 出 た ら additive 追 加 可 | `05-client.md` §1 + `13-offline-render.md` §2 / §4 + Q45 |
| Q58 | L1 helper の nested `forSample` 明 示 化 (= L2-d、 旧 L3-b) | resolved — L1 helper 内 で `forSample(...)` 呼 び + caller が `forSample` 内 か ら helper 呼 ぶ pattern (= 暗 黙 nested forSample) を **v1.0.0 で 認 め る + spec 明 文 化**、 直 接 `forSample` 内 で `forSample` を 呼 ぶ pattern も 同 様 に legal (= §10.3 既 wording の 自 然 帰 結); 内 外 callback は 別 関 数 の 引 数 で `i` は 独 立、 RT-safe 静 的 解 析 は 内 外 両 方 の forSample に `SAMPLES_PER_BLOCK` bounded-loop check を 独 立 適 用 (= 既 invariant Q22 / Q29 の 自 然 拡 張、 新 ル ー ル ナ シ); 案 (B) 禁 止 棄 却 (= helper の 呼 び 位 置 で 動 作 変 化 = 関 数 抽 象 の 漏 れ、 §10.3 既 wording と も 衝 突)、 案 (C) canonical Ex 追 加 棄 却 (= v1.x.0 で 必 要 性 出 た ら L4-d / L4-e voice-allocation / overlap-add と 同 軸 で recipe 追 加、 v1.0.0 ship 必 須 で は な い); 計 算 量 (= 128 × 128 = 16384 sample ops / quantum) は user の 設 計 責 任、 docs prose で 1 行 注 意 喚 起 | `01-dsl.md` §5.5.5 + §10.3 + Q22 / Q29 |
| Q59 | SIMD `sumLanes` を v1.0.0 で 出 す (= L3-a) | resolved — `@unworklet/core/simd` か ら `sumLanes(v: Node<'f32x4'>): Node<'f32'>` を v1.0.0 export、 §7.2 MVP surface に 「Horizontal reduction」 sub-section と し て Lane access の 後 ろ に 追 加; 4 lane を 1 scalar に collapse す る natural な 終 端 操 作、 4-tap FIR / dot product / per-block accumulator collapse 等 SIMD 主 要 use case で 累 積 ergonomic 利 益 (= 4 行 → 1 行); framework emit は shuffle + add (= WASM SIMD spec に float horizontal reduce 直 接 ナ シ)、 性 能 は 案 (B) 案 と ほ ぼ 同 等 で ergonomic 利 益 が 主; canonical Ex 3 / Ex 7 で 既 に 4 行 pattern を 3 箇 所 で 書 い て い た fact (= 既 知 必 要、 v1.x.0 defer は [[no-preemptive-defer]] 違 反 リ ス ク)、 同 commit で 3 箇 所 を `sumLanes(...)` に rewrite (= AGENTS.md HARD CONTRACT 整 合); 案 (B) v1.x.0 defer 棄 却 (= SIMD primitive family と は 別 軸 で lane access の 終 端 操 作 = 単 独 primitive、 既 知 必 要 を defer す る 根 拠 ナ シ) | `01-dsl.md` §7.1 + §7.2 + `12-canonical-examples.md` Ex 3 / Ex 7 |
| Q60 | Trivial repo settings batch (= L4-c × 4: monorepo tool + license + npm scope + TypeScript minimum) | resolved — (1) monorepo tool = pnpm workspaces (= VitePlus が user 選 択 で pnpm / npm / yarn / bun を wrap、 unworklet は pnpm 採 用、 root `pnpm-workspace.yaml` + root `package.json` の `packageManager: pnpm@<version>` + cross-package ref は `workspace:*` protocol、 開 発 / CI 起 動 は 全 て `vp` CLI 経 由 で AGENTS.md HARD CONTRACT)、 (2) license = MIT、 (3) npm scope = `@unworklet` (= 余 湖 さ ん npm account で 既 確 保)、 (4) TypeScript minimum = 5.5; trivial 設 定 値 (= 余 湖 さ ん の 既 取 得 / 既 嗜 好 で 決 ま る 値、 impl AI agent は 確 定 値 を 設 定 す れ ば 矛 盾 出 な い) を batch ratify | `09-repo-structure.md` §1 / §3 / §4 / §5 |
| Q61 | Placeholder section 群 = impl 期 owner 任 せ 明 文 化 (= L4-a) | resolved — 各 doc の `<!-- placeholder -->` section (= 大 半 が internal implementation spec、 公 開 surface で は な い) は impl 開 始 時 に 各 doc owner が 順 次 fill す る 方 針 と し て docs 化、 v1.0.0 spec freeze 前 に 全 部 drain ナ シ; 統 一 注 釈 prose の 各 placeholder へ の 散 布 は L4-M4 sweep の 領 域 で 後 続 batch、 ratify 自 体 は こ の entry で 完 結; `09-repo-structure.md` §6 (= versioning policy) は Q14 acceptance criteria 連 動 で Q61 範 疇 外 | `00-foundations.md` §6 + `03-compiler.md` §1 / §3〜§8 + `04-worklet-runtime.md` §1 / §2 / §8 + `05-client.md` §3 / §4 + `06-testing.md` §2〜§5 + `07-vite-plugin.md` §2 / §3 / §5 / §6.x + `08-deployment.md` §3 / §4 + `10-roadmap.md` §1 / §2 / §3.2 + `13-offline-render.md` §2.x / §3 |
| Q62 | v1.0.0 acceptance criteria (= L4-b、 Q14) | resolved — `10-roadmap.md` §1 を fill、 9 項 目 checklist (= A1 vp build / A2 canonical 全 WASM emit / A3 vp check / B1 canonical 期 待 output offline 再 現 / B2 pure JS ↔ WASM bit-exact / C1 realtime-safety 5 invariants layered 検 出 / D1 browser × isolated 6 セ ル smoke / E1 L4-M sweep 完 了 / E2 Layer 1〜3 = 0 / F1 .d.ts ↔ Q1-Q62 整 合) で impl AI agent が ship 可 否 を 1 意 判 定 可; browser matrix = (β) Chromium + Firefox + Safari × {COOP/COEP cross-origin isolated, not isolated} = 6 セ ル full required、 D1 smoke test 仕 様 で `connectFromWebMIDI` (= Web MIDI 標 準 wrapper) は test 対 象 外 (= emission boundary 外 側 = consumer 責 任、 Q11 整 合)、 全 browser セ ル で `node.midi.<name>.send(event)` source-agnostic injection 経 由 で MIDI 動 作 を 統 一 検 証; Safari Web MIDI 非 サ ポ ー ト = unworklet 側 実 装 変 更 ナ シ (= consumer が `navigator.requestMIDIAccess` を feature-detect す る path)、 `08-deployment.md` §2 B1 に Safari 制 約 1 段 落 補 強 + Per-browser validation prose に 1 文 補 強; 案 (α) Chrome + Firefox 4 セ ル / 案 (γ) Safari best-effort 棄 却 (= Safari の core 制 約 は Web MIDI に 限 定、 unworklet 自 体 は Safari で 動 く た め full required 達 成 可 能) | `10-roadmap.md` §1 + `08-deployment.md` §2 B1 + Q11 |

---

## Q1 — Scalar type defaults

**Status:** resolved (literal lift scope finalized at Q33).
**Decision:** authoritative wording in `00-foundations.md` §4. Summary: numeric literals lift to `Node<'f32'>` as the default; cross-precision conversion is explicit via scalar constructors (`f32(node)` / `f64(node)` / etc.); operations on mixed-precision operands are a compile-time type error. Q33 extends the lift rule to context-dependent inference (i32 / bool / f64 lift in primitive-argument position when siblings determine `T`).
**Rationale:** AudioWorklet I/O is `Float32Array`-typed end-to-end; `f32` default avoids per-sample boundary conversions and matches the Web Audio data plane. Audio-rate DSP overwhelmingly uses f32.
**Rejected:**
- *`f64` literal default* — would force per-sample f32↔f64 conversions at every I/O boundary and double linear-memory footprint. Mismatched with the data plane.
- *Mandatory type hints on every literal* (e.g. `add(node, f32(0.4))`) — maximally explicit but verbose enough to harm readability of typical DSP expressions, with no precision benefit over the chosen default.

<!-- Subsequent entries follow the same shape: Status / Decision (with cross-ref) / Rationale / Rejected. -->

---

## Q2 — Third-party DSP helper integration layer

**Status:** resolved.

**Decision (Q2-a):** authoritative wording in `01-dsl.md` §5.1–§5.4. Summary: two integration layers — L1 (pure TS function, inlined) and L2 (`defineSubgraph`, stateful, inlined into the parent WASM module). No "separate processor + connect" L3 layer — that case is covered by `AudioWorkletNode.connect()` directly and is outside unworklet's API surface.

**Decision (Q2-b):** authoritative wording in `01-dsl.md` §5.5. Summary:

- L1 helpers are stateless TypeScript functions inlined at the call site, living entirely in expression scope (per-block top level or per-sample `forSample` callback).
- Parameters: `Node<T>`, caller-owned `State<T>` (with `load`/`store`), caller-owned `Param` (read via `param.at(i)` for per-sample or `param.at(0)` for per-block), caller-owned `AudioInputHandle` / `AudioOutputHandle` (accessed via `at` / `set`), `i: Node<'i32'>` from a surrounding `forSample` for helpers that perform per-sample I/O, and compile-time constants.
- Return: single `Node<T>`, tuples, records, or `void`. Each returned `Node` is an independent graph terminal.
- Precision-generic via TypeScript generics over `'f32' | 'f64'`; Q1's no-implicit-widening still holds inside the body.
- Body forbids new `state.*` / `buffer.*` / `param.*` / `audioInput` / `audioOutput` declarations, `defineSubgraph` declarations, L2 instantiations, and `message` / `event` declarations; allows primitives, `load` / `store` on parameter `State`, `param.at(i)` (inside `forSample`) or `param.at(0)` (per-block) on parameter `Param`, `audioIn.at(c, i)` and `audioOut.set(c, i, v)` (inside `forSample`) on parameter handles, buffer access, calls to other L1 helpers, and `forSample(...)` invocations when iteration is needed inside the helper.
- Violations are caught at graph-capture / static-analysis time (compile time, never runtime) and surfaced with refactor-hint error messages. Detailed error-UX policy lives in `03-compiler.md` §2 (Q22).

**Decision (Q2-c):** authoritative wording in `01-dsl.md` §5.6. Summary:

- Subgraph body uses the same two-scope shape as `defineProcessor`: declaration scope at the top, expression scope inside a `process` lambda. Symmetry is intentional — L2 and root processors share one mental model.
- Instantiation syntax is the direct call form `subgraph(args)`, mirroring L1 helpers so consumers can compose subgraphs and L1 helpers interchangeably.
- The `process` lambda's return becomes the subgraph's output and follows the same shapes as L1 helpers (single `Node<T>`, tuple, record, `void`); the instantiation expression's type is inferred from this return.
- Subgraphs may only be instantiated in declaration scope (the body of `defineProcessor` or another `defineSubgraph`, before its `process` lambda) — never inside an expression scope. Conditional output is expressed by instantiating both branches and choosing with `select`.
- Inside the subgraph body: declaration scope allows declarations and L2 instantiations; expression scope (`process` lambda) follows the same rules as L1 bodies.
- Violations are graph-capture / static-analysis errors with refactor-hint messages.

**Rationale (Q2-a):** L1/L2 inlining means the helper boundary has zero runtime cost, which is the precondition for a healthy third-party ecosystem (filters, oscillators, envelopes, FFT helpers, …) where users can compose freely without worrying about call overhead. The state/no-state split is the cleanest rule for choosing between the two; anything more implicit (auto-promotion, shape inference) blurs graph-capture vs type-inference responsibilities.

**Rationale (Q2-b):**

- *Caller-owned `State<T>` parameters*: lets a parent processor own state across multiple call sites (e.g. per-channel) and delegate logic to a single L1 helper without forcing every state-aware helper into L2.
- *Tuple / record returns*: stereo or multi-tap helpers (e.g. an SVF returning low/band/high) are common; capturing each output as an independent terminal incurs no extra cost.
- *Precision-generic helpers*: avoids forcing third-party authors to ship two definitions for f32/f64. TS generics carry no runtime cost and the no-implicit-widening rule still type-checks inside the generic body.
- *Compile-time enforcement of body constraints*: violations are detectable statically from the source position of `state.*` / `defineSubgraph` calls; surfacing them at runtime would either compromise realtime safety (errors on the audio thread) or require silent fallbacks. Refactor-hint error messages turn the constraint into actionable guidance for the helper author.

**Rationale (Q2-c):**

- *Two-scope body symmetric with `defineProcessor`*: a unified mental model for L2 and root processors. Helper authors learn one shape, error messages reference one set of scope rules, and the implementation can share graph-capture machinery between the two.
- *Direct-call instantiation*: keeps consumer-side composition syntax identical between L1 and L2 (`helper(args)` either way). Wrapping in an explicit `.instantiate(...)` would split L1 vs L2 in the consumer's mind without buying any expressiveness.
- *L1-aligned return shapes*: L2 inherits the same multi-output flexibility decided in Q2-b. No reason to constrain L2 outputs more narrowly than L1 returns.
- *Instantiation in declaration scope only*: each instantiation is a declaration of an independent state slot, so it belongs with other declarations. Allowing instantiation in expression scope makes it tempting to read subgraphs as runtime-allocated, blurring the static graph-structure guarantee. Conditional dispatch is already expressible via `select` over multiple pre-instantiated branches.

**Rejected:**

- *Single unified layer with auto-promotion* (Q2-a) — would auto-classify a function as L1 or L2 based on whether its body calls `state.*`. Makes graph capture and type inference jointly responsible for the layer decision; explicit separation isolates the rules.
- *Four+ layers (e.g. "stateful + sub-processor")* (Q2-a) — premature for v1.0.0; the rare case of needing an internal sub-processor can be assembled at the host level by composing two `defineProcessor`s.
- *Wrapping `AudioWorkletNode.connect()` as an L3* (Q2-a) — adds API surface for a thing that is already a Web Audio standard. The wrapper would either re-expose the standard verbatim (no value) or paper over its semantics (worse than direct use).
- *User-defined compile-time macros* (Q2-a) — deferred. L1/L2 cover the bulk of the third-party use case; macros can be revisited post-v1.0.0 if a concrete need surfaces.
- *L1 with no `State<T>` parameters allowed* (Q2-b) — would force every state-touching helper into L2, even simple per-channel `smoothFollow`-style functions. Adds boilerplate without isolating any meaningful invariant.
- *L1 with single-`Node<T>` return only* (Q2-b) — would force common multi-output helpers (stereo, SVF, multi-band split) into L2 or split returns, losing readability without performance benefit.
- *Precision-fixed helpers (no generics)* (Q2-b) — would force third-party authors to ship two copies of every helper for f32/f64, structurally lagging f64 ecosystem coverage.
- *Runtime-checked body constraints* (Q2-b) — would either compromise realtime safety (error on the audio thread) or silently fall back; both worse than static rejection.
- *Subgraph body with declaration and expression intermixed in the top scope (no `process` lambda)* (Q2-c) — saves 1–2 lines of boilerplate but breaks the mental-model symmetry with `defineProcessor` and gives error messages no consistent location to point at. The boilerplate cost is trivial compared to the parallel-structure benefit.
- *Explicit `.instantiate(...)` method on subgraphs* (Q2-c) — adds asymmetry between L1 helper calls and L2 instantiations on the consumer side without buying expressiveness.
- *Subgraph instantiation allowed in expression scope* (Q2-c) — makes graph structure dependent on what a `process` lambda chose to call, breaking the "instance count is statically known" guarantee. Conditional dispatch is already cleanly expressible via `select` over pre-instantiated branches.

---

## Q3 — SIMD scope for v1.0.0

**Status:** resolved.

**Decision:** authoritative wording in `00-foundations.md` §4 (vector types) and `01-dsl.md` §7 (opt-in SIMD surface). Summary:

- **Q3-a (opt-in & namespaced):** SIMD primitives and vector types are exposed exclusively via the import path `@unworklet/core/simd`. Code that does not import this path never references `Node<'f32x4'>` or any vec primitive.
- **Q3-b (v1.0.0 MVP, phased rollout):** v1.0.0 ships the minimal surface — `Node<'f32x4'>`, `vec4` / `splat` construction, `addVec` / `subVec` / `mulVec` / `divVec`, `vec.lane(i)` access (compile-time-constant index), `buf.loadVec(offset)` / `buf.storeVec(offset, value)`. The comprehensive surface (`f64x2`, `i32x4`, mask vectors, `shuffle`, comparisons, gather / scatter) rolls out additively across v1.x.0; rollout order is settled in Q14.
- **Q3-c (parallel families, not generic):** scalar (`Node<'f32'>` etc.) and vector (`Node<'f32x4'>` etc.) primitives are separate functions over separate types. `add` and `addVec` are distinct primitives; mixed scalar / vec operations are type errors and require explicit `splat` / `vec.lane(i)` conversion.

**Rationale:**

- *Opt-in via separate import path*: scalar-only authors never encounter SIMD concepts in IDE completions, type-checker errors, or code reviews. SIMD-using authors get first-class access without compromise. This is the framework's expression of "users who don't need it never see it; users who do need it have it natively" — feature reduction is not a substitute for mental-model unification.
- *Phased rollout*: shipping the minimal MVP first lets v1.x.0 extend additively based on observed user demand (which lane widths and operations show up in DSP packages first), instead of guessing the comprehensive surface up front. The MVP covers hand-vectorized 4-lane DSP — the most common SIMD shape — and downstream extensions do not break the v1.0.0 surface.
- *Parallel families over generics*: distinct scalar and vec primitives keep the scalar surface untouched (a `Node<'f32'>`-only reader never has to read `<T>` in a primitive's signature). Function names also signal "this is vectorized" at the call site, easing performance review. Cross-width generics buy little reuse and would leak SIMD existence into scalar-only callers' types.

**Rejected:**

- *No SIMD in v1.0.0 (scalar-only)* — would tell users with heavy DSP needs (FFT, multi-channel mixers, partitioned convolution) that unworklet is not for them. SIMD coverage is part of the framework's value proposition, not an optional v2 feature. Cutting it for "simpler mental model" conflated mental-model unification with feature reduction.
- *Hidden auto-vectorization (compiler decides silently)* — performance becomes implementation-defined. Users cannot predict whether a hot path is vectorized; small refactors can flip the decision. A silent perf trap is worse than an explicit surface for the users who need control.
- *Single import path with vec primitives mixed in* — would put `f32x4` and `addVec` in the IDE completion of every scalar-only author, contradicting the opt-in principle.
- *Generics across width (`add<T extends 'f32' | 'f32x4'>`)* — would make the same primitive accept scalar or vec, leaking SIMD existence into scalar-only authors' type signatures and IDE tooltips. The reuse benefit is minor; the surface-clarity loss is meaningful.
- *Comprehensive surface in v1.0.0* — premature commitment. f64x2 vs i32x4 vs mask-and-shuffle priorities are best decided after early DSP packages start using the f32x4 MVP.

---

## Q4 — MIDI integration design

**Status:** resolved (multi-port main 側 surface = `node.midi.<name>.*` の body 反 映 + canonical 修 正 は Q40 で 完 成)。

**Decision (Q4-a):** authoritative wording in `11-midi.md` §1 and §3. Summary: unworklet supports both MIDI ingestion and emission. Processors declare involvement via `midiInput({ name, capacity? })` / `midiOutput({ name, capacity? })` (either or both, both omittable). `name` is required (uniform with the other declarations: state / buffer / param / event / message); it drives main-side access (`node.midi.<name>`), snapshot schema-hash identity, and diagnostic / error attribution. The main-thread API is source-agnostic: a low-level `node.midi.<name>.send(event, atTime?)` plus a Web MIDI convenience bridge `node.midi.<name>.connectFromWebMIDI(input)` (canonical namespaced form per Q40). unworklet does not know or care where events originated; routing MIDI from any other source (DAW MIDI bridges, network, hardware, application logic) is the consumer's responsibility.

**Decision (Q4-b):** authoritative wording in `11-midi.md` §2 and §4. Summary:

- Handler registration is **type-discriminated**: `midiIn.onEvent('noteOn', handler)` etc., one handler per event type, with TypeScript narrowing the argument shape per type.
- Event type representation is **hybrid**: a `MidiEvent` discriminated union on the API surface (noteOn / noteOff / cc / pitchBend / programChange / channelPressure / aftertouch / systemRealtime / sysex), and raw MIDI status bytes on the wire. The compiler generates serializers / deserializers between the two.
- Emission primitive is **method form on the declaration: `midiOut.emitIf(cond, event)` only**. There is no unconditional `emit(event)` — every emission is structurally conditional.
- `atSample` is **always present** on handler arguments (and required in `emitIf` events). Handlers fire at the in-block sample offset, not at block boundary; sample accuracy is preserved end-to-end.

**Decision (Q4-c):** authoritative wording in `11-midi.md` §4. Summary:

- **Capacity (Q4-c-i):** ring buffers default to **256 slots** (8 bytes each = 2 KB). Override via `midiInput({ name, capacity })` / `midiOutput({ name, capacity })` (`name` required, `capacity` optional). Sized for typical use; dense MIDI / sequencer / network-driven loads override.
- **`atSample` semantics (Q4-c-ii):** **block-local** (0 through `SAMPLES_PER_BLOCK - 1`); stored as `u32` for headroom. Global timestamps are derived consumer-side via `audioContext.currentTime + atSample / sampleRate`.
- **Sysex (Q4-c-iii):** **full support in v1.0.0**. Variable-length sysex bodies live in a separate variable-length content buffer; the main ring-buffer slot for a sysex event holds the status byte plus an index into the content buffer.
- **Overflow (Q4-c-iv):** **drop-oldest + diagnostics counter**. The oldest event is overwritten on overflow, and a monotonic `overflowCount` counter is exposed on the main thread via `node.midi.<name>.diagnostics.overflowCount()` for consumer monitoring (uniform with event / message diagnostics — see Q47).

**Decision (Q4-d):** authoritative wording in `11-midi.md` §5. Summary: MIDI clock messages (`0xF8` timing clock, `0xFA` start, `0xFB` continue, `0xFC` stop) are ingested as ordinary `systemRealtime` events. unworklet does **not** provide a built-in transport API (BPM / beat position / play state); transport interpretation is **out of scope** and lives in consumer code or third-party packages. This same decision resolves Q10.

**Rationale (Q4-a):**

- *Both ingestion and emission*: MIDI-driven effects and generators (arpeggiators, sequencers, MIDI delays, harmonizers) are core production-grade audio device use cases on the web platform. Cutting emission would create a structural hole that no third-party package could fill — the feature-reduction trap conflated with mental-model unification (see `feedback_mental-model-vs-feature-reduction.md`).
- *Symmetry of cost*: ingestion and emission share wire format, transport, and sample-accurate timing machinery. Implementation cost is roughly 1.3–1.5× ingestion alone, not 2×.
- *Opt-in declaration*: processors that don't call `midiInput()` / `midiOutput()` never encounter MIDI concepts — no IDE noise, no runtime cost, no cognitive load for audio-only DSP.
- *Source-agnostic main-thread API*: keeping the surface as `.send()` plus a Web MIDI convenience wrapper avoids coupling unworklet's design to any specific MIDI source category. Application code routes whatever it wants to `.send()`.

**Rationale (Q4-b):**

- *Type-discriminated `onEvent`*: TypeScript narrows the handler argument shape per event type; authors get full IDE completion and refactoring without re-discriminating a union inside a switch. Each handler is also independently graph-captured, simplifying inlining and dead-code elimination during compile.
- *Hybrid type representation (union API / raw-bytes wire)*: gives TypeScript-first authors the type safety they came for, while keeping the wire MIDI-standard (compact, fast to parse, compatible with the byte format every audio engineer already knows). A bytes-only API would push status-byte decoding onto every author; a union-only wire would inflate transport size and cost on the postMessage degradation path.
- *`emitIf` only, no plain `emit`*: every meaningful MIDI emission is conditional (boundary, state transition, input trigger). A plain `midiOut.emit(event)` invocation in `process` would silently fire every sample (44.1 kHz) and saturate the ringbuffer — a footgun whose only "correct" form is `if (cond) midiOut.emit(event)` anyway. Forcing the conditional into the primitive's shape — as a method on the declaration — eliminates the footgun structurally.
- *`atSample` always required*: unworklet's MIDI integration exists to deliver sample-accurate events. Handlers without `atSample` discard the property the framework was built around. Carrying it unconditionally costs nothing (one number in the shape) and keeps the API uniform.

**Rationale (Q4-c):**

- *Capacity 256 default*: covers the vast majority of MIDI workloads with comfortable headroom against bursts. Override is one keyword for users with dense streams. The "user doesn't have to think" default is the unworklet stance.
- *`atSample` block-local*: "this event fires N samples into the current block" is the question DSP code naturally asks. Global timestamps require subtracting the block start as an extra step. Block-local maps directly to per-sample dispatch logic.
- *Sysex full support in v1.0.0*: sysex is part of the MIDI standard (device controllers, GM/GS/XG extensions, Universal Real Time messages). Production-grade audio devices commonly need it. Implementation cost is moderate (variable-length content buffer + length prefix); deferring would create a structural hole in the v1.0.0 surface.
- *Drop-oldest + diagnostics counter*: drop-oldest and drop-newest both break MIDI semantics (phantom note off vs hanging note); neither is "correct". The actionable design is to make overflow detectable so consumers can resize capacity or fix the upstream burst. Drop-oldest is the natural ring-buffer behavior and the simplest to implement.

**Rationale (Q4-d):**

- *Out of scope, not deferred*: transport models vary across consumer applications (phase-based, step-based, clip-driven, etc.). unworklet picking one constrains users whose context expects a different model. Keeping transport out of scope lets third-party packages serve different consumer cultures without the framework enforcing a winner.
- *Provide the raw material, not the abstraction*: ingesting `systemRealtime` events with sample-accurate `atSample` is the irreducible primitive; everything above (BPM estimation, beat-position state machines, look-ahead schedulers) can be built from it. unworklet's role ends at delivering the events.
- *Not a feature reduction*: arpeggiator / sequencer / tempo-synced LFO use cases remain fully buildable — the raw material is provided. Only the *abstraction layer* lives elsewhere; that is scope clarification, not feature reduction (see `feedback_mental-model-vs-feature-reduction.md`).
- *Multi-processor sharing already works via Web Audio*: when multiple processors need the same transport, MIDI clock can be routed via `AudioWorkletNode.connect()` or fanned out from the main thread. unworklet does not need to abstract this.

**Rejected (Q4-a):**

- *Input only (no MIDI emission)* — would structurally exclude arpeggiator / sequencer / MIDI-effect use cases, which are part of the "production-grade audio web devices" scope (see `project_unworklet-scope-framing.md`).
- *Input only in v1.0.0, Output deferred to v1.x.0* — breaks I/O symmetry from day one and forces consumers to wait for a non-trivial subset of MIDI device coverage.
- *MIDI source enumeration in unworklet's surface* (e.g. distinguishing "Web MIDI source" vs "application source" at the API level) — unnecessary specialization. A single `.send()` plus a Web MIDI convenience wrapper covers all cases without coupling to source categories.

**Rejected (Q4-b):**

- *Unified `onEvent((event) => switch (event.type) { ... })`* — forces authors to re-implement type narrowing inside a switch. Aggregating all event handling into one closure also defeats per-type graph capture and inlining.
- *Raw-bytes-only API (`{ status, data1, data2, atSample }`)* — pushes MIDI status-byte parsing onto every author and erases the value of writing in TypeScript.
- *Discriminated-union-only wire (no raw bytes underneath)* — bloats transport, especially on the postMessage degradation path, and diverges from the MIDI byte format that downstream consumers (Web MIDI Output, network bridges) expect.
- *Allowing plain `midiOut.emit(event)`* — silent footgun. Authors who forget the `if (cond)` wrap saturate the ringbuffer at sample rate. `midiOut.emitIf(cond, event)` (method form on the declaration) makes the conditional shape mandatory.
- *`atSample` as opt-in* — introduces an API split for a property that costs nothing to include unconditionally and is fundamental to the framework's stated goal (sample-accurate ingestion).

**Rejected (Q4-c):**

- *Computed-default capacity (e.g. `blockSize × 8`)* (Q4-c-i) — the user can't easily reason about the resulting size, and the formula provides no benefit over a clear constant. A simple `256` default with override is more transparent.
- *Required explicit capacity* (Q4-c-i) — adds friction to the common case where the default is fine. Users who don't need to tune capacity shouldn't have to type a number.
- *AudioContext-global `atSample`* (Q4-c-ii) — forces every per-sample handler to compute a block-relative offset to do anything useful. The natural DSP-side question is "how far into the current block?", which block-local answers directly.
- *Sysex deferred to v1.x.0* (Q4-c-iii) — leaves a structural hole in the v1.0.0 surface for production-grade audio devices. Sysex is part of MIDI; treating it as optional damages coverage.
- *Sysex variant removed entirely from `MidiEvent`* (Q4-c-iii) — unworklet's scope explicitly covers MIDI-driven web devices; dropping a standard MIDI event class is a feature reduction, not mental-model unification.
- *Drop-newest on overflow* (Q4-c-iv) — equally broken (hanging notes from dropped noteOff). Choosing it over drop-oldest does not improve safety; only detection (the counter) does.
- *Halt or throw on overflow* (Q4-c-iv) — would crash the audio thread on a recoverable condition. The realtime-safe behavior is to drop and report.

**Rejected (Q4-d):**

- *Built-in `useTransport()` API in v1.0.0* — picks one transport model (BPM-and-beats, or phase-based, etc.) at the framework level, constraining users whose DAW context expects a different model. Premature commitment.
- *Built-in transport "deferred" to a later v0.x* — implies unworklet eventually adopts one. The framework-level decision is that transport is the consumer's territory, full stop. "Deferred" sends the wrong signal about the project's scope.
- *MIDI clock messages dropped from `MidiEvent`* — eliminates the raw material. arpeggiator / sequencer / tempo-synced LFO use cases would become unbuildable on unworklet alone, which is a feature reduction trap.

---

## Q10 — Transport / tempo sync convention

**Status:** resolved — out of scope (third-party domain).

**Decision:** unworklet does not provide a built-in transport API (BPM, beat position, play state, look-ahead scheduler, etc.). MIDI clock messages are delivered as ordinary `systemRealtime` events through the standard MIDI ingestion path; any abstraction above that lives in consumer code or third-party packages.

This is settled together with Q4-d — see the Q4-d Decision / Rationale / Rejected entries above for the full reasoning.

Authoritative wording: `11-midi.md` §5.

---

## Q5 — State snapshot / restore API

**Status:** resolved.

**Decision (Q5-a):** unworklet ships a state snapshot / restore API in v1.0.0. It exposes the linear-memory contents of a running processor as a `Uint8Array` blob that can be persisted, transmitted, and written back. Authoritative wording: `01-dsl.md` §3, §8 + `05-client.md` §2.6, §6.

**Decision (Q5-b):** authoritative wording in `01-dsl.md` §3, §8.1–§8.2. Summary:

- Each `state` / `buffer` / `param` declaration accepts a `name` field and a `snapshot` field.
- `name` is required when the parent processor calls `snapshot()` (graph-capture-time error otherwise). Subgraph instances also require `name`; slot identity is the slash-joined path from the root.
- `snapshot` is one of `'persistent' | 'transient' | { [profile: string]: 'persistent' | 'transient' }`. Default is `'persistent'` for `state` and `param`, `'transient'` for `buffer`.
- Profile names are user-defined; the framework reserves no names. The set of profiles is the union of keys appearing in declarations.
- `node.snapshot()` (no arg) includes any slot that is `'persistent'` for *any* profile; `node.snapshot({ profile })` includes only slots `'persistent'` for that named profile.
- AudioParam automation queues are not preserved across snapshots — only the current `.value`.

**Decision (Q5-c):** authoritative wording in `05-client.md` §2.6. Summary:

- The single surface shape is `Uint8Array` for both `snapshot()` (output) and `restore()` (input). No JSON-ish or structured-object form on the API.
- v1.0.0 ships an `inspect(blob): InspectionResult` helper for debug and preset-library construction. `inspect` is read-only.
- The blob's binary layout (header, slot table, schema hash) is the framework's internal representation; consumers do not parse it directly. Migration helpers (`parseSlot` / `parseBuffer` / `parseParam` in §8.3.1) are the supported way to read blob contents.

**Decision (Q5-d):** authoritative wording in `05-client.md` §6. Summary:

- `snapshot()` and `restore()` are **block-atomic**: state changes do not happen mid-block, and snapshot reads never observe a half-updated linear memory.
- Synchronization uses a flag protocol (Atomics on SAB, postMessage flags otherwise). Audio-thread cost is one `memcpy` per acquired snapshot or restored blob, not per block.
- `await node.snapshot()` resolves after the snapshot region has been read into a `Uint8Array`. `await node.restore(blob)` resolves at the moment the new state takes effect for subsequent samples (not when the blob was handed off).
- API surface is identical with or without SAB; transport implementation differs (shared region + Atomics vs pre-allocated `Uint8Array` + postMessage transfer). Realtime safety is preserved in both modes.
- The framework does **not** provide audio fade / crossfade. State changes block-atomically; smoothing musical discontinuity is consumer territory. The crossfade-via-`GainNode` pattern is documented as a recipe in `05-client.md` §6.4.

**Decision (Q5-e):** authoritative wording in `01-dsl.md` §8.3. Summary:

- Each blob carries a `schemaHash` derived from the processor's declarations (slot set, types, profile flags, sizes) computed at compile time. The current `schemaHash` is emitted to `dist/schema-hash.json`.
- Restore handles three levels of mismatch:
  - **(a) detection**: blobs from incompatible schemas never silently corrupt — the framework either migrates, partial-restores by name, or rejects with a structured error.
  - **(b) name-match partial restore**: when no migration is registered, slots that share name and compatible type are written back; missing / mismatched slots are reset and reported in `RestoreResult.{ skipped, missing }`.
  - **(c) declarative migration chain**: developers register `migrations: [{ from, to, migrate }, ...]` as a field on the `defineProcessor` options bag; the framework walks the resulting directed graph from `blob.schemaHash` to `currentSchemaHash`, applying entries in order with hash verification at each step. Adjacent `from → to` steps chain automatically — N-version-skipping migrations work without rewriting earlier steps (ORM-style).
- Compile-time validation: hash format, no duplicate `from`, no cycles, current-schema reachability. Reachability failure is a build warning by default; `{ migrationsStrict: true }` makes it an error.
- `migrate` receives `MigrationHelpers` (parse / write for slot / buffer / param, profile-scoped variants, metadata). Slots not explicitly written are auto-carried from the old blob to the new blob when name and type match in both schemas.

**Rationale (Q5-a):**

Preset save/load and session restore are foundational to the kinds of audio devices unworklet exists to enable. Cutting them ("the consumer can serialize params themselves") would force every processor author to hand-build a state-marshalling layer on top of the framework's primitives — exactly the kind of structural hole that turns a foundation into a toolkit users must complete. The TS-first / graph-capture design also makes the slot-table emission essentially free (compile-time reflection over declarations), so the cost is in implementation not API design.

**Rationale (Q5-b):**

- *Declaration-side `snapshot` flag*: lets the slot itself carry its persistence policy. Centralizing the policy at the declaration site means refactoring a slot does not silently change preset semantics elsewhere.
- *`'persistent'` default for `state` / `param`, `'transient'` default for `buffer`*: tracks the typical case (scalar / param values are usually load-bearing for preset identity; buffers are usually accumulation regions). The default minimizes the amount of `snapshot:` annotations a typical author writes, while leaving full control on either side.
- *Per-profile record form*: the same slot can have different persistence in different contexts (a delay line is `'transient'` for preset-save, `'persistent'` for session-restore). A binary `'persistent' | 'transient'` only would force consumers to maintain parallel processors or post-process blobs — both worse than letting declarations express the dimension natively.
- *User-defined profile names*: `'preset'` and `'session'` are conventions in some DAW cultures, but every host / plugin format / app has its own taxonomy. Reserving names at the framework level would constrain consumers; user-defined names route the constraint to where it belongs (the consumer's data model). Same shape as Q4-d's "deliver the raw material, leave the abstraction to consumer culture" pattern.
- *Auto-collection of profile keys*: graph capture already enumerates declarations to build the slot table; deriving the profile set as a free byproduct keeps the surface declarative and avoids a separate "register profile" step.

**Rationale (Q5-c):**

- *`Uint8Array` blob surface*: a single canonical form keeps the API minimal. `Uint8Array` is universally transportable (IndexedDB, fetch, postMessage, file system, network), maximally compact, and stable across runtime versions in a way that JSON-ish surfaces are not.
- *Read-only `inspect(blob)` in v1.0.0*: debug ergonomics are crucial for preset-library tooling. Shipping the read side from day one eliminates the "I have a blob but no way to look inside" moment without committing to a writable structured form (which would compete with the canonical surface and create two paths to maintain).
- *No structured-object form for write*: would create an alternative source-of-truth for blob contents, with parallel validation paths and migration logic. The blob is the SSoT; new blobs are constructed via `snapshot()` or migrations.

**Rationale (Q5-d):**

- *Block-atomic semantics*: anything sub-block creates either race hazards (main reads partially updated memory) or audible discontinuities (state changes mid-render quantum). Block-atomic is the unique boundary that satisfies both, and it falls naturally out of the audio-thread's render quantum cycle.
- *Flag-based synchronization*: avoids any blocking on the audio thread. The audio thread checks a flag once per block; the cost is a single load per quantum and a `memcpy` only when an operation is in flight. No mutexes, no `Atomics.wait` on the audio side.
- *Promise resolves on application, not handoff*: the consumer's natural mental model is "after `await restore(blob)`, the state is the blob". Resolving on handoff would create a 1-block window where consumers could see stale state, leading to subtle bugs in code like `await restore(); doSomething();`.
- *No built-in fade / crossfade*: musical smoothing is fundamentally a consumer concern (live vs studio context, scene length, curve preference). Embedding one choice in the framework would force consumers whose context expects a different choice to fight the framework. The crossfade-via-`GainNode` pattern is well-known and composable; documenting it as a recipe in §6.4 covers the canonical case without locking it in as API.

**Rationale (Q5-e):**

- *Hash-based schema identity*: derived from declarations at compile time, so it tracks the actual schema state rather than a manually maintained version number. Developers cannot forget to bump it; renames or type changes automatically yield a different hash.
- *Adjacent `from → to` chain (ORM-style)*: lets developers write each schema change once. N-version-skipping migrations work without re-deriving combined transforms — the graph traversal handles arbitrary skips. This is the only design that scales to long-lived plugins (DAW sessions can be opened years after authoring).
- *Three-level fallback (migrate → name-match → declaration default)*: each level handles a distinct severity of mismatch. Migrate covers schema-aware transforms; name-match covers small additions / removals where slot names survived; declaration default covers slots the blob never had. Together they ensure `restore()` never silently corrupts state and always produces a defined result.
- *Reachability validation as build-time warning, not error*: many schema changes are simple additions where name-match restore is sufficient. Forcing a migration entry for every such change would be friction for the common case. `{ migrationsStrict: true }` lets stricter teams elevate it.

**Rejected (Q5-a):**

- *Defer snapshot/restore beyond v1.0.0* — would force every preset-needing processor to implement state marshalling on top of primitives, leaving a structural hole at the foundation. The cost is in implementation, not in API design (TS-first reflection makes the slot-table emission near-free).
- *Surface only `param` snapshots, leave state/buffer to consumer* — would silently lose internal state (filter z1, oscillator phase, sequencer step), so "loading a preset" would not actually reproduce the same sound. Not a real preset semantics.

**Rejected (Q5-b):**

- *Single `'persistent' | 'transient'` flag, no profile concept* — would force consumers to maintain two separate processors (one for preset, one for session) or to post-process the blob to drop unwanted slots. Both worse than letting declarations express the dimension natively. The "minimal v1.0.0 + add profile in v1.x.0" path was a defer trap (see `feedback_no-preemptive-defer.md`); the per-profile record is shape-on-API and additive insertion would create a two-tier mental model.
- *Framework-reserved profile names (`'preset'`, `'session'` as enums)* — picks a specific consumer-application taxonomy at the framework level, constraining consumers whose context expects a different model. Same trap as Q4-d.
- *`'persistent'` default for `buffer`* — would cause large delay lines / FFT scratch buffers to bloat preset blobs by megabytes for the typical case, when the contents are usually irrelevant to preset identity. `'transient'` default with explicit `'persistent'` for wavetables tracks intent more closely.
- *No `name` requirement* — would force the framework to identify slots by source position or AST hash, both of which break under refactoring (reordering declarations, extracting helpers). Explicit names give the developer a stable identity over time.

**Rejected (Q5-c):**

- *Structured-object surface (e.g. `node.snapshot(): Promise<{ slots: Record<string, ...> }>`)* — would compete with the blob as SSoT, creating two parallel paths for serialization, validation, and migration. The blob is the SSoT; structured views are read-only debug helpers.
- *Defer `inspect()` to v1.x.0* — debugging blob contents is a day-one ergonomics need; deferring it would push every author to guess at blob layouts. The implementation cost is small (the slot table is already in the blob), so deferring fails the "is this defer constructive?" test (`feedback_no-preemptive-defer.md`).
- *JSON-text blob form alongside `Uint8Array`* — would force two encodings, two parsers, and two validation paths. The `inspect()` helper covers the human-readable need without doubling the surface.

**Rejected (Q5-d):**

- *Sub-block (sample-accurate) snapshot/restore* — would either require pausing the audio thread (breaking realtime safety) or admit observable mid-quantum state updates (audible discontinuities, race hazards on multi-slot reads). Block-atomic is the realtime-safe boundary.
- *`silent: true` option (output silence during the transition block)* — replaces one discontinuity (state change at block boundary) with another (output drop to zero), so it does not solve the underlying click-on-jump problem. `GainNode`-based crossfade in user code does solve it, and is documented as the canonical pattern in §6.4.
- *Built-in fade with configurable curve / time* — would require the framework to commit to one or more curve families (linear / equal-power / exponential / S-curve) and a default fade time, both of which vary by consumer culture (live vs studio, scene transitions vs AB compare). Q4-d's "raw material, not abstraction" pattern applies.
- *`restore()` Promise resolves on handoff (before audio thread applies)* — creates a 1-block window where consumers could observe pre-restore state, breaking the natural `await restore(); doSomething();` mental model. Resolving on application is the semantically clean choice.

**Rejected (Q5-e):**

- *Single-step migration only (each `migrate` directly produces the current schema)* — works for one schema change but forces developers to rewrite migrations for every prior schema each time the schema changes. Does not scale to long-lived plugins. The chain form lets adjacent steps compose.
- *`fromHash` only, no `toHash`* — leaves the framework guessing at intermediate schema states, so chain validation cannot verify that adjacent migrations actually compose correctly. Explicit `from`/`to` makes errors detectable at build time.
- *No reachability validation* — silently allows unreachable schemas, where users with old blobs hit "blob format error" at runtime instead of seeing a build warning. Build-time validation is cheap and catches the developer before users do.
- *Manual schema versioning (developer maintains a `version: 3` field)* — fragile (developer forgets to bump on schema-changing PRs), error-prone, and decouples version identity from actual schema content. Hash-derived identity is automatic and tracks reality.
- *Auto-migrate everything (including type changes)* — lossy and silent. A type widening (`f32 → f64`) is reasonable to auto-handle, but a type narrowing or unit change is application-specific. The migration `migrate` callback is the right place for those decisions; making them implicit hides intent.

---

## Q6 — Multi-output processors

**Status:** resolved.

**Decision:** authoritative wording in `01-dsl.md` §1. Summary:

- **Declaration helpers**: `audioInput({ channels, name })` and `audioOutput({ channels, name })` live in declaration scope only. Same pattern as `state` / `buffer` / `param`. Calling them in expression scope is a graph-capture-time error.
- **Always explicit**: a processor has no audio I/O unless it declares it. No "default mono in / default mono out" sugar; no implicit return-value-as-output shortcut. Every audio port is a declaration.
- **Required `name`**: every `audioInput` / `audioOutput` must carry a `name`. Names are slot identities for the port and the keys for main-thread typed access.
- **Typed channel access**: `audioIn.at(c, i)` narrows `c` to the legal range for the declared channel count (`channels: 2` → `0 | 1`); `audioOut.set(c, i, v)` narrows `c` and types `v` as `Node<'f32'>`. Both are checked at TypeScript / graph-capture time. Sample-position primitives (`at` / `set`) are valid only inside `forSample` callbacks (Q22-b); the `i` argument is the callback parameter, scoped accordingly. There is no sugar form (`read(c)` / `write([...])`) — see `decisions-log.md` Q22 (Q22-b) for the rationale.
- **Multi-port support is symmetric**: any number of inputs and outputs can coexist with arbitrary channel counts; the count is the declaration count, mapped directly to Web Audio's `numberOfInputs` / `numberOfOutputs` and `outputChannelCount[]`.
- **Main-thread typed access**: `node.inputs.<name>` and `node.outputs.<name>` provide typed `connect()` / be-connected-to wrappers over the underlying `AudioWorkletNode`. The raw `AudioWorkletNode` is always reachable as `node.node` for advanced patching.

**Rationale:**

- *Declaration helper pattern over `ctx.inputs[i][j]` / `ctx.outputs[i][j]`*: the index-based form (a direct mirror of Web Audio's array-of-array I/O) does not narrow in TypeScript and gives no slot identity for tooling, snapshot, or main-thread access. The declaration pattern produces a typed handle, a stable name, and a uniform mental model with state/buffer/param.
- *Always explicit (no default sugar)*: shipping a "declarations-zero processor returns a `Node<'f32'>` that becomes a default mono output" shortcut would make the API contract of `process` depend on whether declarations exist — two mental models for one feature, and a refactoring cliff when a single-output processor grows a second output. Forcing every processor to declare its I/O explicitly makes the shape stable and the rule one-line.
- *Required `name` even for single I/O*: integrates with the slot-identity rule for snapshot (Q5), keeps main-thread access readable (`node.outputs.main` over `node.outputs.out0`), and matches the convention authors already use mentally when writing the processor.
- *Typed channel access*: leveraging TypeScript's literal types for `channelIndex` and tuple length for `write()` catches a class of bugs (off-by-one channel access, mismatched stereo writes) at edit time rather than runtime — exactly the value proposition of TS-first DSP authoring.
- *Pass-through to Web Audio mixing rules for input channel matching*: the source side of an `AudioWorkletNode` connection is governed by Web Audio's standard `channelInterpretation` / `channelCountMode`. Re-implementing that mixing logic in unworklet would either diverge from spec (surprise) or duplicate behavior already provided by the host (waste). The declaration's `channels` is the worklet's view; sources are normalized to it by the host.
- *Raw `AudioWorkletNode` accessible as `node.node`*: typed wrappers are sufficient for the common cases, but consumers patching unusual graph topologies (input rate-converters, dynamic re-routing, channel splitter/merger nodes) need the raw node. Hiding it would cripple advanced use; exposing it costs nothing.

**Rejected:**

- *Index-based `ctx.outputs[i][j]` API* — direct mirror of Web Audio's I/O array structure, but (1) yields no TypeScript narrowing, (2) gives no slot identity for naming / snapshot / typed main-thread access, (3) does not match the declaration pattern that already governs state/buffer/param. The "Web Audio purism" benefit is hollow because the framework already abstracts most of Web Audio anyway.
- *Default mono in / mono out sugar (declarations-zero processor)* — saves a few lines for the simplest example but introduces a two-mode API contract (declarations or no declarations) and a refactoring cliff. The boilerplate cost is paid once per processor file, the mental-model cost is paid every time someone reads code. The trade-off is one-sided.
- *Optional `name` with default `'in0'` / `'out0'`* — generates names that read worse than the explicit form and split the slot-identity rule (snapshot already requires explicit names; making audio I/O optional creates a two-tier rule for the same concept).
- *Process lambda return value as the default output* — clean for trivial cases but conflicts with the L1 helper return-shape rules (`01-dsl.md` §5.5.3) where return values become independent graph terminals. Reusing the same return-shape grammar for two different purposes (helper terminals vs default audio output) creates an ambiguity that has to be resolved by special cases.
- *`channels: number` validated only at runtime* — undermines TS-first authoring; the framework's job is to surface DSP bugs at edit time, not to discover them via console errors after a deploy.

---

## Q7 — Sub-rate computation

**Status:** resolved (delivery shape は Q43 で `forSample` callback 第 2 引 数 経 由 に refine)。

**Decision:** authoritative wording in `01-dsl.md` §9. Summary:

- **Single primitive `everyNSamples(N, callback)`** delivered as the **second argument of the `forSample` callback** (Q43, refining the earlier free-function shape): `forSample((i, everyNSamples) => { everyNSamples(N, () => ...) })`. The same form applies to `forSample.byN`. Out-of-`forSample` use is impossible because `everyNSamples` is simply not in scope there — TypeScript reference error, no separate context check needed.
- **Graph-capture-time meta primitive**: the callback body is evaluated once during graph capture; the resulting nodes are recorded as belonging to an `N`-rate sub-block. Compiled into a WASM branch keyed off the processor's internal sample counter.
- **State slots inside the callback** hold their value between updates (zero-order hold). Reading them in the audio-rate body returns the most recent stored value.
- **No new declarations inside the callback**: callback body is an expression scope; declarations are graph-capture-time errors. Same rule as L1 / subgraph `process` bodies.
- **Multiple sub-rate blocks coexist** at any divisor, sharing the global sample counter, executing independently.
- **Orthogonal to `AudioParam` automation rate**: `param({ automationRate, ... })` continues to be Web Audio's standard k-rate / a-rate; `everyNSamples` is purely about *internal* state-update rate. Reading an `AudioParam` value at a coarse rate is expressed by wrapping the read in an `everyNSamples` callback and storing into a `state` slot.
- **CPU spike is consumer responsibility**: `everyNSamples` reduces average CPU but not worst-case. Spike smoothing (partitioned algorithms, cross-processor offload) is application-level. Q9 (cross-processor communication) is the natural escape hatch for heavy out-of-band computation.
- **v1.0.0 scope**: only `everyNSamples(N, callback)` ships. Future primitives in the same family (`everyTimeMs`, `atSampleRate`, etc.) are additive in v1.x.0 — sample-count-based rate-down is the foundation; alternative units are layered helpers.

**Rationale:**

- *Single primitive over multi-axis declaration*: `everyNSamples` is the smallest surface that covers the entire rate-down use case (LFO, envelope, mod matrix, FFT, automation rate-limiting, etc.). Adding a second declaration kind (case C: `controlState` + `controlProcess`) would force users to learn two parallel models for one concept; the callback form keeps the existing `state` / `buffer` / `param` declaration kinds untouched and adds one expression-scope primitive.
- *Callback form over `if (slot.shouldUpdate())`*: unworklet's core rule prohibits JS `if` as a runtime branch in `process` bodies (control flow is `select`-based). Building rate-down on top of a meta-`if` (case B) would create a special case that contradicts the rule and confuses readers. The callback form makes "this is a graph-capture-time meta primitive" visible in the syntax (`everyNSamples(N, () => ...)`) and contains the special semantics inside that primitive.
- *Callback form over expression-level rate annotation* (case H: `kRate(expr, { divisor })`): rate annotation on a single expression makes multi-statement sub-blocks (FFT stages, multiple correlated state updates) awkward — the user has to bundle them into one expression. The callback form admits any number of statements naturally.
- *Hold semantics on `state.load()` between updates*: zero-order hold is the simplest and most predictable interpolation; framework-provided linear interpolation would commit to a specific smoothing curve that may not match the consumer's needs. Consumers wanting smoothing can write it explicitly (a one-pole IIR over the held value, for instance).
- *Sample-count `N` over time-unit `ms` for v1.0.0*: sample count is the audio thread's natural unit and avoids hidden conversions when sample rate changes. Time-unit primitives (`everyTimeMs`) are useful but build on top of sample-count rate-down — adding them in v1.x.0 does not change the underlying mechanism.
- *Orthogonality with AudioParam automation*: clean separation lets each layer evolve independently. AudioParam automation is Web Audio's territory (and rate-of-arrival is its language); rate-of-internal-computation is unworklet's territory. Mixing the two would require either embedding AudioParam logic into `everyNSamples` or hijacking `automationRate` for sub-rate work — both worse than the orthogonal design.
- *CPU spike not absorbed by the framework*: spike-flattening (partitioned algorithms, dual processors) is application-pattern-specific and depends on tradeoffs (memory, latency, code complexity) only the consumer can resolve. Forcing a flattening strategy into the framework would over-generalize.

**Rejected:**

- *Case A — no rate-down support* — would force users to write `select(eq(mod(c, N), 0), expr, prevValue)`, which two-side-evaluates `expr` every sample due to `select` semantics. Cannot rate-down heavy work (FFT, neural inference); structurally cripples the production-grade audio processors that unworklet exists to enable. Same trap as the once-considered "no SIMD in v1.0.0" path (Q3).
- *Case B — `state.f32(..., { updateEvery: N })` + `if (slot.shouldUpdate())`* — needs a graph-capture-time meta-`if` to work, contradicting unworklet's "no JS `if` in process body" rule. The callback form (case D) achieves the same outcome without breaking the rule.
- *Case C — `controlState` + `controlProcess` two-layer model* — adds two new declaration kinds (`controlState`) and a new lambda (`controlProcess`) to express something that fits in one expression-scope primitive. Heavier on learning and on graph-capture machinery; no expressiveness gained over case D.
- *Case E — implicit rate-flow analysis* — relies on framework inference to decide which expressions can be evaluated at coarser rates. Cannot express forced rate-down at arbitrary divisors (only the implicit a-rate / k-rate boundary), and the implicit decision-making makes performance unpredictable to the user.
- *Case H — `kRate(expr, { divisor })` expression-level annotation* — works for single-expression rate-down but bundles multi-statement sub-blocks (FFT stages, correlated state updates) into one expression awkwardly. The callback form composes statements naturally.
- *Auto-flatten CPU spikes inside `everyNSamples`* — would require the framework to decompose user-supplied work into per-sample increments. The decomposition strategy depends on algorithm structure (FFT butterflies, neural-net forward passes, etc.), which the framework cannot infer. Leaving spike management to user code (partitioned algorithms, cross-processor offload via Q9) keeps the primitive simple and lets consumers pick the right pattern.
- *Time-unit primitives (`everyTimeMs`) in v1.0.0* — additive without changing the underlying mechanism (sample-count rate-down). Shipping them in v1.x.0 is non-blocking; deferring is consistent with `feedback_no-preemptive-defer.md` (PoC + parallel agent extension category — sample-count is the foundation primitive, time-unit conversion is a layered helper).

---

## Q8 — Multi-block lookahead

**Status:** resolved — out of scope.

**Decision:** unworklet core does not provide built-in lookahead abstraction. No `audioInput({ lookahead: N })` declaration option; no `node.latency` property; no `defineSubgraph({ latency })` annotation; no compile-time auto-delay insertion; no main-thread `UnworkletManager` mechanism. Authoritative wording: `05-client.md` §7 (recipe for application-side latency compensation).

The raw materials needed to author lookahead-style processors are already in the framework:

- `buffer.f32` for the ring buffer that stores past samples (and provides "future" reads via offset arithmetic against the write position).
- `state.i32` for the write-position counter.
- L1 helper functions and `defineSubgraph` for packaging this pattern into reusable building blocks (e.g. a third-party `lookaheadInput` helper distributed in a downstream DSP package).
- `audioContext.createDelay(...)` on the main thread for application-side latency compensation between processor instances and against parallel paths.

Cross-processor latency compensation is fundamentally application territory in the web platform. Web Audio defines no plugin-latency-reporting API and no host-level automatic compensation; any framework abstraction is forced to either re-implement DAW-host-style coordination (which conflicts with `AudioContext` graph ownership) or remain a partial / opaque solution. Both fail.

**Rationale:**

The scope decision rests on two structurally inseparable points:

1. **Web platform constraint**: Web Audio's `AudioContext` is the graph owner. Plugin-level latency reporting and automatic compensation are not part of the spec, and any framework that bolts a parallel coordinator on top runs into AudioContext / framework dual-ownership conflicts that cannot be resolved cleanly. unworklet's `project_unworklet-scope-framing.md` explicitly lists "latency reporting" as out of scope; this decision affirms that boundary.
2. **Framework declarative philosophy**: any abstraction that auto-inserts delay or rewrites user-authored graphs at compile time violates unworklet's core principle ("the user writes the graph; the compiler emits exactly that graph"). The convenience comes at the cost of debug transparency, consumer-culture independence, and the contract that "code in equals graph out" — see `feedback_framework-magic-anti-pattern.md`.

The raw materials (`buffer`, `state`, `defineSubgraph`, `audioContext.createDelay`) are sufficient to express any lookahead-style processor and any application-level compensation pattern. The "cost" of writing the wiring explicitly is paid back by debugability, predictability, and consumer freedom to pick whichever latency-compensation strategy suits their context (live performance, studio session, scientific phase-precise composition, etc.). This matches the pattern established for transport (Q4-d), snapshot profiles (Q5-b), and sub-rate computation interpolation (Q7): "deliver the raw material, leave the abstraction to consumer culture."

**Rejected alternatives** (each was considered and analyzed against the framework's core philosophy):

- *Direction B — `audioInput({ lookahead: N })` declaration option + internal ring buffer + `node.latency` property*. The internal ring buffer is a thin wrapper over `buffer.f32` + `state.i32` that the user can write themselves; the `node.latency` property has no real consumer (a processor's author already knows its latency at authoring time, and no automatic compensation hooks into it). The option's value collapses to "syntactic sugar for ring buffer wrapping", which is L2-helper-level work, not core-framework work.

- *Direction C — Main-thread `UnworkletManager` coordinator that automatically inserts `DelayNode`s into the audio graph*. Conflicts with `AudioContext` graph ownership (dual API / dual state-tracking with no clean resolution); cannot handle non-unworklet `AudioWorkletNode`s or other Web Audio nodes (partial solution); directly contradicts the "latency reporting out of scope" boundary in `project_unworklet-scope-framing.md`; commits the framework to one specific compensation strategy (min-latency vs branch-isolated vs aligned) at the expense of consumer culture; and would require the framework to own graph viz / debug surfaces that are normally a host's responsibility.

- *Direction D — `defineSubgraph({ latency: N }, ...)` annotation + compile-time graph latency analysis + automatic `DelayLine` insertion in WASM emission*. Violates the framework's core declarative philosophy: user-authored graphs would be silently rewritten with delay nodes the user did not write. Debug transparency is destroyed (the WASM graph diverges from the source code); declared-vs-actual latency mismatches in subgraphs become silent correctness bugs; the framework picks a compensation strategy on the consumer's behalf. The "convenience" appeal of this direction is exactly the warning signal flagged in `feedback_framework-magic-anti-pattern.md`. Direction D is a cleaner-looking variant of Direction C's core failure (framework taking ownership of graph rewriting that should remain explicit user authorship).

- *Direction E — Implicit rate-flow / latency-flow analysis*. Same family of objections as D: silent graph rewriting, opaque debug surface, framework picking strategies on the consumer's behalf.

**The "out of scope" conclusion is reached by full enumeration of the option space, not by giving up.** Each direction was structurally evaluated against the framework's philosophy, the web platform's constraints, and the unworklet scope statement, and each fails on at least one of those axes. The raw materials in unworklet are sufficient.

This decision does not preclude third-party DSP packages from publishing reusable `lookaheadInput`-style L2 helpers built on `defineSubgraph` + `buffer` + `state`. Those are downstream work, governed by package authorship conventions, and explicitly outside unworklet's core surface.

---

## Q9 — Cross-processor communication

**Status:** resolved — out of scope.

**Decision:** unworklet core does not provide a built-in mechanism for direct audio-thread-to-audio-thread communication between `AudioWorkletNode`s (= the case where two `AudioWorkletProcessor`s share state via `SharedArrayBuffer` without going through the main thread). Authoritative wording: this entry.

The umbrella "cross-processor communication" decomposes into five use cases; four are already covered elsewhere, leaving only one for this scope decision:

- (a) Unidirectional **audio signal** between processors → covered by Web Audio's `connect()` and unworklet's typed wrappers (`node.outputs.<name>.connect(otherNode.inputs.<name>)`, see Q6).
- (b) **Side-chain audio** (a separate audio path consumed as `audioInput`) → same as (a).
- (c) Cross-processor **message / event** delivery → main-thread-relayed via the generic typed messaging surface (`node.events.<name>.on(...)` of one processor wired into `node.messages.<name>(...)` of another). The generic messaging core surface itself is tracked as a separate (not-yet-grilled) question in the backlog and is **not** out of scope.
- (d) Cross-processor **shared state via direct SAB sharing between audio threads** (no main-thread relay, no audio routing). This is the one Q9 specifically rules on. **Out of scope** — see rationale.
- (e) **Heavy computation offload** to a parallel processor → covered by (a) at the routing level. Choice of computation strategy (partitioned algorithm, dedicated processor, etc.) is consumer territory.

**Rationale:**

- Web Audio defines no spec-level mechanism for audio-thread-to-audio-thread direct communication. SAB sharing between two `AudioWorkletProcessor`s is technically possible by passing the same SAB through `processorOptions` to both, but the protocol (atomics, ring-buffer layout, lifetime, discovery) is application territory.
- Any framework abstraction that wraps SAB sharing for two unworklet processors needs main-thread wire-up to discover the channel and inject the SAB into both `processorOptions`. That wire-up either (i) happens implicitly in a manager-style coordinator (which conflicts with `AudioContext` graph ownership and consumer-culture independence — same trap as Q8 Direction C) or (ii) is left explicit on the user, in which case the abstraction's value collapses to a thin SAB ring-buffer wrapper, which is L2-helper-level work, not core-framework work.
- The "direct SAB sharing" use case is narrow in practice: most cross-processor needs fall into (a)/(b)/(c)/(e) which are already covered. The remaining cases (e.g. low-latency shared LFO read by multiple processors) are addressable by either routing as audio (a) or relaying through main thread (c), with negligible practical loss.
- Holding to scope here is consistent with `feedback_framework-magic-anti-pattern.md`: framework-managed graph composition that the user did not write themselves is rejected. SAB sharing between processors is exactly such a hidden-by-framework wiring if abstracted at the core level.

**Rejected alternatives:**

- *`crossProcessorChannel` declaration helper that auto-shares a SAB ring buffer between two processors* — relies on a main-thread coordinator to embed the same SAB into both `processorOptions`. Either the coordinator is implicit (= the framework wires it behind the user's back, hitting the same trap as Q8 Direction C) or explicit (= the user writes the wire-up, in which case the abstraction is just a thin SAB-API wrapper, L2-helper-level).
- *Compile-time type-safe channel binding* (`defineChannel<'f32'>(...)` paired between two processors with framework-managed runtime SAB injection) — same coordinator problem; the type-checking layer doesn't change the runtime wire-up issue.
- *`UnworkletManager`-style cross-processor coordinator* — fully equivalent to Q8 Direction C with the same rejection profile (AudioContext dual ownership, consumer-culture lock-in, scope-statement contradiction).

**Recipe (out-of-scope but consumer guidance)**: applications that need audio-thread-to-audio-thread SAB sharing pass the same `SharedArrayBuffer` through both processors' `processorOptions` and implement their own atomics protocol. A worked example may land as a recipe in `08-deployment.md` if a downstream case justifies it; otherwise consumers can author this directly as part of their application code.

The generic typed messaging core surface (referenced above as case (c)'s underlying mechanism) is specified in Q27.

---

## Q22 — Graph capture model and process body structure

**Status:** resolved (Q22-a / Q22-aprime / Q22-b / Q22-c three-layer structure fixed; **Q22-d error message format も resolved** (= 03-compiler §2.5 で Rust-style template 確 定、 後 述); Q22-c-Round2 = subgraph instantiation scope = 別 件 で Q34 で 解 決 済 み; Q22-b 不 変 量 「sample-offset primitive は forSample 内 限 定」 は Q36-a で 「forSample 内 で 計 算 し た `i` を 受 け 取 る」 と 再 定 義、 literal `0` per-block 呼 び は Q36 の method 引 数 literal lift で 型 と 整 合).

**Decision (Q22-a — Mental model):** authoritative wording in `00-foundations.md` §3 + `03-compiler.md` §2. Summary:

- The `process` lambda is **a meta-program evaluated once at build time**. Calls inside its body — `add`, `mul`, `state.load()`, etc. — construct AST nodes; arithmetic does not execute, audio is not read, state is not stored. The lambda's role is to assemble a graph DAG that captures the user's intent.
- The framework emits the captured DAG as a per-block runtime program: top-level statements run once at the start of every render quantum (per-block phase); statements inside `forSample` callbacks run per sample. The audio thread executes the WASM; user TypeScript is not re-entered per sample or per block.
- **Build-time JavaScript is real JavaScript.** `if`, `for`, `+`, `*`, `Math.*` over build-time values (literals, build-time constants, results of static computation) execute normally and shape the captured graph statically. Compile-time loop unrolling, debug-flag pruning, and constant precomputation are first-class authoring patterns, not workarounds.
- **`Node<T>` is incompatible with JavaScript operators at the type level.** Branded types reject `nodeA + nodeB`, `if (nodeBool) { ... }`, `for (... ; nodeCmp ; ...)`. The author writing such code gets an immediate TypeScript type error in the IDE, before any build runs. The framework leverages TS's type system as an **educational lever** that directs authors to `add` / `mul` / `select` without needing runtime checks or lint rules.

**Decision (Q22-aprime — Process body structure):** authoritative wording in `01-dsl.md` §1, §10. Summary:

- A processor's `process` body has **two execution phases** distinguished by **lexical position**:
  - **Per-block phase** — statements at the top level of the `process` body. Run once at the start of every render quantum on the audio thread.
  - **Per-sample phase** — statements inside a `forSample(callback)` or `forSample.byN(stride, callback)` invocation. The callback body runs once per sample (or once per `stride` samples) of the render quantum.
- The `process` body is read **top-to-bottom**: each statement (whether direct per-block code or a `forSample` invocation) executes in declared (source) order. Multiple `forSample` invocations interleaved with per-block statements produce a multi-phase processor — every phase runs in source order.
- **`forSample` is the only sample-loop primitive.** No separate `perBlock` primitive exists; the per-block phase is denoted by being **outside any `forSample` callback** in the `process` body. This eliminates "where does this statement run?" as a question — the answer is always determined by the lexical scope (inside `forSample` → per-sample, outside → per-block).
- The `process` lambda **does not take an `i` argument**. The sample-offset `i` is the parameter of `forSample`'s callback, scoped to that callback only.
- Per-block code can interleave freely with `forSample` invocations: per-block setup → forSample (sample loop) → per-block summary → forSample (output) → per-block publish update — all valid, all in declared order. This recovers the full expressive range of an established `processBlock`-style body with no loss of declarative purity.

```typescript
// Conceptual shape:
return {
  process: () => {
    // per-block phase: setup
    const idx = partitionIdx.load();
    partitionIdx.store(mod(add(idx, 1), 8));

    // per-sample phase: input shaping
    forSample((i) => {
      scratch.write(i, audioIn.at(0, i));
    });

    // per-block phase: block-level summary
    const peak = peakState.load();

    // per-sample phase: output
    forSample((i) => {
      audioOut.set(0, i, mul(scratch.read(i), peak));
    });
  },
};
```

**Decision (Q22-b — Sample-position primitives):** authoritative wording in `01-dsl.md` §1.2, §1.3, §3.3, §10. Summary:

There is **one form** for accessing sample-offset-keyed values, and it is the **explicit form**. No sugar surface.

- Inside a `forSample` callback (per-sample phase):
  - `audioIn.at(c, i): Node<'f32'>` — channel `c` value at sample-offset `i`.
  - `audioOut.set(c, i, v): void` — write `v` to channel `c` at sample-offset `i`.
  - `param.at(i): Node<'f32'>` — param value at sample-offset `i`.
- Outside any `forSample` (per-block phase):
  - `state.load() / state.store(v)` — block-shared state (no sample dimension).
  - `buf.read(idx) / buf.write(idx, v) / buf.readInterpolated(pos)` — buffer access at any user-supplied index (method form on the buffer declaration).
  - `param.at(0): Node<'f32'>` — param value at sample-offset 0 of the current render quantum (k-rate params: the unique block value; a-rate params: the first-sample value, **with the explicit caveat that subsequent in-block automation samples are discarded** — use `param.at(i)` inside `forSample` for per-sample a-rate reads).
  - Arithmetic, comparison, `select`, type conversions, SIMD primitives (used for block-level bulk init / 1-pass computation).
- Audio-I/O sample primitives (`at` / `set`) require `i: Node<'i32'>`. The only source of such a node is a `forSample` callback parameter — outside any `forSample`, `i` is not in scope, so writing `audioIn.at(0, i)` at the per-block phase is a TypeScript reference error caught in the IDE. Standard TypeScript scoping enforces the boundary; the framework adds nothing.
- There is **no `audioIn.read(c)`** (sugar read), **no `audioOut.write([...])`** (sugar tuple write), and **no callable `param()`** (sugar current-sample param). Every per-sample access is via `forSample` + explicit `i`.

The two-form sugar / explicit dichotomy is **rejected** — see Rejected (Q22-b) below for the full reasoning. The single explicit form makes the position of every sample-offset-keyed operation lexically obvious: if you see `at` / `set` / `param.at(i)`, you are inside a `forSample`; if you don't see them, you are at the per-block phase.

**Decision (Q22-c — Error layer structure):** authoritative wording in `03-compiler.md` §2. Summary:

1. **TypeScript type error** (IDE level, before any build): the branded `Node<T>` rejects JS operators. `nodeA + nodeB`, `if (nodeBool)`, `for (... ; nodeCmp ; ...)`, `audioIn.at(0, i)` outside `forSample` (where `i` is undefined). The IDE surfaces these immediately; no framework runtime is involved.
2. **Graph-capture-time error** (build-time, during proxy evaluation of the `process` lambda): scope violations (a declaration call inside expression scope), declarations missing required `name` for snapshot-using processors, declarations inside `forSample` callbacks, and similar shape violations the type system cannot express. Detected by the framework as it executes the `process` lambda with proxies. Audio-output coverage and duplicate-write are **not** checked at this layer — `out.set(c, i, v)` is freely callable, untouched positions emit silence, and last-write-wins on same-position writes (Q37).
3. **Static-analysis error** (post-capture, before WASM emission): allocation check (an AST pattern would imply heap alloc), unbounded loops (build-time loops without a static bound), memory-size violations (sum of declarations exceeds the configured budget), type-inference inconsistencies. Detected by the framework's analysis pass over the captured DAG.

The detailed format of error messages and refactor-hint structure (Q22-d) is resolved at the end of this entry (Rust-style template; `03-compiler.md` §2.5 is authoritative).

**Rationale (Q22-a):**

- *Meta-program with build-time evaluation*: this is the design that lets "the user writes the graph; the compiler emits exactly that graph" stay tractable. Per-sample primitives become AST builders; the captured DAG is a transparent representation of intent; graph-capture-time analysis catches whole classes of shape violations before WASM is emitted.
- *TS as educational lever*: branded types make `Node<T>` incompatible with JS operators at the type level. This catches the most common authoring mistake (writing `a + b` instead of `add(a, b)`) at edit-time, in the IDE, with zero runtime cost. It is also a positive teaching signal — the type-error message points the author at the primitive they should be using.
- *Build-time JavaScript is real JavaScript*: rejecting `for`, `if`, etc. wholesale would prevent legitimate compile-time uses (loop unrolling, debug-flag pruning, constant precomputation). The clean rule is "JS operates on JS values, primitives operate on `Node<T>` values"; the type system enforces the boundary.

**Rationale (Q22-aprime):**

- *Lexical position determines phase, no separate phase primitive needed*: the user writes a `process` body that reads top-to-bottom. Every statement is in either the per-block phase (top level) or the per-sample phase (inside a `forSample`). Determining where a statement runs is reduced to **reading whether it's inside a `forSample(...)` or not** — a question that requires no framework rule or convention to answer, just the user's normal understanding of JavaScript scope.
- *Free interleaving of per-block and per-sample code*: production-grade plugins (partitioned convolution, FFT spectral processing, oversampling, multiband processing, etc.) need to write per-block setup, run per-sample work, then run more per-block code (block-level summaries, publish state updates, partition advances), then potentially another `forSample`. A model where per-block code is locked into a fixed position (e.g., before all `forSample` calls) would cripple the DSL's expressive range — exactly the failure mode that limits Max gen~ for FFT-style work. The lexical-position model has no fixed ordering: per-block and per-sample phases interleave in declared (source) order.
- *No `perBlock(callback)` primitive*: an explicit `perBlock` primitive was considered and rejected (see Rejected X1 below). Once per-block is "the top level of the `process` body", an additional `perBlock(...)` wrapper adds zero expressive power — the user already has a place to write per-block code (the top level) and a marker for per-sample code (`forSample`). Adding a second marker for the default phase only creates a "where do I write what?" question that the user must resolve. The single marker (`forSample`) cleanly separates the two phases by its presence or absence.
- *No `process: ({ i }) => void`*: cannot express SIMD-stride iteration (4-sample-wide bulk operations) at the user's choice without auto-vectorization magic. Q3 commits unworklet to first-class SIMD via `forSample.byN(4, ...)`; the `({ i }) => void` shape is incompatible.
- *Established `processBlock`-style analogue*: production audio engineers (working across various established plugin frameworks and native AudioWorklet) all share the mental model "a `process` body that runs once per block, with an inner sample loop the user writes". unworklet's lexical-position model maps to this universal mental model exactly: top level = the body of the per-block code, `forSample` = the inner sample loop. Migration cost from established `processBlock`-style frameworks to unworklet is 1-to-1 at the mental model level; only the primitives change.

**Rationale (Q22-b):**

- *Single form (no sugar)*: the value `i` representing the current sample-offset is what makes per-sample primitives different from per-block primitives. Hiding `i` (sugar) requires the framework to bind it implicitly based on context, which means the *same primitive call site* (`audioIn.read(0)`) means different things depending on lexical scope. Users have to track scope to interpret each call. The explicit form (`audioIn.at(0, i)`) makes the sample-offset presence visible at every call: if there's an `i`, you're per-sample; if not, you're per-block. Lexical scope and primitive form align, removing one axis of mental tracking.
- *No syntactic disadvantage worth keeping sugar for*: the price of explicit form is one extra argument per sample-offset primitive — `audioIn.at(0, i)` vs `audioIn.read(0)`. For simple plugins, this means 1–2 extra characters per line. For production-grade plugins, the overhead vanishes against the rest of the DSP. The "simple plugin readability" argument is real but small, and is dominated by the value of having a single form across all plugins.
- *No `param.value` / `param.now()` / callable `param()`*: same reasoning — these are sugar surfaces that hide `i`. The framework offers `param.at(i)` (per-sample) and `param.at(0)` (per-block, k-rate-friendly) as the only forms, both of which are explicit about which sample-offset is being read.
- *Forbidding sugar inside `forSample`*: even though `forSample` provides an `i` in scope, allowing `audioIn.read(c)` inside the callback would partially restore the sugar surface and re-introduce the "form depends on lexical scope" mental cost. The cleaner rule is **no sugar at all** — every access uses `at` / `set` / `param.at(...)` regardless of where it is.

**Rationale (Q22-c):**

- *Three error layers correspond to three distinct enforcement mechanisms*: (1) TS type errors are surfaced by the editor, require no framework runtime, and catch the largest class of mistakes; (2) graph-capture-time errors run during the build's proxy-evaluation pass and catch shape violations the type system cannot express; (3) static-analysis errors run after capture, on the DAG, and catch deeper violations (memory budget, allocation potential, etc.). The layering reflects "earliest detection is cheapest detection" — every error class is pushed as far up the chain as it can go.

**Rejected (Q22-a):**

- *"`process` runs per sample" mental model* — would force the framework to either re-enter user TypeScript per sample (impossible for realtime safety) or maintain the fiction that it does (sets up wrong intuitions about cost, error timing, and what `if`/`for` mean inside `process`). Build-time evaluation is honest about what is happening.
- *`Node<T>` as a structural type that JS operators can target (operator overloading, `Symbol.toPrimitive`, etc.)* — would either require runtime dispatch (not realtime-safe) or compile-time rewriting (framework magic). Branded types refuse the bait at the type level, the IDE shows the mistake, and the user is directed to the primitive instead.

**Rejected (Q22-aprime):**

The following candidates for the process body's structure were considered during grilling and rejected. The full grilling history is preserved here because each rejected option illuminates a structural property of the chosen design. (Internal candidate labels X1–X8 from the design conversation are kept for cross-reference.)

- *X1: `perBlock(callback)` primitive injected into the `process` body, with sugar form retained for per-sample access*. This was the first concrete proposal after the plugin-robustness audit revealed the per-block phase gap. It would have placed `perBlock(callback)` and `forSample(callback)` as siblings within the `process` body, with sugar primitives (`audioIn.read(c)`, `param()`, etc.) interpreted as implicit-`forSample`-wrapped per-sample work. **Rejected**: the same `process` body would contain three time-axis-distinct kinds of statement (sugar = per-sample, `forSample(...)` = per-sample, `perBlock(...)` = per-block), and each statement's meaning would depend on its position relative to the others. Mental model triple-layered, the user would have to track "what scope am I in?" at every line. Identified by 余湖さん (2026-05-05) with the observation: "sugar syntax と両立しているのに、 同じ process 内で書く場所によって使えるものが違う". The criticism is structurally correct.

- *X2: sugar form abolished + `perBlock` primitive*. Sugar primitives removed (`audioIn.read(c)`, `param()`, sugar `audioOut.write([...])` all gone), and `perBlock(callback)` introduced as a sibling to `forSample(callback)`. **Rejected**: still requires the user to write `perBlock(...)` to mark per-block code, even though that code could simply be at the top level of the `process` body. The `perBlock` primitive adds zero expressive power once "the top level is per-block" is recognized. More importantly, X2 still treats per-block as a "scope marker" rather than a "position", which in turn limits where per-block code can appear (= inside the `perBlock` callback only) — losing the free interleaving of per-block and per-sample code that production-grade plugins need.

- *X3: `perBlock` as a separate top-level method on the processor's return record* (i.e., `return { perBlock: () => {...}, process: () => {...}, publish: () => {...} }`). **Rejected**: locks per-block code into "always before `process`", and per-block code that needs to run *between* `forSample` invocations (e.g., partitioned convolution that updates a partition pointer between input shaping and output drain) cannot be expressed. Also forces the user to pass per-block-computed values to per-sample code through state slots only (no shared closure variables across the methods), which is needlessly heavyweight. The method-separation appeal (= "method-level lifecycle phase") is real, but the expressive limitation (= "per-block always first, never interleaved") is structurally fatal for production-grade plugins. Identified during grilling on 2026-05-05.

- *X4: `defineProcessor` body itself reinterpreted as per-block phase* — declaration would move to a separate method, eliminating the build-time / runtime distinction at the body's top level. **Rejected**: collapses two semantically different phases (declaration = build-time slot creation; per-block = runtime computation) into one, eliminating the static-graph guarantee. Framework magic.

- *X5: Phase-tag abstraction (`processor.phase('block', () => ...)`, `processor.phase('sample', (i) => ...)`)*. **Rejected**: the phase tag is a string and the callback signature differs per phase, so the abstraction can't be statically enforced; the API erases the structural difference between per-block and per-sample work, making the framework's own type system weaker.

- *X6: X2 + X3 (sugar abolished + `perBlock` as a separate method)*. **Rejected**: stacks the boilerplate cost of X2 (`forSample(...)` always required for sample work) with the expressive limitation of X3 (per-block always first, never interleaved). Worst of both.

- *X7: Context-object delivery of phase primitives (`process: ({ block, sample }) => ...`)*. **Rejected**: a syntactic variant of X1 — same time-axis-distinct kinds of statement in one body, just delivered through different object methods. Doesn't address the underlying issue.

- *X8: `perBlock` invoked in declaration scope (top of `defineProcessor` body, before `return`)*. **Rejected**: declaration scope has the time semantics "build-time, once per processor instance"; placing `perBlock(callback)` there would have the framework reinterpret one of those calls as a runtime per-block phase, blurring declaration's time semantics. Framework magic.

- *(Earlier rejected) `process: ({ i }) => void`* — single-phase processor, `i` as the lambda parameter. **Rejected** earlier in the grilling: cannot express SIMD-stride iteration without either auto-vectorization magic or a parallel SIMD-only declaration surface, and once `forSample(callback)` is needed for SIMD it strictly subsumes this shape.

**Rejected (Q22-b):**

- *Sugar form (callable `param()`, sugar `audioIn.read(c)`, sugar `audioOut.write([...])` at the top level, with implicit `forSample` wrapping)*. The original Q22-b draft (now rejected). **Rejected during grilling on 2026-05-05** with the structural insight that the same primitive call site means different things depending on lexical scope, forcing users to track context to interpret each line. Once the lexical-position model (per-block at top, per-sample inside `forSample`) is adopted for the body's structure, sugar primitives lose their footing — they would require the framework to bind `i` implicitly, which contradicts the "lexical position determines phase" principle that the body structure relies on. Distinct method names (`read` vs `at`, `write` vs `set`, `param()` vs `param.at(i)`) were considered as a way to keep both forms while making the difference visible per call, but adding the second surface only doubles the API while solving nothing the lexical-position model doesn't already solve.

- *Sugar form retained inside `forSample` only (= `i` implicit since it's in scope from the callback parameter, but no sugar at the per-block top level)*. **Rejected**: re-introduces the "form depends on lexical scope" mental cost — the same primitive call (`audioIn.read(c)`) would be invalid at the top level but valid inside `forSample`, which means readers still have to track scope to interpret call sites. The cleaner rule is "no sugar anywhere" — every sample-offset access uses `at` / `set` / `param.at(...)`, regardless of where it appears.

- *Same method name with arity overload (`audioIn.read(c)` and `audioIn.read(c, i)`, etc.)*. **Rejected**: the two forms become visually indistinguishable at call sites; readers count arguments to know which form is active. Distinct names and removing sugar entirely both addressed this; the latter is structurally simpler.

- *Property-based current-sample sugar (`param.value` or `param.now()`)*. **Rejected**: any form of sugar runs into the same issue — implicit `i` binding, lexical-scope-dependent meaning, double surface. No property variant escapes this.

- *Graph-capture-time error or lint rule for "mixing sugar and explicit forms"*. Not relevant once sugar is abolished.

**Rejected (Q22-c):**

- *Single-layer error model (everything detected at runtime)* — incompatible with realtime safety. Errors on the audio thread cannot be recovered safely; pre-runtime detection is non-negotiable.
- *Two-layer model (TS errors + runtime errors only)* — collapses graph-capture-time and static-analysis detection into "runtime errors", which lose specificity (the user cannot tell whether the error is about shape, scope, or memory budget). The three-layer structure preserves precise diagnosis.

**Decision (Q22-d — Error message format and refactor-hint structure):**

Layer 2 (graph-capture-time) と Layer 3 (static-analysis) の error message を Rust-style template に 統 一:

```text
error[unworklet/<stable-id>]: <one-sentence summary>
  --> <file>:<line>:<col>
   |
<line> |       <code excerpt>
   |       <caret range>
   |

help: <1-3 sentence で 修 正 方 針>

      <修 正 後 の code snippet, 1-3 行>

note: see `decisions-log.md` <Q-ref> for the underlying rule.
```

- **heading**: `error[unworklet/<stable-id>]: <summary>` — `<stable-id>` は error 種 別 を 表 す stable な ID (= `constant-truthy-emitif` / `scope-violation` / `illegal-stride` / `bounded-loop` / `memory-budget` 等)、 grep / IDE filter / doc 検 索 用
- **source location**: `--> <file>:<line>:<col>` (= Rust 慣 行) + 1〜3 行 の code excerpt + caret で 該 当 範 囲 明 示
- **help section**: `help:` prefix + 1〜3 sentence で 修 正 方 針 + 修 正 後 code snippet
- **note section**: `note: see <decisions-log link>` で 仕 様 根 拠 へ cross-ref

Layer 1 (= TypeScript native type error) は unworklet が 触 ら ず、 TypeScript / IDE 標 準 の 表 示 (= `TS<code>: <msg>`) を そ の ま ま 通 す。

authoritative wording は `03-compiler.md` §2.5 (template) + §2.6 (stable ID inventory)。

**Rationale (Q22-d):**

- *Rust-style format は IDE / editor 親 和*: 既 言 語 慣 行 (= Rust compiler / TypeScript compiler) と 整 合 し、 editor 側 で source location parsing 既 動 く、 user の 学 習 cost 小
- *stable-id 経 由 で error 分 類 が grep / filter 可 能*: 「`unworklet/constant-truthy-emitif`」 で 検 索 し て 該 当 docs / FAQ に 到 達 で きる
- *help section + corrected snippet で footgun 撤 廃*: user に 「何 が ダ メ で 何 を 書 け ば いい か」 を 1 つ の error message 内 で 完 結、 user mental に 「自 力 で 直 し 方 を 探 す」 cost を 押 し 付 け な い
- *note section で decisions-log link*: 仕 様 根 拠 を 即 参 照 で きる、 「framework が な ぜ こ の error を 出 す か」 を 学 び た い user の 経 路 を 1 つ に 統 一

**Rejected (Q22-d):**

- *TypeScript-style (= `TS<code>: <msg>` + tilde 下 線 ナ シ)*: TypeScript native error と 区 別 つ き に く い、 stable-id 経 由 で の 分 類 が 取 り に く い
- *plain text 1 line (= `error: ...`)*: 修 正 方 針 + source location + 仕 様 根 拠 link が ナ シ = footgun を user に 押 し 付 け る
- *JSON structured error の み*: human-readable で な い、 user が console で 直 接 見 る 場 面 で 不 親 切

---

## Q27 — Generic typed messaging core surface

**Status:** resolved.

**Decision:** the main↔worklet messaging surface composes from three new declaration kinds (`state.publish` extension, `event<T>`, `message<T>`) plus the existing `param` and `midiInput` / `midiOutput` surfaces. Five surfaces total cover every communication use case; no separate `bulk` declaration is needed.

**Surface summary** (authoritative wording in `01-dsl.md` §3 / §4 + `02-messaging.md` + `05-client.md` §2):

| Surface | Direction | Purpose | Delivery | Transport (SAB) | Transport (fallback) |
|---|---|---|---|---|---|
| `param` | main → worklet | continuous control values (knob, slider) | (Web Audio AudioParam) | (Web Audio internal) | (Web Audio internal) |
| `state.publish` | worklet → main | continuous worklet-side values (meter, LFO, spectrum) | coalesce-latest at publish rate | shared region, atomic store/load | postMessage at render-quantum boundary |
| `event<T>` | worklet → main | sample-accurate moments (zero-cross, threshold, user trigger) | preserve all events with `atSample` | SAB ringbuffer + `Atomics` head/tail | postMessage with same slot semantics |
| `message<T>` | main → worklet | discrete commands (button press, preset request) | preserve all in-arrival-order, drained at block boundary | SAB ringbuffer + `Atomics` | postMessage |
| `midiInput` / `midiOutput` | bidirectional | MIDI events (Q4) | (Q4-c) | (Q4-c) | (Q4-c) |

**Decision (Q27-a — `state.publish` extension):**

`state.<type>(initial, options?)` accepts an optional `publish: { rateFps: number }` field (default omitted = not published). When set, the framework copies the current slot value to a shared region every `1000/rateFps` ms; the main thread reads through `node.state.<name>.subscribe(handler)` or `.value`.

- **Read-only on main**: the slot remains worklet-private for writes; main observes a snapshot at copy time. Concurrent worklet writes never tear (atomic store).
- **One coalesce strategy**: latest-wins per slot. There is no queued history for state slots; for that, declare an `event` instead. The strategy is fixed at the declaration kind, not configurable per slot — this is what makes the user's intent visible at the declaration site.
- **`rateFps` default** is 30. v1.0.0 surface accepts only a numeric `rateFps`; rate-mode variants (`rAF`-driven, per-state custom curves) are deferred to v1.x.0 additively.
- **Buffer state publish**: `buffer.<type>({ size, name, publish: { rateFps } })` extends the same option to buffer-typed states; the framework copies the buffer region into the shared region every publish tick. This covers continuous large data (waveform snapshots, spectrum frames) without a separate declaration.

**Decision (Q27-b — `event<T>` declaration):**

`event<T>(options): EventDecl<T>` declares a typed event channel (worklet → main). Authored at declaration scope; emitted via **method form on the declaration: `eventDecl.emitIf(cond, payload)`** — uniform with MIDI Q4-b's `midiOut.emitIf(cond, event)` (authoritative wording in `11-midi.md` §2.4). The set of expression contexts where `emitIf` can be called (forSample callbacks, MIDI / message handler bodies, etc.) is finalized at Q32.

- **Schema**: user-defined record type `T`. The payload always carries `atSample: number` (block-local sample-offset, `0..SAMPLES_PER_BLOCK-1`) — uniform with MIDI Q4-c.
- **`emitIf` only, no plain `emit`**: same structural-footgun-elimination as MIDI Q4-b. Plain `eventDecl.emit(...)` is rejected at the type level; only the `.emitIf(cond, payload)` method form exists on the declaration.
- **Capacity**: ringbuffer default 256 slots, override via `event<T>({ name, capacity })`. Slot size depends on the largest payload variant; variable-length payload fields share the MIDI sysex pattern (separate content buffer + index in the slot) — see Q27-e.
- **Overflow**: drop-oldest + monotonic `overflowCount` exposed via `node.events.<name>.diagnostics.overflowCount()` — uniform with MIDI Q4-c.

**Decision (Q27-c — `message<T>` declaration):**

`message<T>(options): MessageDecl<T>` declares a typed message channel (main → worklet). The worklet-side handler is registered via `messageDecl.onReceive(handler)` at the per-block top of the `process` body. Handler runs at the start of the **current** render quantum from the worklet's viewpoint (= the next render quantum from the main thread's viewpoint after `node.messages.<name>(...)` is called — they refer to the same moment; see Q38-a), before any `forSample`.

- **Schema**: user-defined record type `T`. No `atSample` (main thread has no sample-offset concept; messages are coarse-grained by definition).
- **Delivery**: in-arrival-order, drained at block boundary. Capacity / overflow same shape as `event<T>` (default 256, drop-oldest + counter).
- **Handler placement**: inside the `process` body, at the per-block phase. Inside the handler body, only state writes / buffer writes / scalar arithmetic are allowed (no audio I/O — the sample-offset `i` is not in scope, by definition).

**Decision (Q27-d — Transport):**

API surface is identical across SAB-available and SAB-unavailable modes; transport differs:

- **SAB available** (default, with COOP/COEP): `state.publish` slots in shared linear memory regions with `Atomics` store/load; `event<T>` / `message<T>` in `SharedArrayBuffer`-backed ring buffers with `Atomics`-based head/tail pointers (uniform with MIDI Q4-c and snapshot Q5).
- **SAB unavailable**: `state.publish` propagates via flag-bearing postMessage at render-quantum boundary; `event<T>` and `message<T>` postMessage with structured-clone payloads. Sample-accurate `atSample` is preserved on the wire; main-side block-boundary latency is the only degradation. Full degradation policy lives in `08-deployment.md` §3.

The audio thread never allocates and never blocks on these paths in either mode (per realtime-safety invariants in `00-foundations.md` §5).

**Decision (Q27-e — Bulk payload path):**

No separate `bulk` declaration. Large payloads route through the existing primitives:

- **Continuous large data** (waveform display, 1024-sample scope frame): `buffer.<type>({ ..., publish: { rateFps } })` — buffer-typed state with publish option.
- **One-shot large data, worklet → main** (snapshot capture, spectrum frame on demand): `event<T>` with a variable-length payload field; the framework routes large payloads through the variable-length content buffer + index pattern (= MIDI sysex pattern, Q4-c).
- **One-shot large data, main → worklet** (IR load, wavetable upload, lookup table push): `message<T>` with a variable-length payload field; same content-buffer + index pattern.

**Decision (Q27-f — Torn reads on multi-byte regions; deferred mitigation):**

In v1.0.0, `buffer.publish` regions and variable-length `event<T>` / `message<T>` payloads use a single shared region per slot with byte-wise copy. This is **not atomic at the region level** — WebAssembly's `memory.copy` (and the equivalent main-thread `Atomics.copyWithin`) operate byte-by-byte, so a main-thread reader observing the shared region during an audio-thread copy can see a partially-updated region (a "torn read"). At publish rates around 30 fps over hour-long sessions, this is statistically guaranteed to occur.

**Practical impact in v1.0.0**:

- Visual displays (waveform scope, spectrum frame): one frame briefly inconsistent; restored within 33 ms or less. Continuity of audio signals makes this visually undetectable in practice.
- Main-side numerical analysis on a published buffer (averaging, peak detection on the main thread): occasional outlier in derived values when a torn read happens to fall on the analysis tick.
- Persistence (recording a published buffer): a torn snapshot may be saved.

Scalar `state.<type>` publish is unaffected — single-word writes are already atomic via `Atomics.store`.

**v1.x.0 mandatory mitigation** (tracked in `10-roadmap.md` §3): double-buffered shared regions for `buffer.publish` and variable-length payloads. Two regions per slot, atomic index switch from the audio thread, main-side readers consume the most-recent-completed region. API surface (`subscribe(handler)`, `.value`, `.on(handler)`) is **unchanged** when this upgrade lands; consumers do not modify code. Cost: 2× memory per published buffer, one extra atomic per publish tick.

This is a **planned mandatory addition**, not optional. The v1.0.0 surface is forward-compatible — only the underlying transport implementation changes.

**Rationale (Q27-a):**

- *State extension over a separate `publishedState` declaration*: `state` is already a core unworklet concept. Adding one option (`publish: { rateFps }`) keeps the learning curve at ~zero — authors who already understand `state` get publishing for free. A separate `publishedState` declaration would be a fourth primitive concept with no expressive gain.
- *Coalesce-latest as the only strategy*: state-push use cases (meter, LFO display, spectrum bins) inherently want the latest value, not history. History needs are served by `event<T>` with explicit capacity. Forcing this split makes the user's intent visible at the declaration site — the choice between "I want the latest" and "I want every event" is made when typing `state.publish` vs `event`, not at runtime.
- *`rateFps` as the only knob in v1.0.0*: rAF-driven rates and per-state custom schedules are valid extensions but would lock the v1.0.0 API into a more complex shape than needed. Deferred per `feedback_no-preemptive-defer.md`'s "additive parallel-worker territory" exception — the additions do not require breaking the v1.0.0 surface.

**Rationale (Q27-b):**

- *`event<T>` parallel to MIDI*: MIDI's `emitIf` + `atSample` + ringbuffer + drop-oldest pattern (Q4) is already a working solution for sample-accurate worklet → main delivery. Generalizing it to user-defined schemas — same shape, free choice of payload type — preserves the uniformity. Users who learn MIDI's pattern get generic events for free, and vice versa.
- *No plain `eventDecl.emit(...)`*: the MIDI Q4-b rationale applies unchanged. Unconditional emission inside `forSample` would saturate the ringbuffer at sample rate; making the conditional structurally mandatory — as a method on the declaration (`eventDecl.emitIf(cond, payload)`) — eliminates the footgun.
- *Variable-length sysex pattern reused*: large payloads (waveform snapshot field) share the MIDI sysex implementation (separate content buffer + index in the slot). One transport implementation covers MIDI sysex, generic events, and messages.

**Rationale (Q27-c):**

- *Handler at per-block top*: messages are inherently coarse-grained (button press, preset load); they do not need per-sample dispatch. Running the handler before any `forSample` lets the user reflect the message into state slots that subsequent `forSample` invocations read, without per-sample dispatch overhead.
- *No audio I/O in handler body*: handlers run outside any `forSample`, so sample-offset `i` is not in scope. TypeScript scope already rejects `audioIn.at(0, i)` here; the framework adds nothing. State and buffer writes are valid because they are sample-offset-independent.
- *Symmetry with `event<T>`*: same capacity / overflow shape; reading either surface tells users what to expect from the other.

**Rationale (Q27-d):**

- *Uniform with MIDI / snapshot transport*: transport choice (SAB + atomics vs postMessage) is decoupled from the API, and the same degradation policy serves all communication paths. One implementation, three consumers (MIDI, snapshot, generic messaging).
- *Audio thread never allocates*: ringbuffer regions are pre-allocated at processor instantiation; publish slots are pre-allocated. State copies are `memcpy` of fixed regions. Nothing on the audio thread depends on heap allocation, GC, or main-thread response.
- *COOP/COEP fallback policy*: SAB requires cross-origin isolation, which not every host configures. Failing closed (= "SAB unavailable means the messaging surface is broken") would push deployment burden onto every consumer; failing open (= same API, postMessage fallback, slightly higher latency) keeps unworklet usable in any web context.

**Rationale (Q27-e):**

- *Three primitives are enough*: continuous large data is conceptually "a published buffer" (= `buffer.publish`), one-shot large data is conceptually "an event with a large payload" or "a message with a large payload". A fourth `bulk` declaration would add a learning bump for use cases the existing primitives already express clearly.
- *Variable-length transport is shared infrastructure*: MIDI sysex already needs it; reusing the same content-buffer + index pattern for `event<T>` / `message<T>` payloads adds nothing to the transport implementation.

**Rationale (Q27-f):**

- *Limitation acknowledged in spec, mitigation deferred*: silently shipping a known torn-read window would push diagnosis cost onto every consumer who hits it. Acknowledging it explicitly with a forward-compatible upgrade path lets consumers choose their use cases knowingly in v1.0.0.
- *Forward-compatible API*: the `subscribe(handler)`, `.value`, `.on(handler)` shapes are independent of single-buffered vs double-buffered transport. The v1.x.0 upgrade is implementation-only; consumer code does not change.
- *Visual UX pragmatically tolerable for v1.0.0*: the most common consumer use case for `buffer.publish` (waveform scope, spectrum frame) tolerates the limitation in practice — torn reads are visually invisible in continuous audio signals. v1.0.0 ships the surface immediately; the deferred mitigation closes the gap for non-visual cases without blocking release.
- *Scalar `state.publish` unaffected*: single-word writes are atomic via `Atomics.store`. The torn-read concern is specifically about multi-byte regions; scoping the limitation precisely matters for consumers evaluating whether their use case is affected.

**Rejected:**

- *Single `topic<T>` declaration with `direction` / `semantics` options* — coalesce-latest vs ringbuffer in one declaration controlled by a string option creates the same structural-footgun trap as plain `midiOut.emit(...)` (Q4-b): a single typo (`semantics: 'state'` vs `semantics: 'event'`) flips the entire delivery contract. Multiple declaration kinds with distinct names make the intent visible at the declaration site.
- *Separate `publishedState<T>` declaration* — a fourth primitive concept (alongside `state`, `event`, `message`) with no expressive gain over `state` + `publish: { ... }` option. The state extension reuses learned vocabulary.
- *`pub.scalar.f32(...)` / `pub.buffer.f32(...)` namespace* — adds a second mental layer (`pub.*` vs `state.*`) and obscures the relationship to plain `state`. The flat extension is simpler.
- *Two-declaration core (`event` + `message` only) with state-push delegated to L1 helpers / recipes* — pushes coalesce-latest pattern into user code, where backpressure handling becomes user responsibility. For the meter / spectrum / LFO use cases that production-grade plugin UIs depend on, this externalizes a pattern that should be load-bearing infrastructure.
- *Separate `bulk` declaration for large payloads* — a fourth primitive that covers cases the existing three already express. Pure surface bloat.
- *`event` / `message` payload size always fixed (no variable-length)* — would force users to tile large payloads across multiple events, defeating the "one-shot large data" use case. The MIDI sysex pattern already proved the variable-length implementation; reusing it costs nothing.
- *Plain unconditional `eventDecl.emit(payload)` allowed inside `forSample`* — same footgun as plain MIDI emit (Q4-b). Saturates the ringbuffer at sample rate. Only the `eventDecl.emitIf(cond, payload)` method form is exposed.
- *State `publish` rate as only `rAF`-driven, no `rateFps`* — couples the publish rate to monitor refresh rate, which is browser-specific (60Hz / 120Hz / 144Hz / variable). For headless contexts (worker-only, OffscreenCanvas without animation, automated tests), `rAF` is unavailable. `rateFps` is the universal primitive; `rAF` is a v1.x.0 additive option.
- *`onReceive` handler registration at declaration scope (= outside the `process` body)* — handlers would have to either close over declarations via outer scope only and not re-resolve them per block (= sometimes wrong if state was reset by snapshot/restore between blocks), or the framework would have to inject hidden re-binding per block. Per-block placement inside `process` resolves the lifetime cleanly without framework magic.
- *Coalesce-latest as a configurable option on `event<T>`* — collapses the "preserve all events" and "latest only" semantics into one declaration, requiring a runtime check at every consumer site to know which mode is active. The two declaration kinds (`state.publish` vs `event`) carry the semantics in the type; consumers know what to expect from the type alone.
- *Defer the entire `buffer.publish` surface to v1.x.0* (Q27-f) — would force every v1.0.0 consumer to roll their own waveform / spectrum bridge using `messages.<name>(payload)` request/reply patterns, externalizing what should be load-bearing infrastructure. The surface ships in v1.0.0; only the torn-read mitigation is deferred, behind a forward-compatible API.
- *Mark torn read as "consumer responsibility, not framework"* (Q27-f) — torn read is structurally caused by the framework's choice of single-buffered shared region in v1.0.0, not by anything the consumer wrote. Pushing it to consumer-territory contradicts unworklet's "no traps for the user" stance.
- *Implement double buffering at v1.0.0 instead of deferring* (Q27-f) — the implementation cost (additional region allocation per publish slot, additional atomic per tick, region indexing logic) was not in scope for the v1.0.0 audit window. Deferred per consumer instruction; tracked as mandatory v1.x.0 mitigation, not optional.

---

## Q31 — onReceive execution contract + bulk copy primitive (audit B1)

**Status:** resolved (timing / 実 行 順 序 / 複 数 handler / state 観 測 は Q38 で 確 定; 表 記 「next render quantum」 は 「当 1 塊 = current render quantum (worklet 視 点)」 で 統 一)。

**Decision (Q31-a — `onReceive` runs on the audio thread):**

`message<T>.onReceive(handler)` is graph-captured at build time and emitted as part of the worklet's `process` body, running on the audio thread at the start of the **current** render quantum (worklet author's viewpoint; from the main thread's viewpoint, this corresponds to the next render quantum after `node.messages.<name>(...)` is called — they refer to the same moment, see Q38-a). Handler bodies are subject to the same realtime-safety invariants as the rest of the audio-thread code path: no allocation, no I/O, no unbounded loops.

**Decision (Q31-b — Bounded-loop rule applies inside `onReceive`):**

JavaScript `for` / `while` loops inside `onReceive` handler bodies obey the same rule that applies everywhere on the audio thread: the loop's upper bound must be a build-time constant. Loops driven by runtime payload values (e.g. `for (let i = 0; i < typedArrayField.length; i++)`) are **static-analysis errors** at WASM-emission time — the build refuses to produce an artifact, and the error message points to the bulk-copy primitive (Q31-c) or the state-slot-array pattern (Q31-d) as the canonical alternative.

This is not a new constraint; it is the realtime-safety invariant from `00-foundations.md` §5 applied uniformly. `onReceive` handlers do not get a special pass.

**Decision (Q31-c — Bulk copy primitive `buf.copyFrom`):**

The `Buffer<T>` handle (returned by `buffer.<T>(...)`) gains a `copyFrom` method:

```typescript
type Buffer<T extends ScalarType> = {
  // ...existing methods (read, write, readInterpolated, loadVec, storeVec)
  copyFrom(src: TypedArrayFieldRef<T>): void;
};
```

- `src` is a typed-array field reference resolved at graph capture time through the same payload proxy that exposes scalar fields elsewhere.
- The framework emits a single `memory.copy` instruction at WASM level; on the audio thread the copy runs as one bounded-time bulk operation, not a per-element loop.
- Length is clamped at runtime to `min(buf.size, src.length)`. Over-length payloads are truncated; under-length payloads leave the tail of the buffer untouched.
- Element-type compatibility is checked at graph-capture time: the typed-array element type must match the buffer's `<T>` (e.g. `Float32Array` → `buffer.f32`, `Int32Array` → `buffer.i32`). Mismatch is a build-time error.

**Decision (Q31-d — State-slot-array copy via build-time unroll + mask):**

Parallel state-slot arrays (e.g. the 16 pattern steps in Example 6, the 8 voice slots in Example 8) follow the canonical pattern:

```typescript
loadPattern.onReceive(({ steps }) => {
  for (let s = 0; s < PATTERN_LEN; s++) {     // PATTERN_LEN: build-time constant
    pattern[s].store(select(lt(s, steps.length), steps.at(s), pattern[s].load()));
  }
});
```

- The loop's upper bound is the slot-array length (build-time constant) — the build-time JS loop unrolls into `PATTERN_LEN` graph operations.
- `steps.length` resolves to a `Node<'i32'>` at graph capture (typed-array-field proxy).
- `select(lt(s, steps.length), …)` masks per-slot updates against the runtime payload length: indices beyond the payload's length retain their existing slot values.

No new primitive is added — `select`, `lt`, and the existing typed-array-field proxy access express the pattern.

**Rationale (Q31-a):**

- *Same audio-thread invariant as the rest of `process`*: `onReceive` handlers reflect into state slots that subsequent `forSample` invocations read. Placing them on a separate thread (worker, main, etc.) would force every consumer to think about cross-thread synchronization windows. Q27-c put the handler on the audio thread for this reason; Q31-a confirms it.

**Rationale (Q31-b):**

- *Uniform invariant*: the realtime-safety rule for audio-thread loops (build-time-constant upper bound) is the same rule already applied to every `forSample` body and `everyNSamples` callback. `onReceive` does not get an exception; the bulk-copy primitive (Q31-c) is the framework-supplied way to express bulk transfer that *would otherwise* be a payload-driven loop in naive code.
- *Detectable at static-analysis*: the loop's bound is a structural property of the AST. The compiler walks each loop and verifies the bound folds to a build-time constant; if not, WASM emission is rejected. The error message references Q31-c / Q31-d as the canonical workaround.

**Rationale (Q31-c):**

- *Method form on the buffer handle*: matches the A4 + B method-form refactor (`buf.read` / `buf.write` / `buf.loadVec` / etc.). The buffer is the subject of the action; `copyFrom` reads as "copy into this buffer from the given source", echoing `Float32Array.prototype.set` and other host-platform conventions.
- *Single `memory.copy` instruction*: the operation compiles to one WASM instruction. Audio-thread cost is `O(N)` in byte count with no per-element JavaScript overhead and no graph node per element. WASM allocators / SIMD-based memcpy implementations execute it in deterministic walltime.
- *Length clamp at runtime*: keeps the API ergonomic. Authors do not write `Math.min(src.length, buf.size)` defensively; the framework guarantees no out-of-bounds write.
- *Source type checked at graph-capture*: a `Float32Array` field cannot be copied into a `buffer.i32` and vice versa. Mismatches fire at build time with a TS or graph-capture-level message.

**Rationale (Q31-d):**

- *No new primitive needed*: existing `select` + `lt` primitives, combined with build-time JS loop unrolling over a build-time-constant slot-array length, fully express "copy as many entries as the payload provides, leave the rest untouched". A dedicated `copyToSlots` primitive would save a few characters at the cost of one more concept; existing primitives are enough.
- *Pattern is documented in canonical examples*: Examples 5, 6, 8 demonstrate this shape; a recipe entry in `docs/recipes/` is a future addition once recipe authoring lands (see open recipe tasks).

**Rejected:**

- *`onReceive` on the main thread*: would change which thread the handler runs on. Authors who write `meterL.store(0)` in `reqReset.onReceive` expect the store to be visible to the next `forSample` of the same render quantum on the audio thread. Cross-thread synchronization (latency, consistency window) would have to enter the user's mental model. Q27-c put the handler on the audio thread for this reason; revisiting that for B1 would regress the contract.
- *Amortized loop on the audio thread* (= 1 block copies 128 samples, the rest carries over to the next block): introduces a "buffer is partially populated" runtime state visible to user code. Authors would have to gate readers on a "ready" flag and reason about block-boundary transitions. Adds complexity for a use case (bulk copy of small-to-moderate typed arrays) that `memory.copy` already handles cleanly in one operation.
- *A separate `bulkUpload<T>` declaration kind*: a fourth message-shape concept (alongside `state.publish` / `event<T>` / `message<T>`). It does separate "command messages" from "bulk uploads" cleanly at the declaration site, but the same job is achieved by `message<T>` + `buf.copyFrom` with one fewer concept. Concept-count discipline (see Q27 rejected list, "drop both `event` and `message` if state.publish covers it") prefers the latter.
- *Inferred build-time bound from `typedArrayField.length`*: if the typed array's length were a build-time constant (e.g. `new Float32Array(1024)` declared at build time), the loop *would* unroll. But the audit's actual use case (`samples.length` from a runtime message payload) is precisely where it is not. Inferring per-call would silently grow the WASM module by the length of the longest possible payload, surprise the author when build artifact size balloons, and obscure the realtime-safety property. Static-analysis rejection with a pointer to `copyFrom` is the honest path.
- *`copyFrom` accepting an unbounded JS array (not a typed array field)*: the typed-array constraint is what makes the memcpy single-instruction and zero-conversion. A plain `number[]` would need element-by-element JavaScript-side conversion to the buffer's element type — that is the per-element loop the user was trying to avoid.
- *Allow `samples[i]` JS-bracket indexing in onReceive's build-time loop, even when the upper bound is build-time-constant but `samples` is runtime-typed*: technically expressible, but Q36-b unified typed-array-field reads on the `.at(idx)` method form (= `Node<'i32'> | number`-typed argument that folds at graph capture when `idx` is a JS-literal). The canonical state-slot-array pattern (Q31-d) therefore writes `samples.at(s)` for build-time `s`, with `select` + `lt` masking the per-slot updates against the runtime payload length. The JS-bracket form is rejected at the type level by the typed-array-field proxy surface.

---

## Q32 — `emitIf` callable in MIDI / message handler context (audit B2)

**Status:** resolved.

**Decision (Q32-a — Single primitive across all expression contexts):**

`eventDecl.emitIf(cond, payload)` and `midiOut.emitIf(cond, event)` are the **single emission primitive** across every expression context where the audio-thread graph is captured: `forSample` callbacks, `forSample.byN` callbacks, `everyNSamples` callbacks (which only run inside `forSample`), `midiInput().onEvent(...)` handlers, `messageDecl.onReceive(...)` handlers, and the **per-block top level** (= statements in the `process` body outside any `forSample`). There is no `eventDecl.emit(...)` / `midiOut.emit(...)` plain method, no handler-only context-injected emit, and no separate handler-context emission surface. The Q27-b / Q4-b method-form rule (`handle.emitIf(cond, payload)`) is uniform across all of those contexts.

**Decision (Q32-b — `cond` accepts `Node<'bool'> | boolean`):**

The `cond` parameter type widens to a union:

```typescript
type EventDecl<T> = {
  emitIf(cond: Node<'bool'> | boolean, payload: T): void;
  diagnostics: { overflowCount(): number };
  name: string;
};

type MidiOutputHandle = {
  emitIf(cond: Node<'bool'> | boolean, event: MidiEvent): void;
  diagnostics: { overflowCount(): number };
  name: string;
};
```

A boolean literal (`true` / `false`) at the call site is the canonical way to express handler-context unconditional emission:

```typescript
midi.onEvent('noteOn', ({ note, velocity, atSample }) => {
  // Unconditional 1:1 projection from the MIDI handler to a UI event.
  notePlayed.emitIf(true, { atSample, note, voice: v, velocity: velocity / 127 });
});
```

The `boolean` arm of the union is restricted to **literal types** at the call site (`true` / `false` only; arbitrary `boolean` values from JS computation are not part of the build-time graph). This keeps cond a build-time-decidable structural property — `emitIf(false, ...)` folds away at graph capture, and `emitIf(true, ...)` records an unconditional emission node. (The exact type-level shape は Q36-c で 確 定: `cond: Node<'bool'> | boolean` を 採 用、 build-time JS const も literal lift で 同 様 に folding 経 由 で 扱 う。)

The `boolean → Node<'bool'>` lift mechanism は Q36-a で 解 決: method 引 数 で の literal lift ル ー ル と し て 「method の 引 数 型 が `Node<X>` な ら literal は 自 動 で `Node<X>` に lift」 を 採 用、 cond は そ の ル ー ル の 自 然 帰 結。 Q32-b の `emitIf(true, payload)` は そ の ま ま canonical spelling と し て 維 持。

**Decision (Q32-c — Static-analysis: constant-truthy cond inside `forSample` is an error):**

Inside `forSample` / `forSample.byN` / `everyNSamples` callbacks, an `emitIf` whose `cond` argument folds to a build-time-constant truthy value (literal `true`, or an expression statically equivalent to `true`) is a **static-analysis error** at WASM-emission time. The error message is:

```
error: emitIf with constant-true cond inside forSample saturates the ringbuffer at sample rate.
  This emission would fire on every sample (or every Nth sample for forSample.byN), filling
  256-slot ringbuffers in milliseconds and producing continuous overflow.
  Either:
    (a) gate with a state-edge expression — e.g. `eq(crossedThreshold, 1)`, `gt(level, ceiling)`,
    (b) move the emission to a MIDI / message handler context (handlers fire 1:1 with input events,
        not at audio rate), or
    (c) use `everyNSamples(N, () => emitIf(...))` if periodic sub-rate emission is the intent.
```

Rejection is structural — the `forSample` callback's `i` loop counter is in scope, so the analyzer recognizes the surrounding context unambiguously. Outside `forSample` (handler bodies, per-block top-level code reachable only through handler-driven state), the analyzer permits constant-truthy cond.

This restores the Q4-b footgun barrier (no unconditional emission inside `forSample`) at the static-analysis layer rather than the type layer. The cost — one explicit error class with a refactor hint — is paid by the small number of authors who would otherwise write the saturating form by accident; the benefit is that the single `emitIf` primitive covers every context.

**Rationale (Q32-a):**

- *Mental-model unification (single primitive)*: the same `emitIf` method on the same handle works in every expression context the user writes. Authors do not learn "in forSample use X, in handler use Y"; the IDE completion is the same shape across contexts. Q4-b / Q27-b already settled `emitIf` as the only emission primitive on the handle; Q32-a confirms that decision applies symmetrically across handler contexts too.
- *No method-count growth*: handles do not grow a second emission method (`emit`). The surface area of `EventDecl<T>` and `MidiOutputHandle` is unchanged in shape — only the cond-type widens.
- *No context-injected surface*: there is no `(payload, ctx) => ctx.emit(...)` form in the handler signature. Handler signatures stay as `(event) => void` / `(payload) => void`, matching `forSample`'s `(i: Node<'i32'>) => void` shape uniformity (one-argument lambda, no context bag).

**Rationale (Q32-b):**

- *Handler-context unconditional emission is a real use case*: 1:1 projection from a MIDI / message handler to an event channel — common in MIDI-triggered synths (UI key-flash event), MIDI thru patterns (ingest noteOn → emit noteOn on a different channel), and message-driven main-thread acknowledgements that need sample-accurate `atSample`.
- *Literal `true` at the call site reads at the natural place*: `notePlayed.emitIf(true, { atSample, note })` says "emit, no condition" right at the call site. The alternative (introducing an `emit` method) would split the surface; the alternative (forcing `bool(true)` boilerplate) would add ceremony for a clearly-intentional case.
- *State-driven cond from the handler body still works*: `emitIf(eq(activeNote.load(), 60), payload)` continues to be the spelling for "emit only when state matches X", since the handler can read state slots. Q32-b only widens cond, it does not remove the `Node<'bool'>` arm.
- *Consistency with B3 literal lifting*: the cond type is a literal-lifting boundary in the same family as scalar literal lifting (Q1: numeric literal → `Node<'f32'>`). Treating booleans the same way at this position is the conservative shape; B3 may decide whether the lifting is implicit-everywhere or explicit-only — Q32-b is forward-compatible with either resolution.

**Rationale (Q32-c):**

- *Q4-b footgun stays barred*: the saturating-emit footgun (`if (cond) midiOut.emit(...)` firing every sample) is rejected. A user writing `notePlayed.emitIf(true, payload)` inside `forSample` gets a build-time error pointing at the three legal alternatives.
- *Detectable structurally*: the `forSample` callback boundary is recognizable to the static analyzer (it is a primitive in the framework — see `01-dsl.md` §10.2). Cond is one AST node away. The check is local and cheap.
- *Refactor hint matches the use case*: most authors hitting this error are either (a) trying to fire on a state edge — covered by hint (a), (b) writing handler logic that should not be inside `forSample` at all — covered by hint (b), or (c) writing periodic sub-rate emission — covered by hint (c). The error message names the three honest paths; no path is silently allowed.

**Rejected:**

- *Add a `handle.emit(payload)` method, callable only in handler context (option A in B2 grilling)*: handle would carry two emission methods (`emit` for handlers, `emitIf` for `forSample`) and authors would learn "context A → method 1, context B → method 2". Mental-model split with no concrete benefit beyond saving four characters per handler emission. The static-analysis cost (= context-checking) does not vanish — it merely shifts to checking `emit` instead of `emitIf` for context legality. Q32-a + Q32-b + Q32-c gives the same structural guarantee with one method instead of two.
- *Allow `handle.emit(payload)` in every context (option B)*: re-introduces the Q4-b footgun (`emit(payload)` inside `forSample` saturates the ringbuffer). Already rejected at Q4-b for the same reason; revisiting at B2 would regress that decision.
- *Cond accepts arbitrary `boolean` (not literal-restricted) without static-analysis check (option D)*: a JS-side `boolean` value reaches the cond at build time, so `emitIf(true, ...)` inside `forSample` would compile as unconditional sample-rate emission. Same footgun as option B. The literal-restriction-with-static-analysis (Q32-b + Q32-c) is the targeted form that avoids this.
- *Make `emitIf` a 2-arity method (cond optional), `emitIf(payload)` for unconditional (option E)*: same footgun mechanism as D — `forSample((i) => emitIf(payload))` becomes a saturating emission with no syntactic warning. Rejected for identical reasons.
- *Inject the emit primitive via a context bag in the handler signature, e.g. `midi.onEvent('noteOn', (evt, ctx) => ctx.emit(decl, payload))` (option F)*: re-introduces the yoda-notation problem (the subject of the action — the declaration — is buried as a method argument, the emit verb is on a context bag). The A4 + B method-form refactor (commit 3a7f1b4) eliminated yoda-notation across the DSL precisely because "what is being emitted" should be the leading subject of the call. Adding it back for handler context would split mental models.
- *Spec the handler-context emission as `eventDecl.emit(payload)` and forbid `eventDecl.emitIf(...)` in handlers*: would force handler-side authors who *do* want a state-derived cond to refactor (e.g. `if (activeNote.load() === 60) emit(payload)` becomes `emitIf(eq(activeNote.load(), 60), payload)` only outside the handler). Asymmetric and surprising.
- *Defer the surface to v1.x.0 by leaving handler-context emission as a TS-cast workaround (the `true as unknown as Node<'bool'>` form in Example 8)*: the cast hack is a documented signal that the spec has a hole. Shipping v1.0.0 with the hole open and "the cast is fine" as the official answer would violate `feedback_no-preemptive-defer.md` (no preemptive defer of known needs) — handler-context emission is a known need across MIDI / message handlers and is part of the v1.0.0 mental model.

---

## Q33 — Literal lifting in i32 / bool / context (audit B3)

**Status:** resolved (method 引 数 へ の 拡 張 は Q36 で 解 決)。

**Decision (Q33-a — Q1 拡 張: context-dependent literal lift):**

Q1 の 「numeric literal → `Node<'f32'>`」 を **context-dependent lift** に 拡 張:

- **primitive 引 数 で の number / boolean literal** は、 primitive の signature が 周 辺 引 数 から `T` を 推 論 で きる 場 合、 その `T` の `Node<T>` に lift される
- **全 引 数 が literal で T 推 論 不 可 (= ambiguous case)** の default は `'f32'` (Q1 と 整 合)
- 対 象 type = **f32 / f64 / i32 / bool** の 4 種。 i64 は 暗 黙 lift 対 象 外 (Q33-c 参 照)

```typescript
mul(meterL.load(), 0.95)           // meterL: Node<'f32'> → 0.95 → Node<'f32'>
mod(add(head, i), HISTORY_LEN)     // head: Node<'i32'> → HISTORY_LEN → Node<'i32'>
eq(stepCounter.load(), 16)         // stepCounter: Node<'i32'> → 16 → Node<'i32'>
select(isMe, true, gate.load())    // gate: Node<'bool'> → true → Node<'bool'>
add(0, 0)                          // 全 lit、 ambiguous → default Node<'f32'>
```

暗 黙 lift は **primitive 引 数 限 定**。 declaration / 変 数 直 接 assign / return value 等、 primitive 引 数 で ない context で は scalar constructor が 必 要 (Q33-b)。

**Decision (Q33-b — Scalar constructors として の explicit lift):**

`f32` / `f64` / `i32` / `i64` / `bool` を 「**scalar constructor**」 と し て v1.0.0 で 全 確 定:

```typescript
f32(v: number): Node<'f32'>;
f64(v: number): Node<'f64'>;
i32(v: number): Node<'i32'>;
i64(v: bigint): Node<'i64'>;
bool(v: boolean): Node<'bool'>;
```

主 な 用 途:

- **declaration** (= primitive 引 数 で ない context、 暗 黙 lift 対 象 外):
  ```typescript
  let count = i32(0);
  let lSum  = f32(0);
  const def = bool(false);
  ```
- **ambiguous-call disambiguation** (= 全 lit primitive 呼 び で T を 固 定 し たい 場 合):
  ```typescript
  add(i32(0), i32(0))   // T = 'i32' 強 制 (= default f32 fallback を override)
  ```
- **i64 lit 構 築** (= 暗 黙 lift ナシ、 BigInt 受 け 取 り):
  ```typescript
  add(state.i64.load(), i64(BigInt(123)))
  ```

**Decision (Q33-c — i64 暗 黙 lift ナシ):**

i64 期 待 position で の literal 暗 黙 lift は 提 供 し ない。 JS の number は IEEE 754 double precision で 安 全 整 数 範 囲 が `2^53 - 1`、 i64 (= 2^63) を 安 全 に 表 現 で きない。 i64 lit は scalar constructor `i64(BigInt(...))` の explicit 経 由 のみ。

**Rationale (Q33-a):**

- *Q1 と の 同 形 拡 張*: Q1 既 確 定 の 「primitive 引 数 で literal lift」 pattern を そ の まま i32 / bool / f64 へ 拡 張。 user の mental rule 数 増 加 ゼロ、 「素 数 字 / 真 偽 値 を primitive 引 数 で 直 接 書 ける」 1 rule で 全 type 統 一。
- *boilerplate 最 小*: `param.at(0)` / `mod(add(head, i), HISTORY_LEN)` / `eq(stepCounter.load(), 16)` 等 canonical で 頻 出 の pattern が natural に 通 る、 explicit `i32(...)` 包 み 不 要。 既 example の 直 感 と 整 合。
- *context-dependent 推 論 は TS generic で natural*: `add<T>(a: Node<T> | LiteralOf<T>, b: Node<T> | LiteralOf<T>): Node<T>` で 1 引 数 が `Node<T>` なら T 確 定、 反 対 引 数 の lit は その T へ lift。 user 側 hover で union は 通 常 出 ない (= ambiguous case のみ)。

**Rationale (Q33-b):**

- *Scalar constructor 用 語*: GLSL の `vec3(0.0)` / `float(0)`、 WGSL の `f32(0)` 等 graphics / audio DSL で の 確 立 文 化、 author の mental が 直 接 transfer。 「lift function」 等 関 数 型 jargon より natural。
- *暗 黙 lift で カバー されない context で 必 須*: declaration (= `let count = i32(0)`)、 全 lit primitive 呼 び (= T 固 定)、 i64 構 築 (= BigInt 経 由) で 必 要。 5 surface で 全 type カバー。

**Rationale (Q33-c):**

- *JS number の 安 全 範 囲*: IEEE 754 double precision で `Number.MAX_SAFE_INTEGER = 2^53 - 1`、 i64 範 囲 (= 2^63) を 表 現 不 可。 暗 黙 lift OK にすると 大 きい 整 数 で precision 損 失 が silent に 起 きる。
- *BigInt 必 然 性 を 自 明 化*: user が `i64(BigInt(...))` 包 み を 書 く 度 に 「BigInt が 必 要」 mental が 想 起 される、 暗 黙 lift の 罠 を 回 避。
- *canonical で の i64 不 在*: v1.0.0 canonical examples で i64 literal が 出 て こ ない、 explicit のみ で 実 害 ナシ。 surface だ け 確 定。

**Rejected:**

- *(P) f32 だ け 暗 黙、 i32 / bool / i64 全 explicit (= GLSL 厳 格 解 釈)*: mental 純 度 高 い (= 「素 数 字 = f32」 1 rule + 例 外 1 個) が、 `param.at(i32(0))` / `mod(add(head, i), i32(HISTORY_LEN))` / `eq(stepCounter.load(), i32(16))` 等 で canonical 全 体 で boilerplate 増、 既 直 感 と 不 整 合。 「全 i32 書 か せる の 嫌」 (余 湖 さん 表 明 2026-05-10)。 (Q33) で 「context-dependent + i64 だ け explicit」 = 純 度 と boilerplate 軽 さ の 両 立。
- *(P') f32 + bool 暗 黙、 i32 / i64 explicit*: bool は 暗 黙 OK だ が i32 だ け explicit = 半 端、 (P) の 純 度 も Q33 の boilerplate 軽 さ も 取 れ ない 中 間 で 良 い と こ ろ ナシ。
- *primitive を f32 専 用 surface に (= `mod(Node<'f32'>, Node<'f32'>): Node<'f32'>`)*: i32 値 (= ring buffer head, forSample i, state.i32) を round-trip 強 制 = 整 数 演 算 で f32 精 度 損 失 (= 大 きい integer 値 で IEEE 754 限 界)、 表 現 力 損 失。 generic primitive (= `mod<T>(...)`) が 自 然。
- *audio rate / 整 数 用 で primitive を 別 surface に 分 離 (= `addF32` / `addI32`)*: surface 倍 増、 不 自 然。
- *primitive call site で type annotation 強 制 (= `mod<'i32'>(...)`)*: ugly、 user 学 習 cost 高。
- *`i32lit` / `f32lit` 別 type で literal を 区 別*: JS number 1 種 と 衝 突、 spec 複 雑 化 で benefit ナシ。

---

## Q34 — Subgraph instantiation scope (audit Phase 1 #2、 Q22-c-Round2 解 決)

**Status:** resolved.

**Decision (Q34-a — `createSubgraph(subgraph, ...args)` で declaration scope 限 定):**

`defineSubgraph` の 結 果 を 親 processor で 使 う surface = `createSubgraph(subgraph, ...args)` free function。 **declaration scope** (= `defineProcessor` body 直 下、 ある い は 別 `defineSubgraph` body 直 下) で 呼 び、 戻 り 値 = state slot を 持 つ instance。 expression scope (= `process` body / `forSample` callback / L1 helper body 等) で の 呼 び は **graph-capture-time error**。

```typescript
// declaration scope: instance 生 成 (= state slot alloc):
const lpf = createSubgraph(onepole, /* subgraph 著 作 lambda の 引 数 */);

// build-time loop で 配 列 alloc:
const voices = [];
for (let s = 0; s < NUM_VOICES; s++) {
  voices.push(createSubgraph(synthVoice, ctx.sampleRate));
}
```

`createSubgraph` の 第 2 引 数 以 降 = subgraph 著 作 lambda の 引 数 (= instance 生 成 時 に 1 度 だ け bind さ れ、 全 method で 共 有)。 forSample 内 でしか 取 れ ない `Node<T>` を ここ で 渡 そう と する と TS / graph-capture-time の 自 然 帰 結 で reject (= `i` 等 forSample callback parameter は declaration scope で 在 域 し ない)。

**Decision (Q34-b — Subgraph body は record return、 key 名 著 作 者 free):**

著 作 者 は body lambda が record を return する。 record の key 名 = method 名 で **著 作 者 free**:

```typescript
const oscillator = defineSubgraph((sr: number) => {
  const phase = state.f32(0);
  const freq  = state.f32(440);
  return {
    setFrequency: (hz: Node<'f32'>) => { freq.store(hz); },
    tick: () => {
      const inc = div(freq.load(), sr);
      phase.store(add(phase.load(), inc));
      return sin(mul(phase.load(), 2 * Math.PI));
    },
    reset: () => { phase.store(0); },
  };
});
```

各 method の 引 数 = per-call で 渡 す (= subgraph 著 作 lambda 引 数 と は 別)。 method の 戻 り 値 形 = §5.5.3 と 同 じ (= `Node<T>` / tuple / record / `void`)。

**Decision (Q34-c — method は 全 context で 呼 べる、 制 約 ナシ):**

`createSubgraph(...)` で 生 成 した instance の method は **全 context で 呼 べる**: `forSample` / `forSample.byN` / `everyNSamples` / `midiInput().onEvent(...)` handler / `messageDecl.onReceive(...)` handler / per-block phase 直 下 全 部 OK。

method 戻 り 値 が `Node<T>` か `void` か で context 制 限 を **入 れ ない** (= 既 unworklet ルール = `state.load/store` / 算 術 primitive が 全 context OK と 同 形)。 user は 「どこ で 何 を 呼 べる か」 を 意 識 し なく て よ い。

```typescript
const osc = createSubgraph(oscillator, ctx.sampleRate);

// MIDI handler 内:
midi.onEvent('noteOn', ({ note }) => {
  osc.setFrequency(noteToHz(note));     // OK (void method)
  const sample = osc.tick();             // OK (Node<'f32'> method、 戻 り 値 を state に 保 存 等)
});

// message handler 内:
reqReset.onReceive(() => {
  osc.reset();                           // OK
});

// forSample 内:
forSample((i) => {
  const y = osc.tick();                  // OK
  audioOut.set(0, i, y);
});

// per-block 直 下:
return {
  process: () => {
    const blockY = osc.tick();           // OK (= block 開 始 時 点 の 1 sample 計 算)
  },
};
```

**Decision (Q34-d — Nested subgraph instantiation):**

`defineSubgraph` body 内 (= subgraph の declaration scope) で 別 `createSubgraph(...)` を 呼 ぶ こと は **OK** (= 既 §5.6.5 の 「declaration scope で の 別 subgraph 呼 び 許 可」 と 整 合)。 instance state は build-time evaluate で 静 的 alloc。

**Rationale (Q34-a):**

- **既 spec の state alloc ルール と 同 形 で 統 一**: state.f32 等 declaration を expression scope で 呼 ぶ の は 既 graph-capture-time error。 `createSubgraph(...)` も state slot alloc を 含 む 動 作 = 同 ルール 適 用 で 「state alloc は declaration scope のみ」 1 ルール で 統 一、 user mental simple
- **canonical Ex2 / Ex8 と の 既 矛 盾 解 消**: 既 canonical で `peakingBand(...)` を forSample 内 で 直 接 呼 ぶ pattern が 既 §5.6.4 「declaration scope only」 と 矛 盾 (= 12-canonical-examples §"What this set does not yet exercise" の Q22-c-Round2 marker)。 (A) 採 用 で 「declaration scope で `createSubgraph(...)` で instance 生 成、 forSample 内 で method 呼 び」 に 整 理 → 矛 盾 解 消
- **declarative 純 度**: user が 明 示 で declaration scope に `createSubgraph(...)` を 書 く = state alloc 場 所 が code 上 で 視 覚 化、 framework 黒 魔 法 ナシ
- **`createSubgraph` 命 名**: 既 main-side の `createNode` (= `05-client.md`) と 命 名 文 化 一 致、 declarative 動 詞、 OO factory pattern 文 化 を 持 ち 込 ま ない

**Rationale (Q34-b):**

- **key 名 著 作 者 free**: 「親 processor の `process` 名 と 一 致」 美 学 で `process` 強 制 する motivation 弱 い、 著 作 者 が `tick` / `render` / `compute` / `setX` / `reset` 等 自 由
- **record return**: 親 `defineProcessor` body の `return { process: () => ... }` 形 と 構 造 一 致 (= 「subgraph も processor も 同 じ 構 造 を return」)、 method 数 が 1 個 でも 複 数 でも form 維 持
- **lambda 引 数 = instance 生 成 時 bind / method 引 数 = per-call**: lambda 引 数 で build-time const (= sample rate 等) を bind、 method 引 数 で per-sample / per-call な `Node<T>` を 渡 す。 declaration scope で per-sample 値 を 渡 せ ない 自 然 帰 結 で TS / graph capture が reject

**Rationale (Q34-c):**

- **既 unworklet ルール の 自 然 帰 結**: `state.load/store` / 算 術 primitive 等 が 全 context OK と 同 形、 「method 戻 り 値 で context 制 限」 は artificial 制 約 で user mental に 不 要 負 担 = 入 れ ない
- **method の use case が 全 context に わ た る**: trigger / config method (= `setX` / `reset`) は handler 内 で の 呼 び common、 per-sample method (= `tick` 等) は forSample 内 common だ が、 「block 開 始 時 の 1 sample 計 算」 「handler 内 で の 1 sample 計 算」 等 全 context で 意 味 ある 呼 び が 存 在
- **(β) superset = optional 拡 張**: 単 一 method (= 例 え ば `process` 1 個) で 書 きた い 著 作 者 は そ の まま、 複 数 method 必 要 な 著 作 者 は 必 要 method declare、 user free。 単 一 形 が 複 数 形 の subset

**Rejected:**

- **`onepole.instance()` / `onepole.create()` (OO factory pattern)**: OO factory 文 化 (= class.new() 寄 り)、 unworklet declarative 哲 学 と 文 化 ズレ。 declarative 動 詞 で 統 一 する `createSubgraph` の 方 が 自 然
- **既 spec の 「直 接 callable」 維 持 (= `const y = onepole(input, coef)`)**: per-sample 引 数 (= forSample i から の `Node<T>`) を declaration scope で 渡 せ ない、 (A) と 矛 盾 = canonical の 矛 盾 そ の も の
- **`subgraph.use(onepole)` (React hook 系)**: `subgraph` namespace が 既 spec に 存 在 し ない 即 興 surface、 「巻 き 上 げ」 を 想 起 さ せる
- **L2 廃 止 (= L1 + caller-owned state pattern のみ)**: stateful 部 品 の encapsulation 死 滅、 caller が 部 品 の 内 部 構 造 (= state 数 / 名 前 / 型) を 知 る 必 要、 「stateful 部 品 を 1 単 位 で 使 え る」 motivation 消 失
- **lifecycle hook 合 成 (= subgraph 内 で `forSample` を 直 接 書 い て 親 forSample に 自 動 inline)**: 「ソース 上 で 書 い た 場 所」 と 「framework 内 部 で の 動 作 場 所」 が 違 う = framework 黒 魔 法、 declarative 哲 学 違 反。 親 が 複 数 forSample 持 つ 時 「subgraph 呼 び を どの forSample 内 で 書 く か」 で 動 作 phase 変 わる、 著 作 者 が 制 御 で きる スコープ を 超 える
- **bind / invoke 引 数 分 離 surface (= per-block / per-sample 別 declare)**: subgraph 著 作 で per-block / per-sample 引 数 区 別 surface 追 加、 caller も 2 段 階。 motivation = 「per-block param を 1 度 だ け evaluate」 だ が、 (A) で も build-time loop 展 開 で 同 等、 surface 増 し で 価 値 弱 い
- **method 戻 り 値 で context 自 動 制 限 (= `Node<T>` → forSample 内 限 定 / `void` → 全 context OK)**: 既 ルール 自 然 帰 結 で ない artificial 制 約、 user mental に 不 要 負 担 (= `feedback_no-artificial-constraint.md` 軸)
- **key 名 `process` 強 制**: 「親 processor と 形 一 致」 美 学 軸 で 強 制 する motivation 弱 い、 user free が default
- **lambda 直 接 return (= record wrap ナシ で `defineSubgraph((args) => Node<T>)`)**: 親 processor の `defineProcessor((ctx) => ({ process: () => ... }))` 形 と 構 造 ズレ、 method 追 加 で form 変 わる = 互 換 性 低 い

---

## Q35 — Render quantum length の user code 露 出 形 (audit Phase 1 #6)

**Status:** resolved.

**Decision:** `SAMPLES_PER_BLOCK: 128` を `@unworklet/core` package の top-level constant と し て export する。 user code は `import { SAMPLES_PER_BLOCK } from '@unworklet/core'` で 引 用 する。 `ctx.renderQuantum` 等 の ctx 経 由 surface は 追 加 し な い。 値 は Web Audio 仕 様 で 全 環 境 共 通 の 128。 authoritative wording は `01-dsl.md` §1.7。

既 canonical で の 直 値 128 散 布 (= `01-dsl.md` 各 § と `12-canonical-examples.md` Example 3 / 4 / 7 / 8 に 跨 が る) お よ び 旧 `renderQuantum` 名 を 引 用 す る prose (= `00-foundations.md` / `03-compiler.md` / `11-midi.md` / `02-messaging.md` / `decisions-log.md`) は `SAMPLES_PER_BLOCK` 経 由 で 引 く 形 に 揃 え る。

**Rationale:**

- **build-time 定 数 と run-time 値 を 区 別**: `sampleRate` は AudioContext 単 位 で 異 な る run-time 値 = ctx 経 由 が 自 然。 `SAMPLES_PER_BLOCK` は Web Audio 仕 様 で 128 固 定 の build-time 定 数 = 意 味 が 異 な る、 ctx に 並 べる と 区 別 が 消 え る
- **ctx scope 外 で の 引 用 可 能 性**: build-time JS 文 脈 (= 別 module の helper / 定 数 定 義 / processor 外 の build-time 計 算) で renderQuantum 値 を 引 用 し た い 場 面 が 自 然 に 発 生 (例: `export const RING_CAP = SAMPLES_PER_BLOCK * 8`)。 ctx 経 由 だ と こ れ が 不 可 能
- **直 値 128 散 布 解 消**: 既 canonical で `const PART_SIZE = 128; // = renderQuantum, partition aligned with block` (= `12-canonical-examples.md` Example 3) の よ う な 「注 釈 で 意 味 を 補 う」 形 が 既 出 = 名 で 引 け る 形 を user が 自 然 に 求 め る signal
- **平 易 名 の 採 用**: 「render quantum」 は Web Audio 仕 様 用 語、 ど ち ら か と 言 え ば 非 直 観。 `SAMPLES_PER_BLOCK` は 「1 塊 あた り の サンプル 数」 が 名 か ら 自 明 で、 仕 様 用 語 を 学 ば な く て も 意 味 が 取 れ る。 docs prose を `SAMPLES_PER_BLOCK` 名 に 寄 せ れ ば 翻 訳 cost も 消 え る

**Rejected:**

- **`ctx.renderQuantum` (= ctx surface に 載 せ る)**: run-time 値 (`sampleRate`) と build-time 定 数 が 同 じ surface に 並 ぶ と 区 別 が 消 え る、 ctx 引 数 が 在 域 し な い 文 脈 で 引 け な い
- **直 値 128 を 書 か せ る (= 露 出 し な い)**: magic number 散 布 + 「= renderQuantum」 注 釈 コメント が canonical で 既 必 要 に な っ て いる = user mental load
- **平 易 別 名 を ctx 上 に (= `ctx.blockSize` / `ctx.samplesPerBlock`)**: build-time 定 数 を ctx に 載 せ る 上 記 問 題 を 引 き ず る
- **ctx surface + module export を 両 方 出 す**: surface 二 重、 user が 「ど ち ら を 使 う か」 判 断 す る 不 要 負 担
- **`forSample` callback 引 数 で `length` を 受 け る (= `forSample((i, length) => ...)`)**: per-block top level で `buffer.f32({ size: length, ... })` が 書 け な い (= callback scope 外)、 主 要 ユース ケース (= buffer サイズ 決 定) と 真 っ 向 矛 盾

---

## Q36 — method 引 数 で の literal lift + typed-array-field proxy semantics + emitIf cond 型 確 定 (audit P0-1)

**Status:** resolved.

**Decision (Q36-a — method 引 数 で の literal lift):**

Q33 を 1 段 拡 張。 method の 引 数 型 が `Node<X>` な ら、 そ こ に 渡 し た JS literal は 自 動 で `Node<X>` に lift。 自 由 関 数 (Q33-a) と 同 形 ル ー ル を method 引 数 に も 適 用。 各 method の 型 は `| TLiteral` (= `T='i32'` → `number`、 `T='bool'` → `boolean`、 `T='f32'`/`'f64'` → `number`) を declared type に 加 え る 形 で 表 現:

```typescript
param.at(i: Node<'i32'> | number): Node<T>
buf.read(idx: Node<'i32'> | number): Node<T>
buf.write(idx: Node<'i32'> | number, v: Node<T> | number): void
buf.readInterpolated(pos: Node<'f32'> | Node<'f64'> | number): Node<T>
audioIn.at(c: ChannelIndex<C> | number, i: Node<'i32'> | number): Node<'f32'>
audioOut.set(c: ChannelIndex<C> | number, i: Node<'i32'> | number, v: Node<'f32'> | number): void
emitIf(cond: Node<'bool'> | boolean, payload: T): void
```

範 囲 制 約 (= 整 数 必 須 / 非 負 必 須 / channel index 上 限 等) は TS 型 で 表 現 し 切 れ な い 部 分 を build 時 reject:

```typescript
param.at("string")     // TypeScript エ ラ ー: 文 字 列 は 通 ら な い
audioIn.at(3.5, i)     // build 時 エ ラ ー: channel index は 整 数 必 須
ir.read(-1)            // build 時 エ ラ ー: 負 値 不 可
```

`param.at(0)` 等 の literal `0` per-block 呼 び は こ の ル ー ル で 型 と 整 合 す る。 Q22-b 不 変 量 「sample-offset primitive は forSample 内 限 定」 は 「forSample 内 で 計 算 し た `i` を 受 け 取 る」 で 維 持 (= 任 意 の `Node<'i32'>` を per-block で 渡 す こ と は 引 き 続 き 不 可)、 literal `0` per-block 呼 び を 例 外 と し て 正 統 化。

**Decision (Q36-b — typed-array-field proxy surface):**

`message<T>` / `event<T>` の payload 可 変 長 typed array field (= 例: `{ samples: Float32Array }` の `samples`) は worklet 内 で **typed-array-field proxy** と し て 露 出。 surface は 以 下 2 method:

- `.length: Node<'i32'>` — graph capture で `Node<'i32'>` に 解 決、 受 信 時 に 確 定 す る payload 長
- `.at(idx: Node<'i32'> | number): Node<T>` — 1 要 素 read。 引 数 が JS number = build 時 折 り 畳 み (= `for` loop で 各 要 素 を 展 開)、 引 数 が `Node<'i32'>` = runtime read

```typescript
// 引 数 = Node、 runtime read (= 例: sample player):
uploadSample.onReceive(({ samples }) => {
  const len = samples.length;
  forSample((i) => {
    const v = samples.at(mod(i, len));
    buf.write(i, v);
  });
});

// 引 数 = JS number、 build 時 折 り 畳 み (= 例: step sequencer):
uploadPattern.onReceive(({ steps }) => {
  for (let s = 0; s < steps.length; s++) {
    const v = steps.at(s);
    pattern[s].store(v);
  }
});
```

bulk transfer は `buf.copyFrom(src: TypedArrayFieldRef<T>): void` (= 既 §3.2) で 全 要 素 を buffer に 一 括 コ ピ ー。 `samples.at(idx)` runtime read は 個 別 要 素 access。 bulk vs 個 別 で 棲 み 分 け、 名 分 離 ナ シ で 同 一 `.at()` の 引 数 種 類 で 内 部 emission が 分 か れ る。

bounds check は runtime read で 自 動: idx が `[0, length)` 外 な ら graph 上 で clamp / select に よ る carrier-clamp で 安 全 値 を 返 す (= 詳 細 emission は spec body `01-dsl.md` §4.3 で 明 文 化)。

**Decision (Q36-c — emitIf cond 型 確 定):**

Q32-b で 「B3 で finalize」 と pending と し た cond の 型 を 確 定:

```typescript
emitIf(cond: Node<'bool'> | boolean, payload: T): void
```

- `boolean` 受 容 (= literal も 計 算 値 も)、 内 部 で Q36-a の literal lift で `Node<'bool'>` に 変 換
- literal `true` / `false` は build 時 折 り 畳 む (= `emitIf(false, payload)` は graph 削 除、 `emitIf(true, payload)` は 無 条 件 emission node、 既 prose 通 り)
- forSample 内 で の constant-truthy cond reject (= Q32-c) は build 時 folding 後 に 適 用、 build-time JS const (= `const FORCE = true; emitIf(FORCE, ...)`) も folding 経 由 で 同 様 に reject

**Rationale:**

- canonical 全 例 が 書 き 換 え 0 で 動 く = 既 動 い て いる code を 正 統 化 す る ル ー ル
- ル ー ル 1 個 追 加 で 3 軸 (= method 引 数 lift / samples.at semantics / emitIf cond 型) 同 時 解 決
- implementor は 各 method の 引 数 型 に `| number` / `| boolean` を 機 械 的 に 加 え る だ け
- `samples.at` の 引 数 種 類 で の 内 部 分 岐 = JS number か Node か で 自 然、 名 分 離 ナ シ
- Q22-b 不 変 量 は 「forSample 内 で 計 算 し た `i` を 受 け 取 る」 で 維 持、 literal `0` per-block 呼 び を ル ー ル と し て 正 統 化

**Rejected:**

- **軸 別 解 (= `samples.atNode(idx)` / `samples.atConst(idx)` 名 分 離 + `param.at(0)` 個 別 例 外 + Q33 拡 大 を 3 つ 別 建 て)**: ル ー ル 3 つ 別 建 て で mental model 重 い、 既 canonical で rename 必 須
- **method を per-block / per-sample で 別 名 化 (= `param.atBlockStart()` / `param.atSample(i)`)**: 各 method surface 2 倍、 canonical 全 行 rewrite、 「動 い て た `.at(0)` が な ぜ 別 名?」 と user 説 明 cost
- **scalar constructor を 強 制 (= `lowF.at(i32(0))` 必 須)**: Q33 で 廃 止 し た 「全 lit 包 み」 を method 引 数 で 復 活 = 既 ratify と 哲 学 ズ レ、 boilerplate 大
- **Q22-b 不 変 量 廃 止 (= audio I/O も per-block 完 全 開 放)**: 「sample-offset は forSample 内 で の み」 と い う 強 い mental model が 崩 れ る、 別 P0 (output coverage) と 相 互 作 用 複 雑、 「`audioIn.at(c, 0)` per-block で 何 を 読 む の?」 (= 前 quantum 最 終 vs 当 quantum 0) の 新 議 論 が 発 生 (= literal `0` per-block 呼 び の み 限 定 開 放 で 十 分)

---

## Q37 — 出 力 channel の 書 き 込 み ル ー ル を 親 ホ ス ト (AudioWorklet) と 揃 え る (audit P0-2)

**Status:** resolved.

**Decision (Q37-a — 出 力 ル ー ル を 親 ホ ス ト と 同 じ に):**

`audioOut.set(c, i, v)` は 自 由 に 何 度 で も 書 け る。 同 sample 位 置 を 複 数 回 書 け ば source 順 で 後 書 き が 勝 つ。 触 ら な い sample 位 置 / 触 ら な い channel は silence (= 0)。 forSample 1 個 で 完 結 / 複 数 forSample で 分 担 / 重 ね 書 き 全 部 OK。

静 的 解 析 で 弾 く の は real-time safety 違 反 (= 上 限 が 決 ま っ て い な い loop、 動 的 alloc、 sample-offset の out-of-block 算 術、 forSample.byN の 違 法 stride 等) の み。 「ど の sample が 何 回 書 か れ た か」 「全 sample を カ バ ー し た か」 は user 責 任 (= AudioWorklet / JUCE の `process` 関 数 メ ン タ ル と 同 じ)。

Output-coverage and duplicate-write checks are **not** part of the spec — `audioOutput.set(c, i, v)` is freely callable, untouched samples are silence, and last-write-wins applies to same-position writes.

**Decision (Q37-b — forSample.byN 中 で の out.set も 同 じ ル ー ル):**

`forSample.byN(stride, callback)` 中 で の `audioOut.set(c, i, v)` は legal。 stride で 飛 ば し た sample 位 置 は (= 別 forSample で 書 か な け れ ば) silence。 (= `audioOut.storeVec` は v1.0.0 SIMD MVP (Q3-b) に 含 ま れ ず、 `forSample.byN` 中 の audio output 書 き 込 み は scalar `audioOut.set` を 反 復 で 行 う。 必 要 性 出 れ ば v1.x.0 で additive 検 討。)

stride 制 約: 1, 2, 4, 8, 16, 32, 64, 128 (= `SAMPLES_PER_BLOCK` = 128 を 割 る 値) 限 定。 そ れ 以 外 (= `forSample.byN(5, ...)` 等) は `forSample.byN` を 書 い た 行 で 静 的 解 析 エ ラ ー (= 端 数 sample が 中 途 半 端 に 残 る の を 防 ぐ)。

**Rationale:**

- **親 ホ ス ト メ ン タ ル と 整 合**: unworklet が build on し て いる AudioWorklet の `process(inputs, outputs)` で は output buffer を 自 由 に touch、 上 書 き OK、 一 部 sample だ け 書 い て 残 り silence も OK。 user の 多 く が 持 つ 既 経 験 (= JUCE / VST / 他 audio framework) で も 同 様。 「exactly once 強 制」 ル ー ル は 親 ホ ス ト メ ン タ ル と 真 逆 で over-constrain
- **declarative 原 則 と 整 合**: declarative の 本 質 は 「user が 書 い た 構 造 が そ の ま ま WASM に な る」 で あ っ て、 「user に exactly once 制 約 を 課 す」 で は な い。 source 順 の write 列 = WASM 同 順 の sequential store
- **典 型 ユース ケ ー ス を サ ポ ー ト**: dry/wet mix-in (= 1 度 dry を 書 い て 後 で wet を 上 書 き)、 channel 分 担 (= forSample 1 で left / forSample 2 で right)、 部 分 sample (= 一 部 sample だ け 書 い て 残 り silence) 等 audio で 普 通 の pattern を 全 て legal に
- **canonical Ex 7 (= SIMD 畳 み 込 み で stride > 1 で out.set 使 用) も legal**: rewrite 不 要

**Rejected:**

- **「ち ょ う ど 1 回 強 制」 (= 既 仕 様 3 文 の 線 を 採 用)**: 親 ホ ス ト メ ン タ ル と 真 逆、 user が 親 ホ ス ト で 慣 れ た 書 き 方 を 全 部 取 り 上 げ ら れ る、 canonical Ex 7 も rewrite 強 制 = over-constrain
- **「1 度 も 書 か な か っ た sample は エ ラ ー、 二 重 書 き は OK」 (= 中 間 案)**: silence 暗 黙 fill ケ ー ス (= 一 部 sample だ け 書 い て 残 り 0) を 弾 く、 親 ホ ス ト と ズ レ、 「silence fill 意 図 な ら `out.set(c, i, 0)` で 明 示」 を user に 強 制 = 親 ホ ス ト で 不 要 な 手 数
- **「forSample.byN 中 で out.set 禁 止 (= storeVec 必 須)」**: scalar set も 親 ホ ス ト で 普 通、 禁 止 は over-constrain
- **「forSample.byN 中 の `out.set(0, i, v)` を 同 値 stride 個 並 べ る broadcast と 解 釈」**: SIMD 計 算 結 果 は 通 常 各 sample で 違 う 値、 同 値 連 続 ケ ー ス は ほ ぼ な い、 意 味 論 不 自 然

---

## Q38 — `onReceive` (= main → worklet message handler) の 振 る 舞 い (audit P0-3、 Phase 1 #4)

**Status:** resolved.

**Decision (Q38-a — timing = 当 1 塊 開 始 時):**

handler は **当 1 塊 (= 走 っ て いる render quantum)** の 開 始 時 に audio thread 上 で 走 る。 worklet 著 作 者 視 点 で 「current render quantum」、 main 著 作 者 視 点 で 「次 render quantum (= `node.messages.<name>(...)` を 呼 ん だ 直 後 の 次 quantum)」、 同 じ 瞬 間 を 視 点 違 い で 呼 ん で いる だ け。 docs 表 記 は **worklet 著 作 者 視 点 (= 「current」 / 「当 1 塊」) に 統 一**。

docs 全 体 で の 表 記 は worklet 視 点 で 統 一 (= 「current render quantum」)、 main 視 点 で の 「next」 描 写 が 必 要 な 箇 所 は cross-ref で 補 う。

**Decision (Q38-b — 実 行 順 序 = 全 handler が 先 行、 そ の あ と per-block + forSample):**

著 作 者 が source 順 で 並 べ た handler 登 録 (= `messageDecl.onReceive(...)` / `midiInput().onEvent(...)` の 行) は **graph capture (= コ ン パ イ ル) 時 の 登 録 行 為**。 runtime で は 1 塊 開 始 時 に:

1. 全 handler を message drain 順 で 全 部 走 ら せ る (= AudioWorklet の `port.onmessage` が process 開 始 前 に drain さ れ る 振 る 舞 い と 整 合)
2. そ の あ と per-block (= forSample 外) 計 算 + forSample 群 が source 順 で 走 る

`01-dsl.md` §1 「body は top-to-bottom (= source 順) で 動 く」 は **コ ン パ イ ル 時 の graph capture の 順 序 ル ー ル**、 runtime 実 行 順 序 は handler 群 が 必 ず 先 行 す る。

**Decision (Q38-c — 1 message に 複 数 `onReceive` OK):**

1 message に 対 し て `onReceive` を 複 数 登 録 可 能、 graph capture 中 に 登 録 さ れ た 順 で drain 時 に 全 部 走 る (= 後 か ら 登 録 し た handler が 前 の を 上 書 き す る わ け で は な く 両 方 走 る)。 user free が default で 制 約 ナ シ。

**Decision (Q38-d — state 観 測):**

- handler 内 で `state.load()` = **当 1 塊 開 始 時 の 値 (= 前 1 塊 末 尾 で 書 か れ た 値)** を 観 測
- handler 内 で `state.store(v)` し た 値 は、 当 1 塊 の per-block 計 算 + forSample で 観 測 可 能 (= Q38-b の handler 先 行 か ら の 自 然 帰 結)

**Rationale:**

- **親 ホ ス ト 整 合**: AudioWorklet の `MessagePort.onmessage` は process 関 数 の 外 で 走 り、 process 開 始 時 に は 反 映 済 み = 「全 handler 先 行」 と 同 じ 効 果。 user が AudioWorklet で 持 つ mental を そ の ま ま 使 え る
- **canonical Ex 5 の 構 造 を 正 統 化**: handler 登 録 → per-block 計 算 → forSample と い う 並 び で、 「per-block 計 算 で handler の `state.store(...)` を 読 め る」 が 期 待 通 り
- **視 点 違 い 表 記 の 統 一 で 矛 盾 解 消**: 既 仕 様 3 箇 所 (`01-dsl.md` §4.2 / `02-messaging.md` §1 / Q31-a) の current/next 混 在 を worklet 視 点 で 統 一

**Rejected:**

- **source 順 (= handler 登 録 行 で 即 handler が 走 る、 そ の あ と 後 続 の per-block 文)**: 「handler 登 録 後 の per-block 文 で 反 映 済 み」 を user が source 上 で 直 接 確 認 で きる が、 graph capture と runtime の 区 別 を user が 強 く 意 識 す る、 AudioWorklet `onmessage` 振 る 舞 い と も ズ レ
- **1 message = 1 handler 強 制 (= 2 度 目 の `onReceive` は コ ン パ イ ル 時 エ ラ ー)**: artificial 制 約、 user free が default
- **timing 表 記 = 「next」 (= main 視 点 で 統 一)**: worklet 著 作 者 視 点 で 「次」 と 言 う と 「今 動 い て いる の は ど の 塊?」 と 違 和 感、 動 い て いる 塊 を 「当 1 塊 (= current)」 と 表 現 す る の が 自 然

---

## Q39 — publish の 版 counter increment ル ー ル + main 側 dedupe 政 策 (audit P0-4)

**Status:** resolved.

**Decision (Q39-a — audio thread = 無 条 件 で store + 版 inc):**

audio thread の publish 処 理 は due tick (= `rateFps` で 決 ま る 周 期) で:

1. 現 在 値 を SAB の shared region に store
2. slot の 版 counter (= `02-messaging.md` §5.4 の 「version」 i32) を **無 条 件 で** inc (= 既 値 と の 比 較 + branch ナ シ)

= audio thread に は 2 つ の atomic operation だ け、 値 比 較 cost を 載 せ な い、 real-time hard 制 約 と 整 合。

**Decision (Q39-b — main 側 = 版 advance 時 に handler を 必 ず 呼 ぶ):**

main 側 `node.state.<name>.subscribe(handler)` の 振 る 舞 い:

- 版 counter が advance し た tick で、 新 値 を SAB か ら 読 ん で handler を **必 ず 呼 ぶ**
- framework 側 で 値 比 較 し て handler skip し な い (= scalar / buffer / 全 type 共 通 ル ー ル)
- user が 同 値 dedupe 欲 し い な ら handler 内 で 1 行 で 比 較 す る (= `if (newVal === lastVal) return`)

「dedupe / coalesce」 prose は 仕 様 に 含 ま れ な い:

- `02-messaging.md` §5.4 の 「incremented on each publish tick where the value changed」 → 「無 条 件 inc」 に 改 訂
- `05-client.md` §1 の 「Handler fires on each publish tick where the value differs from the last delivered value」 → 「版 advance 時 に 必 ず 呼 ぶ」 に 改 訂
- `05-client.md` §5.2 の 「Identical re-publishes are coalesced — handlers are not invoked when the published value matches the last delivered one」 → 撤 去、 「framework は 値 比 較 し な い、 dedupe が 欲 し い user は handler 内 で」 に 改 訂

**Rationale:**

- **real-time 友 好**: audio thread は 既 値 比 較 + branch 無 し で 2 atomic op の み = publish slot 数 ・ rateFps が 増 え て も audio thread cost が 線 形 + 軽 い
- **use case 別 で dedupe 要 不 要 が 違 う**:
  - UI 更 新 (= React state へ reflect) → React 側 で 既 dedupe、 unworklet 側 で の 追 加 dedupe 不 要
  - periodic poll (= meter 値 を log / 録 画) → 同 値 で も 毎 tick 呼 ば れ た い、 dedupe は 邪 魔
  - event-like notify (= state.bool で 「note 開 始」) → 変 化 時 だ け 呼 ば れ た い、 ただし user 1 行 で 解 決 可
- **framework が user handler を skip = magic anti-pattern**: `feedback_framework-magic-anti-pattern.md` 軸、 framework が user 期 待 ナ シ で 動 作 削 る の は declarative 原 則 (= user が 書 い た 構 造 = framework 動 作) と ズ レ。 dedupe 機 構 は user choice に

**Rejected:**

- **audio thread で 既 値 と 比 較 し て、 変 化 時 だ け 版 inc**: 全 publish slot で 毎 due tick で 比 較 + branch、 audio thread に 余 計 な cost = real-time 重 視 の unworklet 哲 学 と ズ レ
- **main 側 で scalar slot だ け 値 比 較 で dedupe (= buffer は ナ シ)**: framework が user handler を skip = magic anti-pattern、 use case 別 で dedupe 要 不 要 が 違 う の に 一 律 強 制
- **main 側 で buffer slot も 値 比 較 で dedupe**: 全 要 素 比 較 cost が main で 大 (= buffer は 数 百 〜 数 千 要 素)、 dedupe 利 益 が cost を 上 回 ら な い + magic anti-pattern

---

## Q40 — `node.midi` の main 側 surface 形 (audit P0-5、 Phase 1 #5)

**Status:** resolved.

**Decision:**

main 側 で MIDI port に 触 る surface を **`node.midi.<name>.send(...)` / `.onEvent(...)` / `.connectFromWebMIDI(...)` / `.diagnostics.overflowCount(...)` の namespaced 形 に 統 一** す る。 single-port で も namespaced 形 で 書 く (= `node.midi.send` の よ う な flat 形 は 全 廃)。

= 既 Q4-a で `node.midi.<name>` を ratify 済 み だ っ た が、 body docs (= `11-midi.md` §3 / §4) + `05-client.md` §1 + canonical (= Ex 5 / Ex 6 / Ex 8) で flat 表 記 (= `unworkletNode.midi.send` / `node.midi.connectFromWebMIDI` 等) が 残 っ て お り、 multi-port processor (= dualPort 等) を main か ら addressable に す る 経 路 が 仕 様 上 不 明 な 状 態 だ っ た。 Q40 で body 反 映 を 完 成 + canonical 修 正。

```typescript
// worklet 側 宣 言:
const midi = midiInput({ name: 'main' });
const out  = midiOutput({ name: 'controlOut' });

// main 側 access:
node.midi.main.send({ type: 'noteOn', note: 60, velocity: 127 });
node.midi.main.connectFromWebMIDI(webMidiInput);
node.midi.controlOut.onEvent('noteOn', (e) => { ... });
const dropped = node.midi.main.diagnostics.overflowCount();

// multi-port も natural:
const inA = midiInput({ name: 'keyboard' });
const inB = midiInput({ name: 'controller' });
node.midi.keyboard.send({ type: 'noteOn', ... });
node.midi.controller.onEvent('controlChange', (e) => { ... });
```

**Rationale:**

- **他 全 declaration と 一 貫**: `node.inputs.<name>` / `node.outputs.<name>` / `node.events.<name>` / `node.messages.<name>` / `node.state.<name>` / `node.params.<name>` 全 て が namespaced 形、 midi も 同 形 で 揃 え る = user mental が 1 つ
- **multi-port が natural に 表 現**: dualPort 等 で port ご と に send / onEvent を 区 別、 flat 形 で は 表 現 不 能
- **single-port boilerplate は declaration 形 と 一 致**: `midiInput({ name: 'main' })` で declare し て `node.midi.main.send(...)` で 触 る、 declaration / access で name が 同 じ = 学 び 直 し ナ シ
- **既 Q4-a で 既 に ratify 済 み の 形**: 別 案 で は な く 反 映 不 足 の 解 消

**Rejected:**

- **flat 形 (= `node.midi.send` / `node.midi.onEvent`)**: 既 canonical だ が multi-port 表 現 不 能、 他 全 declaration と 不 整 合
- **hybrid (= 単 port 時 flat、 複 数 port 時 namespaced)**: surface 二 重、 1 → 2 port 追 加 時 に main 側 code 全 行 rewrite 必 要、 学 習 cost 大
- **default 名 'midi' を 暗 黙 適 用 (= midiInput() で name 省 略 可、 main 側 で flat alias)**: 既 Q4-a (= name 必 須) と 矛 盾

---

## Q41 — `createSubgraph` の instance name 渡 し 方 (audit P0-6、 Phase 2 #16)

**Status:** resolved.

**Decision:**

`createSubgraph` の signature を Q34 既 form の 末 尾 に optional options を 追 加 す る 形 で 拡 張:

```typescript
createSubgraph(
  subgraph: SubgraphDecl,
  ...lambdaArgs: LambdaArgs,
  options?: { name?: string }
)
```

**options 自 体 が optional、 name property も optional**。 snapshot を 取 ら な い subgraph (= 多 く の 一 般 ケ ー ス) は 何 も 渡 さ ず に 書 け る。

```typescript
// (A) snapshot 不 要 な subgraph (= 多 く の 一 般 ケ ー ス):
const lowL = createSubgraph(peakingBand, ctx.sampleRate);   // options ナ シ で OK

// (B) snapshot 必 要 な subgraph (= persistent state を 経 由 す る):
const filterL = createSubgraph(filterCore, ctx.sampleRate, { name: 'filterL' });
const filterR = createSubgraph(filterCore, ctx.sampleRate, { name: 'filterR' });
```

snapshot path は 「`<instance-name>/<inner-slot-name>`」 形 (= 例 「`filterL/z1`」)。 subgraph 内 に snapshot 'persistent' の state が あ り、 processor 側 が snapshot を 取 ろ う と し て いる が subgraph instance に name ナ シ の 場 合、 graph-capture-time で エ ラ ー:

```text
graph-capture-time error:
  subgraph instance at line N requires a `name` option for snapshot path.
  reason: this subgraph declares persistent state (e.g. filterCore's `z1`)
          and the processor's snapshot would have no way to identify which
          instance owns the value.
  Hint: createSubgraph(filterCore, ..., { name: 'filterL' })
```

既 `01-dsl.md` §8.1 prose 「subgraph instances must also carry a name option」 は 「snapshot を 取 る 場 合 に は name option 必 須」 に 寄 せ る。 §8.1 の pre-Q34 直 接 callable form の example も Q34 + Q41 form (= `createSubgraph(..., { name: 'lpfL' })`) に 修 正。

**Rationale:**

- **user free が default、 制 約 は justify 必 要** (= `feedback_no-artificial-constraint.md`): name の 主 motivation は snapshot path identity だ け、 snapshot 取 ら な い subgraph で name 強 制 す る motivation 弱 い
- **Q34 既 form を 維 持 し て 拡 張 だ け**: form 破 棄 ナ シ、 末 尾 に optional options を 追 加 で 既 canonical (= name ナ シ で 既 動 い て いる) も そ の ま ま 通 る
- **snapshot path 不 整 合 は graph-capture-time で 弾 く**: silent footgun ナ シ、 build 時 で エ ラ ー が 出 て user は name 追 加 で 解 決

**Rejected:**

- **name 全 case 必 須**: snapshot 不 要 な subgraph で boilerplate 強 制 = user 不 要 負 担、 motivation 弱 い
- **options を 第 1 引 数 化 (= `createSubgraph({ subgraph, name }, ...args)`)**: 既 Q34 form 破 棄、 canonical 全 rewrite、 form 変 更 の 価 値 (= 「options が 先 頭 で 整 合」) が cost を 上 回 ら な い
- **method chain `.named('lpfL')`**: name optional で も 「snapshot 取 る 時 に build-time エ ラ ー」 が 取 り に く い (= chain の 有 無 を 型 で 強 制 で きな い)
- **snapshot 識 別 を name 不 要 (= subgraph 内 state は snapshot 対 象 外 or 自 動 識 別)**: subgraph 内 で persistent state を snapshot に 反 映 す る use case が 不 能、 declarative DSL の 表 現 力 後 退
- **name は必 須 だ が optional な extra options を 末 尾 で**: name optional 化 で 「snapshot 不 要 な ら 何 も 書 か な い」 を 実 現 し た 上 で、 さ ら に options 自 体 も optional で OK = 「options object も optional」 と 「name も optional」 の 両 方 を 受 け 入 れ る 形 で boilerplate 最 小

---

## Q42 — `state.publish` 対 応 type と state.bool の WASM 表 現 (audit P0-7)

**Status:** resolved.

**Decision:**

`state.<type>(initial, { publish: { rateFps } })` で publish オ プション を 渡 せ る type を **f32 / i32 / bool の 3 つ に 限 定**。 state.f64 / state.i64 で publish オ プション を 渡 す と TypeScript エ ラ ー。

3 type は い ず れ も 値 が 32 bit 1 word で 完 結 す る ため、 audio thread が `Atomics.store` で 1 回 で 書 き、 main thread が `Atomics.load` で 1 回 で 読 ん で torn read ナ シ で 完 全 同 期。

state.bool は WASM レ ベ ル で `i32` (= 0 / 1) で 表 現、 audio thread 側 で `condValue ? 1 : 0` を `Atomics.store` す る。 main side `.value` で boolean に cast し て 返 す:

| type | `.value` の TS 型 | publish 可 否 |
|---|---|---|
| f32 | `number` | OK |
| i32 | `number` | OK |
| bool | `boolean` (内 部 i32 を cast) | OK |
| f64 | `number` | TS エ ラ ー (v1.0.0 で 不 可) |
| i64 | `bigint` | TS エ ラ ー (v1.0.0 で 不 可) |

f64 / i64 publish エ ラ ー の hint:

```typescript
state.f64(0, { name: 'p', publish: { rateFps: 30 } });
// TypeScript エ ラ ー:
//   `publish` option は f32 / i32 / bool で の み 利 用 可 (v1.0.0)。
//   Hint: f32 で 代 用 可 な ら f32 へ。 64 bit 精 度 が 必 要 な 場 合 は
//         v1.x.0 で の 追 加 を 待 つ (= torn read mitigation と セ ット)。
```

**Rationale:**

- **declarative + footgun 撤 廃 哲 学 と 整 合**: f64 / i64 を v1.0.0 で 開 放 す る と torn read footgun を user に 押 し 付 け る = `feedback_framework-magic-anti-pattern.md` 系 (= 「user が 書 い た 通 り に 動 か な い」 silent 不 整 合) を v1.0.0 で 入 れ な い
- **既 Q27-f (= buffer publish の torn read を v1.x.0 で mitigation) と 同 軸**: scalar publish も 「torn read が 起 きる type は v1.0.0 で 提 供 し ない」 で 一 貫
- **canonical の publish 使 用 実 績 は 全 て f32 / i32 / buffer.f32**: bool publish は 自 然 な use case (= 「note 鳴 っ て いる か」 「mute か」) で 採 用 価 値 あ り、 f64 / i64 publish の 実 用 要 求 は v1.0.0 内 で は ナ シ

**Rejected:**

- **全 type で publish OK + f64 / i64 は torn read 警 告 を doc に**: user に 警 告 押 し 付 け = footgun 開 放、 declarative 原 則 と ズ レ
- **f32 / i32 だ け publish OK (= bool 除 外)**: bool flag を main に 出 す 自 然 な use case を 排 除、 過 度 制 約
- **bool を bit-packed で 表 現 (= 32 個 を 1 word に 詰 め る)**: メ モ リ 効 率 あ る が atomic 操 作 が 複 雑 化 (= bit mask + compare-and-swap)、 cost が 利 益 を 上 回 る

---

## Q43 — `everyNSamples` を `forSample` callback 引 数 経 由 で 取 る (audit P0-8)

**Status:** resolved.

**Decision:**

`everyNSamples` を free function import (= `import { everyNSamples } from 'unworklet'`) か ら **`forSample` callback の 第 2 引 数** に refine。 既 Q7 が ratify し た 「forSample 内 限 定」 制 約 を、 build-time context tracking で は な く TypeScript の scoping で 自 然 に 表 現:

```typescript
forSample((i, everyNSamples) => {
  everyNSamples(48, () => { /* sub-rate body */ });
});

forSample.byN(4, (i, everyNSamples) => {
  everyNSamples(256, () => { /* sub-rate body, counter は stride 4 で 進 む */ });
});
```

- `everyNSamples` は forSample / forSample.byN callback の 第 2 引 数 で 渡 さ れ る。 callback 内 で の み 在 域、 outside で 使 う と TypeScript reference error (= 既 `i` と 同 軸 で 統 一)
- 第 2 引 数 は optional (= TS で `(i: Node<'i32'>, everyNSamples?: EveryNSamples) => void` 形)、 必 要 な 時 だ け 取 る、 既 `(i) => ...` な canonical は 影 響 ナ シ
- handler context (= MIDI / onReceive 等) で 呼 ぶ こ と は そ も そ も scope に な い ため 不 可、 build-time context tracking ロ ジ ッ ク 不 要
- subgraph method 内 で sub-rate 使 う 場 合 は method 内 で 自 前 の forSample を 書 き 引 数 で 取 る、 caller の context (= forSample 内 か handler 内 か) と は 独 立、 method 側 で 完 結
- counter は 各 `everyNSamples(N, cb)` 呼 び 出 し ご と に 独 立、 1 塊 を 越 え て 連 続 (= 各 forSample iteration で 1 進 む、 forSample.byN(stride) で stride 進 む)、 1 塊 境 界 や 処 理 開 始 で reset ナ シ

`everyNSamples` は free function import で は な く `forSample` callback の 第 2 引 数 と し て 提 供 さ れ る (Q7 を refine し た 形)。

**Rationale:**

- **既 `i` と 同 軸 で 統 一**: forSample callback で sample-offset `i` を 引 数 で 渡 す pattern (= Q22-b) が 既 確 立、 everyNSamples も 同 軸 で 「forSample 内 で の み 在 域 す る primitive」 と し て 統 一 ⇒ user mental 1 つ
- **build-time context tracking 不 要**: 「forSample 内 限 定」 を 構 文 (= scoping) で 表 現、 compiler 側 で 特 別 な context check ロ ジ ッ ク を 持 た な く て 良 い
- **subgraph method 伝 播 が 自 然 解 決**: method 内 で 自 前 forSample を 書 け ば 引 数 で 取 れ る、 caller の context tracking 不 要 (= 元 案 で の 「method 内 で everyNSamples 含 む と method 自 体 が forSample 限 定 に な り caller context を build-time check」 が 消 失)

**Rejected:**

- **free function + build-time check で context 制 限**: compiler 側 で 特 別 な context tracking 必 要、 callback 引 数 で 構 文 的 に scope 切 る 方 が 単 純 で 既 `i` と 一 貫
- **handler context で も 動 か す**: handler は 1 塊 1 回 で sample 進 ま な い、 「N sample ご と」 と 名 乗 る の に sample rate semantics が 取 れ な い = 名 と 動 作 が ズ レ
- **options bag 経 由 (= `forSample((i, { everyNSamples }) => ...)`)**: 拡 張 性 あ る が v1.0.0 で everyN だ け な ら 直 接 引 数 で 十 分、 destructuring boilerplate 増
- **counter を 1 塊 境 界 で reset**: 「N sample ご と」 が 1 塊 境 界 で 切 れ る、 名 と 動 作 が ズ レ

## Q44 — ringbuffer capacity を power-of-2 制 約 で 受 け 取 る 形 (audit P1 #61 仕 様 ホ ー ル)

**Status:** resolved.

### Problem

`midiInput` / `midiOutput` / `event<T>` / `message<T>` の `capacity` option は 内 部 実 装 で **power-of-2 が 必 須** (= ringbuffer の wrap が bitmask `index & (capacity - 1)` で 1 命 令 で 取 れ る、 modulo `%` は 数 倍 遅 い)。 ただし v1.0.0 で 「capacity option の 型 が `number` の ま ま」 だ と user は `capacity: 100` の よ う な 任 意 数 字 を 渡 せ て し ま い、 runtime check (= 「power-of-2 で な い」 で throw) に 落 ち る か silent な wrong-behavior に な る。 IDE 段 階 で 即 弾 く 形 が 求 め ら れ た。

### Decision

`capacity` option 値 を `@unworklet/core` の top-level SCREAMING_SNAKE constant **`CAPACITY_<N>`** 系 で 受 け 取 る:

```typescript
import { CAPACITY_256, CAPACITY_1024 } from '@unworklet/core';

const ringIn  = midiInput({ name: 'midiIn', capacity: CAPACITY_256 });    // default
const dense   = midiInput({ name: 'heavy',  capacity: CAPACITY_1024 });   // override
const evt     = event<T>({ name: 'peak',    capacity: CAPACITY_512 });
```

- export 対 象: `CAPACITY_16 / CAPACITY_32 / CAPACITY_64 / CAPACITY_128 / CAPACITY_256 / CAPACITY_512 / CAPACITY_1024 / CAPACITY_2048 / CAPACITY_4096 / CAPACITY_8192 / CAPACITY_16384` (= 2^4 〜 2^14)
- 型: `type Capacity = typeof CAPACITY_16 | typeof CAPACITY_32 | ... | typeof CAPACITY_16384` の literal union
- `capacity?: Capacity` を option 型 に 持 つ
- 任 意 数 字 リ テ ラ ル (= `capacity: 100`) は TS narrow で 別 物 扱 い、 IDE 段 階 で 即 TS エ ラ ー で 弾 く
- build-time / runtime check 不 要 (= TS 段 階 で 全 部 弾 く)
- option 名 (= `capacity`) と prefix (= `CAPACITY_`) が 1:1 で 揃 う

`SAMPLES_PER_BLOCK` (Q35) と 同 軸 (= top-level constant export で コ ン パ イ ル 段 階 で 固 定)。 内 部 実 装 jargon (= ring / slot / bitmask) を user 露 出 し な い。

### Why this and not alternatives

- **`capacity: number` の ま ま で runtime check で 弾 く 棄 却**: user は IDE で エ ラ ー 出 な い ま ま run し て 初 め て 「あ あ、 power-of-2 必 須 だ っ た」 と 気 づ く = footgun、 spec で 弾 け る も の は IDE 段 階 で 弾 く 方 針 と 衝 突
- **literal union `capacity?: 16 | 32 | 64 | ... | 16384` 棄 却**: TS 型 と し て は 弾 け る が、 user が 「な ぜ こ の 数 字 限 定?」 と 質 問 し た 時 docs を 読 み に 行 か な い と 答 え が 出 な い (= 命 名 が ガ イ ド し て く れ な い); 上 記 SCREAMING_SNAKE constant な ら 「あ あ こ の 一 覧 か ら 選 ぶ」 が IDE 補 完 で 即 分 か る
- **prefix を `RING_<N>` / `SLOT_<N>` 棄 却**: 内 部 実 装 jargon (= ringbuffer / slot) を user 露 出、 余 湖 さ ん feedback 「RING の 方 が user 目 線 で 意 味 不 明」 で 棄 却、 option 名 `capacity` と prefix `CAPACITY_` を 揃 え る

### Side effects

- 01-dsl.md §4.1, §4.2: `capacity` option 型 を `Capacity` (= literal union) に refine、 import 行 を canonical examples に 追 加
- 11-midi.md §1: `midiInput` / `midiOutput` の `capacity` option を 同 様 に refine
- canonical examples (= Ex 5 / Ex 6 等): `capacity: 256` → `capacity: CAPACITY_256` 等 mechanical 修 正 (= 既 commit 6fea6b2 / d4d80dc で 反 映 済 み)

---

## Q45 — migration 関 数 が throw し た 時 の framework 振 る 舞 い (audit #63 仕 様 ホ ー ル)

**Status:** resolved.

### Problem

`defineProcessor` の migration chain (= 01-dsl §8.3) は こ う 書 く:

```typescript
defineProcessor(() => { /* declarations */ }, {
  migrations: [
    { from: 'a...', to: 'b...', migrate: (oldBlob, helpers) => { /* lift */ } },
    { from: 'b...', to: 'c...', migrate: (oldBlob, helpers) => { /* lift */ } },
  ],
});
```

`migrate` 関 数 内 で user が throw す る ケ ー ス が あ る (= schema 想 定 外、 invariant 違 反、 unexpected error)。 framework の 振 る 舞 い (= catch / skip / partial restore / propagate) と main 側 `node.restore(blob)` の 戻 り 値 で の 失 敗 情 報 報 告 形 が 未 spec だ っ た。

### Decision

migration chain 内 で `migrate` が throw し た 時:

1. **framework が catch**: main 側 `node.restore(blob)` Promise は reject さ せ な い (= audio plugin 全 体 が pending に な ら な い)
2. **chain 全 体 stop**: 失 敗 step 以 降 を walk し な い (= 後 続 step の input が 不 完 全 で 危 険 ため、 部 分 restore せ ず)
3. **processor は default 値 で 起 動**: 既 Q5 「default 値 で 動 く」 通 り、 audio 出 力 は 止 ま ら ず default で 始 ま る
4. **戻 り 値 で 失 敗 情 報 報 告**: `node.restore(blob)` の 戻 り 値 を discriminated union で 拡 張:

```typescript
type RestoreResult =
  | { ok: true;  applied: string[]; restored: number; skipped: string[]; missing: string[] }
  | { ok: false; error: { step: string; message: string; cause: unknown };
                  applied: string[]; restored: number; skipped: string[]; missing: string[] };

const result = await node.restore(blob);
if (!result.ok) {
  console.warn(`preset partially loaded; failed at ${result.error.step}:`, result.error.message);
}
```

audio thread 上 で の 例 外 propagate ナ シ (= realtime safety 維 持)、 main 側 で UI / log に warning を 出 す pattern が canonical Ex 7 と 整 合。

### Why this and not alternatives

- **catch せ ず Promise reject 棄 却**: audio plugin で preset load 失 敗 = plugin 全 体 pending、 default 起 動 し な い と audio 出 ナ シ で UX 最 悪
- **catch + 部 分 restore (= 失 敗 step 飛 ば し て 後 続 続 行) 棄 却**: 後 続 step の input が 不 完 全 = 二 重 bug 危 険、 chain stop が 安 全
- **audio thread で 例 外 propagate 棄 却**: audio thread で の throw = 音 切 れ で UX 最 悪、 realtime safety 違 反

### Side effects

- 01-dsl.md §8.3.3: migration chain throw 時 の 振 る 舞 い 段 落 を 追 加
- 05-client.md §2.6: `RestoreResult` を discriminated union (= `{ ok: true } | { ok: false, error: ... }`) に 拡 張、 既 `{ restored, skipped, missing }` field は 維 持
- canonical Ex 7: `if (result.skipped.length || result.missing.length)` を `if (!result.ok || result.skipped.length || ...)` 等 に refine (= 既 commit fd138ce で 反 映)

---

## Q46 — `MidiEvent` / `event<T>` の cross-thread 型 view 分 離 (audit Phase 2 #8、 #47)

**Status:** resolved.

### Problem

`MidiEvent` は 11-midi.md §2.2 で 1 つ の TypeScript 型 と し て 宣 言 さ れ て お り、 全 numeric field が `number` だ っ た:

```typescript
type MidiEvent =
  | { type: 'noteOn'; channel: number; note: number; velocity: number; atSample: number }
  | ...;
```

し か し §2.3 prose は 「`atSample` is a `Node<'i32'>` in the same dimension as `i`」 と 言 い、 worklet handler 内 で user は `noteState.store(note)` の よ う に Q22 graph-capture 値 と し て note / velocity / atSample を 触 る。 つ ま り **TS の 型 (= `number`) が worklet handler 内 で の 実 体 (= `Node<'i32'>`) と 乖 離 し て user に 嘘 を 言 う 状 態** だ っ た。

同 じ 構 造 上 の 問 題 が `event<T>` (= worklet → main 汎 用 イ ベ ン ト) に も あ り、 user が 書 い た `T = { level: number }` は main 側 で は `number` だ が worklet emit-site で は `Node<'f32'>` (or `Node<'i32'>`) に な る べ き 値 で あ る。

### Decision

main thread / wire 用 と worklet audio-thread 用 で **TypeScript 型 を 2 つ に 明 示 分 離** す る。

```typescript
// 既 宣 言: main thread / wire 用 — 全 numeric field native
type MidiEvent =
  | { type: 'noteOn'; channel: number; note: number; velocity: number; atSample: number }
  | ...;

// 新 規: worklet audio-thread 用 — 全 numeric field Node<'i32'>
type MidiEventGraph =
  | { type: 'noteOn'; channel: Node<'i32'>; note: Node<'i32'>; velocity: Node<'i32'>; atSample: Node<'i32'> }
  | ...;
```

- `MidiEvent`: `node.midi.<name>.send(...)` の 引 数、 `.onEvent(...)` の handler 引 数 (= main 側) で 使 う
- `MidiEventGraph`: `midiInput().onEvent(...)` の handler 引 数、 `midiOutput().emitIf(...)` の `event` 引 数 (= worklet 側) で 使 う

emit-side で number / boolean literal を 書 く と Q33 (= literal-lift) で 自 動 に Node<'i32'> / Node<'bool'> に lift さ れ る た め、 user は `atSample: 0`, `note: 60` を そ の ま ま 書 け る:

```typescript
midiOut.emitIf(cond, {
  type: 'noteOn',
  channel: 9,                     // number literal → Node<'i32'> (Q33 lift)
  note: noteNode,                 // already Node<'i32'> — passes through
  velocity: 100,                  // number literal → Node<'i32'> (Q33 lift)
  atSample: i,                    // Node<'i32'> from forSample callback
});
```

handler 側 で の 受 け 取 り は MidiEventGraph shape:

```typescript
midiIn.onEvent('noteOn', ({ note, velocity, atSample }) => {
  //                       ↑ Node<'i32'> 全 て
  noteState.store(note);          // OK — store は Node<'i32'> を 受 け る
  const norm = div(velocity, 127); // 127 は Q33 lift で Node<'i32'>
});
```

`event<T>` も 同 様 に 2 view 派 生:

- main 側 handler: `T & { atSample: number }` (= user 宣 言 `T` + framework 追 加 `atSample`)
- worklet 側 emit: `T` の 全 number → Node<'i32'>、 全 boolean → Node<'bool'>、 全 Float32Array / Uint8Array → §4.3 typed-array-field proxy

typed-array-field の 扱 い は Q36-b に follow (= proxy 経 由 で `.at(idx)` / `.length`)。

### Why this and not alternatives

- **嘘 の 型 の ま ま 1 型 で 通 す (= 案 1 棄 却)**: user が TS で hover し た 時 `note: number` と 出 て し ま う、 で も `velocity / 127` が 実 際 は graph 演 算 — type と 実 体 が 嘘 関 係 で mental model 破 綻
- **全 fields を `Node<'i32'>` で 1 型 (= 案 C 棄 却)**: main 側 で `evt.atSample / sampleRate` が `Node<'i32'> / number` で type error、 audio-graph 概 念 が main に 漏 れ て 意 味 不 明
- **mapped 型 `ToGraph<MidiEvent>` で 元 型 1 つ + 派 生 (= 案 E 棄 却)**: TS の error message と IDE hover で `ToGraph<MidiEvent & { type: 'noteOn' }>` が 出 て user 認 知 負 担 高 い、 名 前 で 直 接 区 別 で きる 案 2 (= 明 示 2 型) の 方 が docs で 1 行 説 明 可
- **`number | Node<'i32'>` の union 1 型 (= 案 D 棄 却)**: handler 内 で user が narrow し な い と 演 算 で き な い、 main 側 で も union が 残 る = 両 context 共 に 不 便

採 用 案 (= 案 B / 案 2) は 「main / worklet で 値 の 種 類 自 体 が 違 う」 と い う 実 体 を そ の ま ま 型 名 に 反 映 す る = mental model 直 接、 user は `MidiEvent` (main 用) / `MidiEventGraph` (worklet 用) を 名 前 で 即 区 別 で きる。 type surface 1 個 増 え る cost は docs で 1 行 説 明 で 償 却。

### Side effects

- 11-midi.md §2.2 で type 宣 言 が `MidiEvent` + `MidiEventGraph` の 2 つ に な る
- 11-midi.md §2.3 で 「`atSample` is a Node<'i32'>」 prose を 「全 numeric fields (= note / velocity / channel / atSample) が `MidiEventGraph` で `Node<'i32'>`」 に 拡 張
- 11-midi.md §2.4 emit-side prose で `MidiEventGraph` shape を 期 待、 literal は Q33 lift で 通 る 旨 を 明 示
- 01-dsl.md §4.1 で `event<T>` の 2 view 派 生 を 1 段 落 で 追 加 (= main 側 `T & { atSample: number }` / worklet 側 lifted)
- main / worklet で 同 じ MIDI ロ ジ ッ ク を 書 き た い user は 別 型 に 対 応 必 要 = ま ぁ context が 違 う か ら 自 然

## Q47 — diagnostics surface 統 一 (audit Phase 2 #10、 #49)

**Status:** resolved.

### Problem

main 側 で は diagnostics counter (= `overflowCount`) を 全 channel で 統 一 形 で 提 供 し て い た:

```typescript
node.events  .myEvt .diagnostics.overflowCount();
node.messages.myMsg .diagnostics.overflowCount();
node.midi    .midiIn.diagnostics.overflowCount();
```

し か し worklet 側 で は **MIDI handle だ け に** `.diagnostics` surface が 存 在 し て お り (= 11-midi.md §4 / decisions-log.md Q4-c-iv prose で 言 及):

```typescript
midiIn.diagnostics.overflowCount();    // ← MIDI だ け 存 在
evtOut.diagnostics?.overflowCount();   // ← 存 在 し な い (event<T>)
msgIn .diagnostics?.overflowCount();   // ← 存 在 し な い (message<T>)
```

= MIDI だ け 非 対 称、 「diagnostics は ど こ で 読 む か」 が user 学 習 で 1 答 え に な ら な い 状 態 (= MIDI 特 例 を 覚 え る 必 要)。

### Decision

diagnostics surface を **main 側 だ け に 統 一**:

- 全 channel で `node.<kind>.<name>.diagnostics.X()` の 形 (= 既 Q40 namespaced shape) を 唯 一 path と す る
- worklet 側 handle (= `midiIn.diagnostics`) を spec か ら 削 除、 v1.0.0 で は worklet 内 か ら diagnostics counter を 読 む path ナ シ
- `overflowCount` は 外 部 観 測 専 用 (= main thread の UI / log で 監 視、 worklet `process` body 内 で 読 ん で 分 岐 す る ロ ジ ッ ク は 書 け な い)

### Why this and not alternatives

- **worklet 側 に も 全 channel で `.diagnostics` を 追 加 (= 案 2 棄 却)**: API surface 倍 増、 worklet 内 で diagnostics を 読 ん で 何 す る か (= self-adaptive throttle 等) の typical pattern が v1.0.0 で 未 成 熟、 必 要 性 が 出 て か ら v1.x.0 で additive で 十 分
- **MIDI 特 例 維 持 (= 案 3 棄 却)**: hardware 接 続 性 質 を 理 由 と し た 非 対 称 だ が、 main で 同 じ 監 視 可 能、 mental model 学 習 負 担 > 特 例 の メ リ ット
- **declarative 原 則**: unworklet は 「user が 書 い た 構 造 が そ の ま ま WASM」 が core; worklet 内 で diagnostics counter を 読 ん で 分 岐 = 「副 作 用 → 制 御」 の feedback loop で declarative と 相 性 悪 い (= 同 じ 効 果 は main で counter 監 視 → main か ら `message` で 制 御 信 号 を 戻 す 構 造 の 方 が 明 確)

### Side effects

- 11-midi.md §4 overflow prose: `midiIn.diagnostics.overflowCount()` → `node.midi.<name>.diagnostics.overflowCount()` に refine、 「Consumers monitor the counter via the `publish` phase」 を 削 除 (= publish phase は Q27 で 廃 止 済 み、 単 純 に main 側 監 視 と prose 整 合)
- decisions-log.md Q4-c-iv prose: 同 様 に worklet 側 path を main 側 path に refine、 Q47 で removed 旨 を 注 記
- 既 canonical examples で `midiIn.diagnostics` を 直 接 使 う 箇 所 は ナ シ (verified: Ex 4 / Ex 5 / Ex 6 / Ex 8 全 て main 側 path `node.events.<name>.diagnostics.overflowCount()` 経 由)
- worklet 内 で の self-throttle pattern が 必 要 な user は v1.x.0 の additive 追 加 を 待 つ か、 main 経 由 feedback (= main で overflow 検 知 → main か ら message で 制 御 信 号) で 代 替

## Q48 — `inspect(blob)` を free function に 留 め る か node method に 動 か す か (audit Phase 2 #9、 #48)

**Status:** resolved.

### Problem

05-client.md §2 で snapshot / restore / inspect の 3 つ は こ う 並 ん で い る:

```typescript
const blob      = await node.snapshot();        // node method
const result    = await node.restore(blob);     // node method
const inspected = inspect(blob);                // ← free function (= import で 取 る)
```

= `inspect` だ け **node method で な く free function**。 audit finding は こ の 非 対 称 を 二 択 (= node method に 動 か す か / free function に 留 め る か) と し て 挙 げ て い た。

### Decision

`inspect(blob: Uint8Array): InspectionResult` を **free function で 維 持** (= 既 spec 形)。 「依 存 性 で 形 が 決 ま る」 を 1 行 ル ー ル と し て 明 文 化:

- node 依 存 操 作 (= `snapshot()` で 現 state を 読 む、 `restore(blob)` で 現 state に 書 く) → **node method**
- blob-only 操 作 (= `inspect(blob)` で blob を decode) → **free function**

### Why this and not alternatives

- **node method 形 (= `node.inspect(blob)`) 棄 却**: `inspect` は blob を decode す る pure function、 node の 現 state / param と 無 関 係。 method で 提 供 = 嘘 の 依 存 性 (= 実 際 は 不 要 な node) を user に 強 制、 preset library 構 築 ツ ー ル / server-side blob analyzer / debug script で fakeNode ハ ッ ク を 編 み 出 さ せ る
- **視 覚 的 対 称 (= snapshot/restore/inspect の 3 つ を 揃 え る) よ り 依 存 性 の 実 体 を 優 先**: form の 統 一 で mental model を 揃 え る の は 嘘 を 言 う 設 計 (= 「method = node-bound」 と 学 ん だ user に method な のに node 不 要 と い う 例 外 を 教 え る)、 依 存 性 の 実 体 通 り の form の 方 が 学 習 後 の 一 貫 性 高 い
- **import 1 行 cost は 償 却 範 囲**: `import { inspect } from '@unworklet/core'` は 既 declarative API import (= `defineProcessor` / `event` / `message` 等) と 同 じ 形、 user の 学 ぶ form 増 ナ シ

### Side effects

- 05-client.md §2 の `inspect` 項 目 で 「free function、 node method で は な い、 node 依 存 ナ シ で 使 え る」 旨 + ル ー ル を 1 段 落 で 追 記
- decisions-log Q5 entry (= snapshot/restore/inspect 全 体) は 既 free function 形 で 整 合、 修 正 ナ シ
- 既 canonical Ex 3 L350 は `const inspected = inspect(blob)` で 既 整 合、 修 正 ナ シ

## Q49 — worklet 側 sysex emit の data 構 築 経 路 (audit Phase 2 #17 / H9、 #54)

**Status:** resolved.

### Problem

Q46 で `MidiEventGraph` (= worklet 側 emit 型) の sysex variant を `{ type: 'sysex'; data: TypedArrayFieldRef<'u8'>; atSample: Node<'i32'> }` と し て 整 備 し た が、 worklet 内 で **新 規 に 動 的 な バ イ ト 列 を 構 築** す る path が 未 spec だ っ た:

- `new Uint8Array(...)` = realtime safety 違 反 (= heap alloc 禁 止) で 即 dead
- ingest し た sysex を re-emit (= MIDI thru) な ら proxy 参 照 を そ の ま ま 渡 す 経 路 は 既 Q39 で 表 現 可
- patch dump / config push (= 動 的 構 築 し た sysex を hardware に 送 信) 用 の path は ナ シ

audio device の typical use case (= patch dump、 arpeggiator config push) で worklet → main sysex emit が 必 要 な の に、 v1.0.0 spec で は 構 築 経 路 が な か っ た。

### Decision

worklet 側 sysex emit を **declared `Buffer<'u8'>` + `length: Node<'i32'>` 経 由 で 完 全 spec**。 sunset は ナ シ (= 既 known need を v1.0.0 で 落 と さ な い、 後 で 追 加 す る な ら sysex variant 自 体 が 破 壊 変 更 級 に な る)。

具 体 構 造:

1. **`buffer.u8({ size, name })` を 新 規 factory と し て 導 入**: 既 `Buffer<T>` handle と 同 形 (`read(idx)` / `write(idx, v)` / `copyFrom(src)` / `size` / `name`)、 byte 値 は `Node<'i32'>` で 受 け て 下 位 8 bit を 扱 う、 `Node<'u8'>` 型 は 導 入 ナ シ で ScalarType 拡 張 不 要
2. **`MidiEventGraph` sysex variant を refine**:
   ```typescript
   { type: 'sysex'; data: Buffer<'u8'> | TypedArrayFieldRef<'u8'>; length: Node<'i32'>; atSample: Node<'i32'> }
   ```
   - `data` を union 化 し て 「新 規 構 築 = Buffer<'u8'>」 「ingest re-emit = proxy」 両 path を 1 variant で 表 現
   - `length: Node<'i32'>` で 実 送 信 長 を 指 定 (= buffer は build-time 固 定 size box、 動 的 長 は length で 表 現)
3. **`MidiEvent` (main side) sysex は 変 更 ナ シ**: `{ type: 'sysex'; data: Uint8Array; atSample: number }` の ま ま (= framework が buffer の `data[0..length-1]` を copy し て Uint8Array に し て 届 け る、 main 側 で length 不 要)

`MidiEvent` (main) と `MidiEventGraph` (worklet) で sysex variant の shape が 非 対 称 (= worklet 側 だ け `length` field 持 つ) に な る が、 これ は worklet 側 が 「build-time 固 定 size box + 実 長 指 定」 を 持 ち 込 む 必 然 (= realtime safety、 heap alloc な し) で あ り、 11-midi.md §2.2 で 「Sysex shape asymmetry」 段 落 を 設 け て 1 段 落 で 説 明。

### Why this and not alternatives

- **v1.0.0 sunset (= MidiEventGraph か ら sysex 削 除) 棄 却**: patch dump / config push は audio device の known need、 v1.0.0 で 落 と す = MIDI 完 全 サ ポ ー ト を 宣 言 で きな く な る; 後 で 追 加 す る と sysex variant の 追 加 が MidiEventGraph 型 変 更 = 破 壊 変 更 級 で あ り、 v1.0.0 で 決 め 切 る 方 が 自 然 (= memory `feedback_no-preemptive-defer.md` の 「API surface に 染 み 出 る 選 択 は 今 decide」 に 該 当)
- **`Node<'u8'>` 型 を 導 入 し て scalar 体 系 拡 張 (= ScalarType に `'u8'` 追 加) 棄 却**: scalar primitive 全 体 (= add/sub/mul/...) を `'u8'` 対 応 さ せ る overhead 大、 sysex 1 use case の た め に 型 system 全 体 を 触 る の は 過 剰; `Node<'i32'>` で 下 位 8 bit を 扱 う で 十 分 (= JS 側 で も byte は number で 扱 う 慣 行 と 整 合)
- **emit-side で `data: Uint8Array literal` を 許 す 棄 却**: heap alloc 経 路 を user に 開 く = realtime safety 違 反 経 路 を spec で 認 め る こと に な り、 declarative 原 則 (= build-time 固 定 構 造) と 衝 突

採 用 案 = build-time 固 定 size buffer + 実 長 field で 「動 的 length を 静 的 構 造 で 表 現」、 既 declarative pattern と 整 合。

### Side effects

- 11-midi.md §2.2: `MidiEventGraph` sysex variant に `data: Buffer<'u8'> | TypedArrayFieldRef<'u8'>` + `length: Node<'i32'>` を 入 れ る、 「Sysex shape asymmetry」 段 落 で main / worklet 非 対 称 を 1 段 落 で 説 明
- 11-midi.md §2.5 (新 規 section): 「Emitting sysex (worklet → main)」 で **declared buffer 経 由 + 実 長 指 定** / **ingested proxy 経 由 で thru** の 2 path を code example 付 き で spec、 `new Uint8Array(...)` が realtime-safety 違 反 で 永 久 排 除 で あ る こと を 明 文 化
- 11-midi.md §4.3: 「v1.0.0 ships full sysex support」 を 「**both directions** (ingestion + emission)」 に 拡 張、 §2.5 と Q49 へ の cross-ref
- 01-dsl.md §3.2: buffer factory に `buffer.u8` を 追 加、 「sysex emit 専 用、 byte 値 は Node<'i32'> で 扱 う」 旨 を 1 段 落 で 説 明
- canonical example 修 正 ナ シ (verified — `12-canonical-examples.md` "What this set does not yet exercise" section の MIDI variants 行 で 既 acknowledged coverage gap、 sysex variant を 使 う example が 存 在 し な い)

## Q11 — Browser quirk normalization scope (#67 A4)

**Status:** resolved.

### Problem

unworklet が 動 く web 環 境 で は Chrome / Firefox / Safari / そ の 他 browser ご と に 微 妙 な 挙 動 差 が あ る (= Web MIDI device permission / SAB 利 用 可 否 / AudioContext sampleRate / `parameters[name]` 配 列 長 / processorOptions delivery timing 等)。 既 ratify Q (= Q18 / Q19 / Q21 / Q27 / Q4-c / Q4-d) は 各 quirk に つ い て 個 別 に decide さ れ て い た が、 **policy と し て 「何 を normalize す る / し な い か」 が 1 行 で declare さ れ て い な か っ た**。 残 3 件 (= Web MIDI device quirk / `parameters[name]` 配 列 長 / COOP/COEP header) も policy ナ シ で 宙 浮 き 状 態 だ っ た。

### Decision

policy rule (1 行):

> **「unworklet が normalize す る の は WASM emission boundary よ り 内 側 の quirk。 boundary よ り 外 側 (= Web MIDI device、 AudioContext 設 定、 COOP/COEP HTTP header) は consumer 責 任。 boundary 跨 ぎ は unworklet API (= `connectFromWebMIDI` / `createNode` / runtime SAB detect / `node.onError`) で 支 え る」**

「boundary 内」 = unworklet が compile / runtime で 決 め 込 ん で emit す る 範 囲 (= WASM binary、 messaging glue)。 「boundary 外」 = web platform 機 能 で unworklet の WASM module は touch し な い 範 囲 (= Web MIDI device handle、 AudioContext lifecycle、 HTTP header)。

具 体 catalog (= 既 ratify を 統 一 view に 整 理 + 残 3 件 を 入 れ る):

**A. boundary 内 (= unworklet 吸 収、 consumer 不 可 視)**:

- A1: render quantum size 128 (Q18 + Q35) — WASM bake-in、 runtime guard で 128 以 外 reject
- A2: channel count (Q19) — `audioInput({ channels })` 宣 言 時 固 定、 host 側 mix
- A3: `parameters[name]` 配 列 長 1 / 128 / 0 (Q18) — internal marshalling で 統 一、 user は `param.at(i)` / `param.at(0)` の み
- A4: subnormal flush-to-zero (Q21) — `state.<f>.store(v)` に compile-time guard
- A5: SAB / postMessage 自 動 切 替 (Q27) — runtime detect、 同 一 API、 transport 内 部
- A6: MIDI ringbuffer overflow (Q4-c) — drop-and-report、 main 側 `diagnostics.overflowCount()` で 観 測
- A7: MIDI clock interpretation (Q4-d) — `systemRealtime` raw event 配 送、 BPM 解 釈 は consumer

**B. boundary 外 (= consumer 責 任、 unworklet API で 跨 ぎ 支 援)**:

- B1: Web MIDI device permission / hotplug / port enumeration — consumer が `navigator.requestMIDIAccess()` で handle 取 得、 `connectFromWebMIDI(port)` で unworklet に 渡 す
- B2: AudioContext 生 成 / sampleRate / resume — consumer が `new AudioContext(options)` で 生 成、 `createNode(audioCtx, ...)` で unworklet に 渡 す、 worklet 内 で は `ctx.sampleRate` (build-time const) と し て 参 照
- B3: COOP / COEP HTTP header — consumer が server config で set、 unworklet は runtime detect だ け (A5 経 由 で transport 自 動 切 替)

### Why this and not alternatives

- **案 α (minimal normalization、 WASM 内 側 の み 吸 収) 棄 却**: 既 Q27 (SAB / postMessage 自 動 切 替) と 直 接 矛 盾、 既 決 retract コ ス ト 過 大、 consumer に SAB fallback 実 装 burden 押 し 付 け
- **案 β (full normalization、 全 quirk 吸 収) 棄 却**: scope balloon = audio DSP framework か ら web platform abstraction layer に 膨 張、 §2 Non-goals (= 「Not a host-format adapter」 「Not a music-making framework」) と 衝 突
- **案 δ (config flag で normalize 程 度 を opt-in / opt-out) 棄 却**: 同 一 unworklet 利 用 が config ご と に 別 mental model = portability 完 全 崩 壊、 test surface 爆 発、 仕 様 freeze 不 能

採 用 案 = policy γ = WASM emission boundary 1 軸 で line 引 き、 既 ratify 7 件 と 完 全 整 合、 future quirk も 「unworklet WASM module が 触 る か?」 1 問 判 定 可。

### Side effects

- **00-foundations.md §3** (vocabulary): 「Emission boundary」 entry を 1 段 落 追 加 (= 内 側 / 外 側 の 定 義 + boundary 跨 ぎ API + Q11 cross-ref)
- **08-deployment.md §2**: placeholder を A1-A7 / B1-B3 catalog 形 で 全 部 埋 め、 per-browser validation matrix (= `Chromium × Firefox × Safari` × `{isolated, not-isolated}`) を 1 段 落 追 加
- canonical example 修 正 ナ シ (verified — `12-canonical-examples.md` Example 1 / 5 / 6 / 8 で 既 `new AudioContext()` (= B2) と `navigator.requestMIDIAccess()` → `connectFromWebMIDI(port)` (= B1) path が canonical pattern と し て 使 わ れ て お り、 policy γ と 整 合 済 み)

Post-ratify followups: `open-questions.md` の 該 当 質 問 entry を 参 照。

## Q23+Q24+Q25 — `@unworklet/vite-plugin` の scope (#68 B1 + #69 B2 + #70 B3 統 合)

**Status:** resolved (3 件 統 合 entry、 動 的 swap の primitive 部 分 は Q50 に 切 り 出 し)。

### Problem

unworklet を dev で 使 う 時 に 必 要 な 「edit → save → 動 い て い る audio に 反 映」 + 「処 理 cost / state / error を 観 察」 が 既 spec に な か っ た。 既 docs (= 旧 07-tooling.md placeholder) は `unworklet build / dev / test / bench / analyze` の 自 前 CLI 案 だ っ た が、 こ れ は v1.0.0 で 採 用 し な い と 判 断。 加 え て:

- bundler integration (Q24) の scope = ど の bundler を first-class と す る か、 ど の よ う な asset resolution / module loading を ど う 提 供 す る か 未 spec
- source maps (Q25) = `.ts` → `.wasm` の source position 繋 ぎ 方 + 配 信 形 態 未 spec
- hot reload (Q23) = code edit → 動 い て い る audio の 振 る 舞 い + main thread node の lifecycle 未 spec

3 つ は 互 い に 依 存 (= source maps は build pipeline に 乗 る、 HMR は bundler watch event を 拾 う) で 同 1 statement で 同 時 解 決 が 自 然。

### Decision

**unworklet の 巻 き 取 り 基 準 = 「fundamental + universal + non-opinionated」 の 3 条 件 全 部 満 た す も の の み**。 余 湖 さ ん の ス タ ン ス を 引 用 = (1) HMR を framework が 勝 手 に や る の は too much、 user land 寄 り、 (2) Max/MSP 風 visual programming や Faust 風 live coding 環 境 を user が 作 れ る 仕 様 に し た い、 (3) primitive み 提 供、 便 利 ツ ー ル 系 は 第 三 者 に、 つ ら い & み ん な 必 要 な も の だ け 巻 き 取 る。

こ の lens で 機 能 を 仕 分 け:

| 機 能 | 判 定 | 理 由 |
|---|---|---|
| WASM build + asset resolution + source maps + `?worklet` HMR boundary | 巻 き 取 り (`@unworklet/vite-plugin`) | fundamental (Vite 統 合 が ど の consumer に も 必 要) + universal + non-opinionated |
| DevTools panel set (build errors + graph viewer + memory budget + live state inspector + live latency monitor + MIDI flow + snapshot inspector + swap history) | 巻 き 取 り (`@unworklet/vite-plugin`) | DevTools panel は consumer の app に は 見 え な い、 unworklet 開 発 者 の DX surface 限 定; 全 author が 同 一 machinery (= graph 構 造 / memory budget / state slot / MIDI ringbuffer / 3-layer error / `replaceProcessor` 履 歴) を 見 た い = universal、 ship し な い と 各 author / downstream plugin が 同 一 view 再 構 築 = ecosystem 分 裂 + 「つ ら い & み ん な 必 要」 そ の も の; panel は unworklet 自 身 の 構 造 だ け 可 視 化、 consumer の DSP 意 味 内 容 (spectrum / oscilloscope / custom dashboard) に は 触 ら な い |
| analysis JSON artifacts + dev-time live channels | 巻 き 取 り (`@unworklet/vite-plugin`) | 上 記 panel の data source = 安 定 schema を public extension surface と し て declare、 第 三 者 panel (visual programming editor / 専 用 dashboard / 代 替 inspector) が forward-compatible に composable |
| 動 的 swap primitive (= 旧 processor → 新 processor、 state 持 ち 越 し) | 巻 き 取 り (`@unworklet/core`) | Web Audio spec 制 約 (= `registerProcessor` 同 name 禁 止、 `removeModule()` 不 存 在) の 隠 蔽 が fundamental + universal (= HMR / live coding / visual programming 共 通 根)、 raw primitive な ら non-opinionated。 詳 細 = Q50 |
| HMR orchestration (= file watcher trigger + 自 動 swap + graph 自 動 再 接 続 + crossfade) | user land / 第 三 者 | 動 的 swap primitive あ れ ば user land で 書 け る、 「自 動 や る か 手 動 か」 は consumer's audio graph に 踏 み 込 む = opinionated 領 域、 declarative 哲 学 と 衝 突 |
| consumer の app UI / DSP (spectrum analyzer / oscilloscope / custom dashboard 等) | user land / 第 三 者 | consumer's app に framework が 踏 み 込 む = declarative 違 反、 plugin が 提 供 す る panel は unworklet 自 身 の 構 造 限 定 |
| offline rendering (= pure JS WASM 実 行、 PCM 返 却) | 巻 き 取 り (`@unworklet/offline` 別 package) | fundamental (pure JS interpreter は framework が 持 つ) + universal (test / server-side / batch / preset preview の 4 use case 共 通) |
| test matchers (audio 比 較 / NaN 検 知 等) | 巻 き 取 り (`@unworklet/test` 別 package) | audio test の 共 通 課 題 を 巻 き 取 り、 内 部 で `@unworklet/offline` を 使 用 |

採 用 案 = **3 package 構 成**:

- **`@unworklet/core`**: 既 全 primitive + 新 規 `replaceProcessor` (= Q50)
- **`@unworklet/vite-plugin`**: WASM build + asset resolution + `?worklet` HMR boundary + source maps + build-error panel + analysis JSON 出 力。 HMR orchestration / 残 DevTools panel は scope OUT
- **`@unworklet/offline`** + **`@unworklet/test`**: 別 package、 既 ratify 通 り

unworklet 自 前 CLI は ship し な い (= `vite build` / `vite` が user-facing entry)。

### Why this and not alternatives

- **`unworklet` 自 前 CLI ship 棄 却**: vite が build / dev / HMR を 担 う、 framework が dev server 自 前 ship は scope 過 大
- **HMR を framework が 自 動 で orchestrate 棄 却**: Web Audio spec が HMR を supported し て い な い 中 で 「自 動 検 知 + 自 動 swap + 自 動 graph 再 接 続」 を declare す る の は magic で hack を 隠 す = declarative 哲 学 違 反、 silently fail す る case (= declarations rename / channel count 変 化 / closure に 旧 ref 保 持 / dynamic graph 操 作) を 抱 え た ま ま 「dev experience 一 級」 と 名 乗 る の は honest で な い、 余 湖 さ ん 「user land 寄 り す ぎ」 指 摘 と も 整 合
- **DevTools panel を 「build error 1 個 だ け ship + 残 は analysis JSON」 棄 却**: 「user land」 を 1 bucket 扱 い し た 浅 い 整 理 だ っ た — consumer's app code (= declarative 違 反 で framework が 触 ら な い 領 域) と third-party tooling ecosystem (= DX surface) は 別 layer、 devtools panel は 後 者 で consumer の app に は 見 え な い 開 発 者 DX、 framework が opinionated に ship し て も declarative 哲 学 と 衝 突 し な い; ship し な い と 各 author / downstream plugin が 同 一 view を 再 構 築 = ecosystem 分 裂 +「つ ら い & み ん な 必 要」 を 投 げ 出 す こ と に な る; 8 panel ship + analysis JSON / dev-time live channel を public extension surface と し て 並 列 公 開 が 正 解 (= 第 三 者 panel は 上 で composable)
- **bench / analyze CLI 維 持 棄 却**: CLI で 数 字 を terminal に 流 す よ り DevTools の live panel (= Live latency monitor + Memory budget + Graph viewer) で 観 測 が 圧 倒 的 に 良 い
- **`renderOffline` を test 専 用 と し て `@unworklet/test` に bundle 棄 却**: server-side render / batch processing / preset preview UI 等 test 以 外 の use case が 一 級、 別 package に 切 り 出 す こ と で 4 use case で 共 通 利 用 可
- **他 bundler を v1.0.0 で ship 棄 却**: Vite が 一 番 普 及 + DevTools Kit が Vite 専 用、 v1.0.0 は 1 first-class integration に focus、 v1.x.0 で additive

### Side effects

- **`07-tooling.md` → `07-vite-plugin.md` rename + 全 rewrite** (= CLI 前 提 を vite plugin に re-frame、 §1 scope / §2 build / §3 asset / §4 HMR boundary (= primitive 化、 swap orchestration は user land) / §5 source maps / §6 DevTools surface (= build-error panel 1 つ + analysis JSON 出 力))
- **新 `13-offline-render.md`** (= `@unworklet/offline` の API + use case 4 つ + backend choice の skeleton)
- **`05-client.md` §8** (新 規 section): `replaceProcessor` API spec を 追 加 (= Q50 の authoritative section)
- **`06-testing.md` re-frame** (= `@unworklet/test` matchers focus、 `@unworklet/offline` を 内 部 使 用)
- **`08-deployment.md` §1** placeholder → resolved 段 落 (= `@unworklet/vite-plugin` 参 照、 他 bundler は v1.x.0 additive)
- **`01-dsl.md` L1119** + **`12-canonical-examples.md` L890**: `unworklet build` 言 及 → `@unworklet/vite-plugin` 表 現
- **`README.md`** docs 一 覧 + Read & implementation order 図 update
- canonical example 修 正: `12-canonical-examples.md` Example 7 内 の CLI 言 及 comment update (verified — 他 に CLI 名 言 及 ナ シ で 整 合)

Post-ratify followups: `open-questions.md` の 該 当 質 問 entry を 参 照。

## Q50 — 動 的 processor swap primitive `replaceProcessor`

**Status:** resolved。

### Problem

Q23+Q24+Q25 を 「primitive vs user land」 の lens で 仕 分 け た 結 果、 HMR / live coding / visual programming の 共 通 根 と し て 「動 的 に processor 実 装 を 入 れ 替 え、 state を 持 ち 越 す」 primitive が 必 要 で あ る こ と が 明 確 化。 既 spec の `createNode` / `snapshot` / `restore` / `inspect` / migration chain で は 「同 一 node 内 で の state 操 作」 は 表 現 で きる が、 「異 な る processor 定 義 へ の 移 行」 path が ナ シ。 こ の primitive を ど ん な signature / 動 作 で expose す る か。

加 え て Web Audio spec の 制 約 (= `registerProcessor` 同 name 再 register は `NotSupportedError`、 `removeModule()` 不 存 在、 `AudioWorkletGlobalScope` は AudioContext lifetime ま で 残 る、 `process()` が true 返 す 限 り node 生 存) を framework が ど こ ま で 隠 蔽 す る か も 同 時 解 決 必 要。

### Decision

`@unworklet/core` か ら **`replaceProcessor(oldNode, newProcessor)` を free function で expose**。 signature:

```typescript
import { replaceProcessor } from '@unworklet/core';

const result = await replaceProcessor(oldNode, NewProcessor);

type ReplaceResult<New> =
  | { ok: true;  node: UnworkletNode<New>; restored: number; skipped: string[]; missing: string[] }
  | { ok: false; node: UnworkletNode<New>; error: { step; message; cause }; restored: number; skipped: string[]; missing: string[] };
```

method の 動 作:

1. `oldNode.snapshot()` で state を blob 化 (= Q5)
2. 新 WASM を unique name で `registerProcessor` (= Web Audio spec の duplicate-name 制 約 隠 蔽、 framework 内 部 で 採 番)
3. 新 AudioWorkletNode を 生 成 し て `restore(blob)` + migration chain (= Q5 + Q45 再 利 用)
4. 新 typed wrapper を 戻 り 値 で 返 す

framework が **やらない** こ と (= consumer 責 任):

- 旧 node の disconnect / destroy (= graph 操 作 ナ シ、 consumer が 判 断)
- 新 node の graph 接 続 (= consumer が `result.node.connect(dest)` 等 で 明 示)
- 旧 / 新 間 の audio 連 続 crossfade (= GainNode + envelope で user land で 書 け る、 framework primitive で は な い)
- ソ ー ス edit 監 視 や `import.meta.hot.accept` 自 動 hook (= HMR orchestration 自 体 が user land)

typed wrapper の signature: 戻 り 値 で **新 typed wrapper を 返 す** (= 旧 wrapper instance を 保 持 し て magic で property reassign す る 形 を 棄 却)。 declarations 変 化 (rename / 追 加 / 削 除) は typed `.d.ts` 経 由 で TS error と し て consumer code に 即 露 出 = silently fail せ ず。

accumulation warning: 同 AudioContext 内 で N 回 swap 累 積 で `console.warn` (= Web Audio `removeModule()` 不 存 在 制 約 で AudioContext 内 registration が 蓄 積 す る fact を consumer 認 知 surface に)。 N の 値 と warning message 詳 細 は `05-client.md` §8.5 で 別 途。

### Why this and not alternatives

- **「wrapper instance 保 持 + 内 部 swap + property reassign で typed API 更 新」 棄 却**: declarations 変 化 時 (rename 等) に 旧 ref が silent fail す る magic、 declarative 哲 学 違 反、 余 湖 さ ん 「magic anti-pattern」 ス タ ン ス と 衝 突
- **「framework が graph 自 動 再 接 続」 棄 却**: graph history track + auto-reconnect は magic、 dynamic graph 操 作 consumer で 整 合 取 れ な い、 declarative 違 反
- **「framework が audio 連 続 crossfade を 自 動 で 行 う」 棄 却**: GainNode + envelope schedule で user land で 書 け る、 framework primitive で は な い、 「fundamental + universal + non-opinionated」 巻 き 取 り 基 準 で 非 fundamental
- **「method 形 `oldNode.replaceProcessor(newProc)` 棄 却 し て free function」**: 戻 り 値 の typed wrapper が 新 declarations 基 準 で typed = method 形 だ と 旧 wrapper instance の type が 旧 declarations の ま ま で 不 整 合、 free function で 戻 り 値 が 新 type な ら clean (= Q48 の 「node-bound = method、 blob-only = free function」 ル ー ル と は 若 干 違 う 軸 (= 「型 整 合 性 が free function を 要 求」) だ が、 同 じ 形 状)
- **「v1.0.0 で 動 的 swap を ship し な い」 棄 却**: HMR / live coding / visual programming の 共 通 根 = ど の dev experience 構 築 で も 必 要、 v1.0.0 で primitive を declare し な い と user land で hack 量 産

### Side effects

- **`05-client.md` §8** (新 規): `replaceProcessor` の signature + 動 作 + 「framework が や ら な い こ と」 + declarations 変 化 時 の 振 る 舞 い + memory accumulation + user land recipe sketch を 全 spec
- **`07-vite-plugin.md` §4** (= HMR boundary): `replaceProcessor` を user land で 呼 ぶ 形 を recipe で 提 示
- **canonical example 影 響 ナ シ** (verified — 既 canonical example は createNode / snapshot / restore / inspect / migration chain ベ ー ス、 `replaceProcessor` を 使 う example は 未 整 備 で 既 整 合)

Post-ratify followups: `open-questions.md` の 該 当 質 問 entry を 参 照。

## Q51 — per-block sample-offset primitive 開 放 + JUCE / AudioWorklet process メ ン タ ル 明 文 化 (audit followup)

**Status:** resolved。

### Problem

audit で `01-dsl.md` §1 prose に 「The JS literal `0` lifts to `Node<'i32'>` per Q36-a and is allowed at per-block top level (e.g. `param.at(0)` reads the block-start value; the equivalent literal positions for `audioIn` / `audioOut` are not opened by Q36 and remain a separate decision)」 と あ り、 audio I/O sample-offset primitive の per-block 開 放 が 「separate decision」 と し て 宙 浮 き と 判 明。 加 え て docs 全 体 で 「JUCE AudioProcessor::processBlock / AudioWorklet `process` と 同 じ mental model」 と い う core stance が 1 箇 所 に 明 文 化 さ れ て お ら ず (= decisions-log Q37 prose と `00-foundations.md` / `01-dsl.md` の top-to-bottom 言 及 が 散 在)、 余 湖 さ ん が 「過 去 何 回 か 説 明 し て い る 」 mental model が 仕 様 と し て 引 け な い 状 態 だ っ た。

### Decision

**`audioIn.at(c, 0)` / `audioOut.set(c, 0, v)` を per-block で 呼 び 可 と し て open**。 Q36-a の method signature `i: Node<'i32'> | number` を そ の ま ま 適 用、 `param.at(0)` と 対 称 に 開 放。

同 時 に **00-foundations.md §3 「Process body」 entry を 強 化** し て、 unworklet の core mental model を 1 段 落 で 明 文 化:

> **Mental model — same as JUCE / AudioWorklet `process`.** The `process` body is read top-to-bottom: code at the top of the body runs first, then any subsequent statement runs in source order, until the end. There is no fixed phase boundary that the author has to put their code on either side of, no global ordering rule beyond source order, and no restriction on how many `forSample` loops the body contains. Authors write zero, one, or many `forSample` invocations; per-block computation freely interleaves with them; the same output sample can be written multiple times (last write wins per Q37); the same input sample can be read in per-block code and again inside a `forSample` callback. This is the **AudioWorkletProcessor.process / JUCE AudioProcessor::processBlock** mental model, preserved as-is — `forSample` is just a loop primitive over the block, not a phase the framework reorders or constrains.

つ ま り 構 造 ル ー ル は 1 つ だ け = **declarations は declaration scope (= body 先 頭) 限 定**。 そ れ 以 外 (= 順 序、 重 ね 書 き、 sample-offset primitive の 呼 び 位 置) は 親 ホ ス ト と 完 全 一 致。

### Why this and not alternatives

- **`audioIn` / `audioOut` の per-block 0 literal を permanently not opened 棄 却**: 余 湖 さ ん の core mental model (= 「JUCE / AudioWorklet と 同 じ」) と 真 逆、 `param.at(0)` と の 非 対 称 が user mental に 食 い 込 む、 「block 開 始 input level 検 査 → adaptive 処 理」 等 の natural な use case を artificial に 禁 止 (= memory `feedback_no-artificial-constraint.md`)
- **v1.x.0 additive で 検 討 棄 却**: 既 Q36-a の method signature で 既 受 け 入 れ ら れ て お り、 v1.0.0 で 明 示 的 に 開 放 す る か 禁 止 す る か decide す る だ け、 後 で 開 放 は 「な ぜ v1.0.0 で 禁 止 し た か」 を 後 付 け で justify 必 要 = no preemptive defer (memory `feedback_no-preemptive-defer.md`)
- **mental model 明 文 化 を 省 略 棄 却**: 余 湖 さ ん 過 去 数 回 説 明 し て お り 、 仕 様 docs に 引 け る 形 で 明 文 化 し な い と 同 質 の audit finding が 繰 り 返 す (= 「artificial 制 約 を framework が 持 ち 込 む」 misread の 温 床)

### Side effects

- **00-foundations.md §3**: 「Process body」 entry に mental model 1 段 落 追 加 (= JUCE / AudioWorklet 整 合 を 明 言)、 「Sample-offset (i)」 entry を update (= `Node<'i32'>` `i` alias は forSample-scoped、 primitive 自 体 は per-block で literal で 呼 べ る)、 「Per-block phase」 bullet を update (= sample-offset primitive を per-block で 呼 べ る、 literal で sample-offset 指 定)
- **01-dsl.md §1**: L34 prose を rewrite (= 「remain a separate decision」 撤 去、 per-block で sample-offset primitive を literal で 呼 び 可、 mental model 言 及 追 加)
- canonical example 影 響 ナ シ (verified — 既 canonical example は forSample 内 で `i` 使 用、 per-block で の literal 呼 び 出 し は 既 example で は 出 て こ な い、 整 合 違 反 ナ シ)

Post-ratify followups: `open-questions.md` の 該 当 質 問 entry を 参 照。

---

## Q52 — Public package layout の docs-side enforcement (Q23 派 生、 L1-d)

**Status:** resolved.

### Problem

Q23 で 公 開 npm package 構 成 を **`@unworklet/core` + `@unworklet/vite-plugin` + `@unworklet/offline` + `@unworklet/test` の 4 個** に 確 定 し た が、 doc 章 タ イ ト ル に 古 い package 名 が 残 存:

- `01-dsl.md` L1: `(@unworklet/core + @unworklet/dsp)` — `@unworklet/dsp` は 不 在 npm package
- `03-compiler.md` L1: `(@unworklet/compiler)` — 公 開 package で は な い (Q23 で vite-plugin 内 部 pipeline と 確 定)
- `04-worklet-runtime.md` L1: `(@unworklet/worklet)` — 公 開 package で は な い (Q23 で 言 及 ナ シ、 build 出 力 物)
- `03-compiler.md` L27 / `07-vite-plugin.md` L26 / `08-deployment.md` L13 prose に `@unworklet/dsp` / `@unworklet/compiler` 言 及 残 存

加 え て、 v1.0.0 で 公 開 さ れ る DSL 識 別 子 約 50 個 (= `defineProcessor` 系、 declaration 系、 math 系、 forSample 系、 const 系) を root flat に 出 す か subpath split す る か が docs で 暗 黙、 design intent の 明 文 化 が 不 在。

### Decision

**A-1 (root flat + simd subpath)** を strict 適 用:

- 公 開 npm package = **4 個** (Q23 ratify 通 り): `@unworklet/core` / `@unworklet/vite-plugin` / `@unworklet/offline` / `@unworklet/test`
- 公 開 import path = **5 種** (= 上 記 4 + `@unworklet/core/simd` subpath、 SIMD opt-in は `01-dsl.md` §7 通 り)
- DSL 識 別 子 約 50 個 は `@unworklet/core` root か ら flat に 全 export (= declarative primitive と math primitive を subpath で 分 け な い)
- `@unworklet/dsp` / `@unworklet/compiler` / `@unworklet/worklet` は **公 開 package で は な い**:
  - compiler → `@unworklet/core` の internal module、 user は `@unworklet/vite-plugin` 経 由 で 暗 黙 起 動
  - worklet runtime → `@unworklet/core` の internal module、 build 出 力 物 と し て emit + `audioWorklet.addModule(processorUrl)` で load
  - dsp surface → `@unworklet/core` root に flat export し て 独 立 package 化 し な い

**doc 章 タ イ ト ル の 表 記 規 則 (B-1)**:

- 公 開 package を 直 接 提 供 す る doc → タ イ ト ル に package 名 を 明 記 (例: `# 05 — Client (\`@unworklet/core\`)`)
- internal module の doc → タ イ ト ル か ら package 名 削 除 + 冒 頭 prose で 「internal module of `@unworklet/core`」 と 明 言

### Why this and not alternatives

- **A-2 (`@unworklet/core/dsp` subpath を 追 加) 棄 却**: autocomplete 整 理 の メ リ ッ ト < user import 行 増 加 + 「declarative primitive」 vs 「math primitive」 の split 線 が 識 別 子 単 位 で 曖 昧 (`eq`, `lt`, `gt`, `min`, `max`, `abs` 等 は 「数 学」 と も 「条 件 / control flow」 と も 取 れ る) で split 基 準 を 説 明 す る docs 追 加 が 必 要 = mental model コ ス ト 増、 v1.0.0 で 公 開 50 識 別 子 規 模 で は autocomplete 汚 染 と 言 え る 規 模 で は な い
- **A-3 (`@unworklet/dsp` 独 立 npm package) 棄 却**: Q23 ratify を override 必 要、 core と dsp の version skew リ ス ク 増、 canonical examples 全 書 き 直 し、 Q23 で 同 等 議 論 を 既 に 解 決
- **A-4 (`@unworklet/core/simd` も やめ root 1 つ で full flat) 棄 却**: 既 spec の SIMD opt-in 設 計 (`01-dsl.md` §7) 全 体 崩 壊、 `f32x4` 型 の opt-in 出 現 制 御 と subpath 一 体 化 が 壊 れ る
- **B-2 (内 部 module 章 タ イ ト ル に 「internal module of @unworklet/core」 注 釈 を 入 れ る) 棄 却**: heading 長 過 ぎ、 doc 一 覧 で の navigability 悪 化
- **B-3 (章 タ イ ト ル か ら 全 package 表 記 削 除) 棄 却**: user が doc を 開 い た 時 「ど の package?」 が 章 タ イ ト ル で 即 判 別 で き ず navigability 悪 化

### Side effects

- `01-dsl.md` L1 heading: `# 01 — DSL (@unworklet/core + @unworklet/dsp)` → `# 01 — DSL (@unworklet/core)`
- `03-compiler.md` L1 heading: `# 03 — Compiler (@unworklet/compiler)` → `# 03 — Compiler` + L3 prose に 「internal module of @unworklet/core」 1 文 追 加
- `03-compiler.md` L27 prose: `proxy implementations of all primitives in @unworklet/dsp` → `proxy implementations of all primitives exported from @unworklet/core`
- `04-worklet-runtime.md` L1 heading: `# 04 — Worklet runtime (@unworklet/worklet)` → `# 04 — Worklet runtime` + L3 prose に 「internal module of @unworklet/core」 1 文 追 加
- `07-vite-plugin.md` L26: `Invokes the @unworklet/compiler pipeline` → `Invokes the compiler pipeline (= internal module of @unworklet/core, see 03-compiler.md)`
- `08-deployment.md` L13: `The underlying compiler (@unworklet/compiler) is bundler-agnostic` → `The underlying compiler pipeline (= internal module of @unworklet/core, see 03-compiler.md) is bundler-agnostic`
- Q13 (initial package layout) が 自 動 派 生 確 定 (= 公 開 4 package + 内 部 module 構 造 一 致)、 Q13 を resolved status に update (= summary table cell 既 update 済 み)
- canonical examples integrity 確 認: `12-canonical-examples.md` の import 行 は 全 て `@unworklet/core` / `@unworklet/core/simd` 統 一 で 既 整 合、 修 正 ナ シ (AGENTS.md HARD CONTRACT 同 commit 整 合 確 認 済 み)

---

## Q53 — 仕 様 invariant vs 型 declaration の 形 — ratify 範 囲 確 定 (L1-c re-scope)

**Status:** resolved.

### Problem

L1-c (公 開 type 定 義 大 量 不 在) を 棚 卸 し し て い く 中 で、 余 湖 さ ん が ratify 範 囲 の 線 引 き を 明 確 化 (2026-05-19)。

L1-c の 当 初 整 理 は 「`@unworklet/core` か ら export 約 束 だ け で body shape declaration 不 在」 = 19 種 の type を 階 層 分 類 し て 各 § に formal `type X = {...}` block を 入 れ る 議 論 だ っ た。 し か し TS compiler を 使 わ ず 脳 内 で signature を 詰 め る 作 業 は **手 放 し 運 転** = 不 正 確、 む し ろ impl AI agent が TS で 通 し な が ら 決 め る ほ う が 整 合 性 確 保 で 強 い。 「我 々 が 今 こ こ で 詰 め る べ き は ミ ニ マ ム で 大 事 な と こ ろ だ け、 イ ン タ ー フ ェ ー ス の 細 部 は 詳 細 で 好 み で 変 わ る 部 分」 と い う 余 湖 さ ん 判 断。

### Decision

**unworklet の 設 計 ratify 範 囲 を 「仕 様 invariant」 に 限 定 す る**:

| 領 域 | 誰 が decide | 含 ま れ る も の |
| --- | --- | --- |
| **仕 様 invariant** (= grill 対 象) | 余 湖 さ ん + 共 同 設 計 grill | 振 る 舞 い / 制 約 / mental model / 呼 び 出 し context / RT-safe / 公 開 surface に 何 が 出 て く る か / 仕 様 内 矛 盾 / prose 不 在 dangling |
| **型 declaration の 形 / impl 細 部** (= grill 対 象 外) | impl AI agent (= TS compiler 経 由 で 機 械 的 に 確 定) | TS signature 細 部 (`Node<T> | number` の 表 記 / generic constraint / brand 形 内 部 / opaque vs structural 表 現) / 識 別 子 名 の autocomplete affordance 細 部 |

**こ れ は 「曖 昧 さ を 残 す」 で は な く 「適 切 な layer に 委 譲」**: invariant は 厳 密 に grill、 形 は TS compiler に 通 す こ と で 機 械 的 に 確 定。 既 設 計 哲 学 (= Q23 「primitive み 提 供、 便 利 ツ ー ル 系 は 第 三 者 に、 つ ら い & み ん な 必 要 な も の だ け 巻 き 取 る」 + AI agent paradigm 「設 計 合 意 で き れ ば 実 装 は 実 質 O(1)、 取 り 返 し つ か な い の は 曖 昧 設 計 と 調 査 不 足」) の 厳 密 適 用。

**L1-c の re-scope**:

- 公 開 surface に 約 束 さ れ た 19 種 type の 「中 身 形」 議 論 は impl 領 域 に 落 と す
- 各 type の method invariant (= ど の method を 持 つ か / 呼 び 出 し context / 戻 り 値 の 意 味) は 既 docs prose で ratify 済 み = invariant 議 論 既 完 了
- 例 外 = `SubgraphInstance<S>` (= §1.6.1 で 名 前 だ け export 約 束、 §5.6 で 戻 り 値 型 と し て 引 用 ナ シ、 「subgraph instance か ら 何 が 引 け る か」 が prose に も 書 か れ て い な い) を L1-c に 残 し て 別 grill

**他 残 question へ の 適 用**:

- **L2-a (loadVec / everyNSamples 命 名 見 直 し)** 撤 去 — 「ど の 名 前 が ergonomic か」 = impl AI 領 域 (= autocomplete 上 の 試 行 で 決 ま る 細 部)、 invariant で は な い
- **L2-b (param.at(0) framing refine)** 撤 去 — prose の cosmetic refine、 L1-a (phase terminology) ratify で 自 動 解 消、 単 独 entry 不 要

### Why this and not alternatives

- **L1-c を 階 層 分 類 で 詰 め 切 る 案 棄 却** — TS compiler を 使 わ ず 脳 内 で 19 種 type の signature を 詰 め る = 不 正 確 + 余 湖 さ ん attention の 浪 費、 impl AI が TS で 通 し な が ら 決 め る ほ う が 整 合 性 確 保 で 強 い
- **「形 議 論 も 仕 様 と し て 詰 め る」 案 棄 却** — 既 ai-agent-paradigm スタンス (= 設 計 合 意 で き れ ば 実 装 O(1)、 取 り 返 し つ か な い の は 曖 昧 設 計) と 衝 突 し、 設 計 と 実 装 の 適 切 な 分 業 を 崩 す
- **「全 部 impl 任 せ」 案 棄 却** — 「曖 昧 さ を 残 す」 で は な い こ と が 余 湖 さ ん の 念 押 し、 仕 様 invariant の 矛 盾 / dangling は き っ ち り 詰 め る

### Side effects

- `open-questions.md` 冒 頭 に **「ratify 範 囲 = 仕 様 invariant だ け」** セ ク シ ョ ン 追 加 (= 「TS signature 細 部 は impl AI 領 域」 を 明 文 化)
- L1-c entry を **「SubgraphInstance<S> invariant の dangling」** に re-scope (= 19 種 階 層 分 類 を 撤 退、 dangling 1 件 だ け 残 す)
- L2-a entry 削 除 (= 撤 去、 impl AI 領 域)
- L2-b entry 削 除 (= 撤 去、 L1-a 連 動 で 自 動 解 消)
- TaskList sync: #86 を SubgraphInstance<S> invariant grill に re-purpose (= subject 更 新)、 #65 (L2-a) を delete、 L2-b は task list に 元 々 task entry ナ シ で sync 不 要
- canonical examples integrity 確 認: docs 仕 様 自 体 は 改 訂 ナ シ (= ratify 範 囲 の 線 引 き 明 文 化 + 個 別 entry の 撤 去 / re-scope の み)、 `12-canonical-examples.md` 修 正 ナ シ
- 既 memory `ai-agent-paradigm-implementation-cost` + `no-preemptive-defer` の 厳 密 適 用 と し て docs 化 (= こ の Q53 自 体 が 「invariant vs 形 の 操 作 的 定 義」 の 第 一 文 献 と な る)

---

## Q54 — defineSubgraph wrapper の 真 の 役 割 + `SubgraphInstance<S>` 撤 廃 (L1-c 完 全 close)

**Status:** resolved.

### Problem

L1-c (= `SubgraphInstance<S>` invariant の dangling) を 詰 め て い く 中 で、 余 湖 さ ん の 上 位 軸 質 問 (2026-05-19): 「**そ も そ も `defineSubgraph` wrapper も い ら な い の で は? ただ の TS 関 数 で 同 等 で は?**」

加 え て:

- `01-dsl.md` §1.6.1 で `SubgraphInstance<S>` が export 約 束 さ れ て い る が、 §5.6.2 で 戻 り 値 と し て 引 用 ナ シ + wrapper の +α 役 割 が prose 不 在 = dangling
- wrapper の 「真 の 役 割」 が 仕 様 docs に 明 文 化 さ れ て お ら ず、 「state 持 ち helper を bundle す る だ け の wrapper か / framework 担 保 が あ る か」 が 余 湖 さ ん 自 身 か ら も 不 明 確
- §5.2 の onepole 例 が 旧 「process lambda 直 接 return」 形 (= canonical Ex 2 / Ex 8 の method-record return 形 と 不 整 合) で stale

### Decision

**`defineSubgraph` / `createSubgraph` wrapper を v1.0.0 で 維 持** (= 関 数 統 一 棄 却) + **wrapper の 真 の 役 割 を 仕 様 prose で 明 文 化** + **`SubgraphInstance<S>` 名 を 公 開 surface か ら 撤 廃**。

wrapper の 真 の 役 割 = 2 つ:

1. **Identification** — wrapper は framework に 「こ れ は subgraph definition で あ っ て inlined helper で は な い」 と marker を 渡 す。 memory budget の 自 動 sum (Q30)、 DevTools graph viewer の instance 単 位 grouping (Q23)、 snapshot path の namespacing 全 て が こ の marker を hook に 動 く。
2. **Name scope for snapshots** — `createSubgraph(..., { name: 'lpfL' })` で 渡 す instance name が snapshot path prefix (e.g. `'lpfL/z1'`) と し て framework に 担 保 さ れ る (Q41)。 wrapper ナ シ で 同 等 機 能 を 出 す path は (a) 変 数 名 暗 黙 prefix 抽 出 (= magic、 declarative 違 反 寄 り)、 (b) user 明 示 name 全 state 宣 言 (= ボ イ ラ ー プ レ ー ト 増)、 (c) 別 名 の 同 等 wrapper (= 名 前 違 う だ け) の 3 通 り、 全 部 既 wrapper よ り 不 健 全 or 等 価。

L1-c (= `SubgraphInstance<S>` 名 撤 廃) を 同 1 entry に bundle:

- §1.6.1 export list か ら `SubgraphInstance<S>` 行 を 削 除 + prose 注 釈 (= 「return record そ の も の、 wrapper type は export し な い、 user は `ReturnType<typeof subgraphDecl>` で TS 標 準 inference」) 追 加
- `createSubgraph(...)` の 戻 り 値 = **subgraph body の return record そ の も の** と §5.6.2 prose で invariant 直 接 規 定 (= wrapper を 挟 ま な い、 alias 名 を 出 さ な い)
- user が type 引 用 し た い 場 合 は `ReturnType<typeof subgraphDecl>` (TS 標 準 inference) で OK

### Why this and not alternatives

- **`defineSubgraph` wrapper 撤 廃 + 関 数 統 一 棄 却**: name scope を framework が 担 保 す る 自 然 な path が wrapper だ け、 関 数 統 一 で 同 等 機 能 を 出 す 3 候 補 (= 変 数 名 抽 出 magic / user 明 示 ボ イ ラ ー プ レ ー ト / 別 名 同 等 wrapper) は 全 部 不 健 全 or 等 価。 canonical Ex 2 (6 instance) / Ex 8 (8 instance) の multi-instance pattern が wrapper の 価 値 を 実 証 (= Ex 5 の wrapper ナ シ voice state flatten pattern と の 対 比 = 既 docs comment で 「Production-grade allocators may use a single state.i32 head + circular mark buffer; this shape favors clarity here」 と 明 言 さ れ た 「subgraph 化 す れ ば ボ イ ラ ー プ レ ー ト 撤 廃」 path)
- **`SubgraphInstance<S>` 名 維 持 案 (= alias) 棄 却**: wrapper +α の 役 割 が 仕 様 invariant 上 存 在 し な い (= subgraph instance か ら 引 け る surface = return record method 群 だ け、 name は `createSubgraph` options で 既 受 け 取 り、 restore / inspect は main 側 surface、 内 部 state 隠 蔽 が pure)、 alias 名 だ け を 公 開 surface に 残 す = jargon (= memory `no-jargon-sprinkling` 累 犯)、 forward compat (= 後 で +α 入 れ た く な っ た 時 に additive 復 活) で 名 前 撤 廃 の breaking リ ス ク も ナ シ
- **wrapper +α 役 割 を 与 え る 案** (= `S & { __unworkletInstanceName?: string }` 等) 棄 却: 「framework が user の return record を 拡 張」 = declarative 違 反 寄 り (= memory `framework-magic-anti-pattern`)、 mental model 1 段 増、 +α が 必 要 な use case が 仕 様 invariant 上 存 在 し な い
- **processor と subgraph の wrapper 共 通 化** (= `defineNode` 1 wrapper) 棄 却: processor = top-level (= AudioContext + audio I/O / param)、 subgraph = inline-only (= I/O / param 不 持) で 構 造 役 割 が 違 う、 共 通 化 す る と mental model 増 (= 「ど の context で 何 が 使 え る か」 を runtime context で 切 る 必 要)

### Side effects

- `01-dsl.md` §1.6.1: `SubgraphInstance<S>` (§5.6) for the value returned by `createSubgraph(...)` 行 削 除 + 直 後 に prose 注 釈 1 段 落 (= 「return record そ の も の、 wrapper type は export し な い、 user は `ReturnType<typeof subgraphDecl>` で TS 標 準 inference」)
- `01-dsl.md` §5.2: wrapper の 真 の 役 割 (= identification + name scope) を 2 bullet で 明 文 化、 旧 「process lambda 直 接 return」 形 例 (= L574-580 の onepole) を 削 除 (= §5.6.1 method-record return 形 と 整 合)、 canonical Ex 2 / Ex 8 vs Ex 5 の 対 比 を prose で 引 用、 旧 「per-block / per-sample phase structure」 wording を 「top-to-bottom 実 行 + forSample は loop primitive (Q51)」 に 揃 え る (= L1-a 整 合 先 取 り、 phase 用 語 sweep 時 に 一 致)
- `01-dsl.md` §5.6.2: signature pseudo (= `subgraph: SubgraphDecl`, `lambdaArgs: LambdaArgs` 表 記) を bullet 説 明 に re-frame (= TS 細 部 は Q53 で impl AI 領 域)、 戻 り 値 を 「subgraph body の return record そ の も の」 と invariant 直 接 規 定
- canonical examples integrity 確 認: `12-canonical-examples.md` の Ex 2 / Ex 8 で `defineSubgraph` / `createSubgraph` 既 method-record return 形 で 整 合、 修 正 ナ シ。 `SubgraphInstance` / `SubgraphDecl` / `LambdaArgs` 言 及 ナ シ で 整 合 (= grep 確 認 済 み、 AGENTS.md HARD CONTRACT 同 commit check OK)
- TaskList #86 (L1-c) completed
- `open-questions.md` か ら L1-c entry 削 除 (= 完 全 close)、 残 grill = L1-a / L1-b / L2-c / L2-d / L3-a の 5 件 + L4 系

---

## Q55 — priority filter 軸 = impl 矛 盾 リ ス ク + L1-a 「phase」 wording sweep (Q53 補 強、 Q51 followup)

**Status:** resolved.

### Problem

Q53 で 「仕 様 invariant vs 形」 の 切 り 分 け を ratify し た 後 も、 棚 卸 し で **「user 視 点」 で priority を 上 げ る 罠** に 落 ち た。 具 体 = L1-a 「phase」 terminology 矛 盾 を L1 内 grill 対 象 と し て 進 め た が、 実 体 = wording sweep = 仕 様 invariant 変 化 ナ シ、 impl AI agent は Q51 ratify mental model (= 「forSample は loop primitive で あ っ て phase で は な い」) で 1 意 に 読 め る = 異 な る agent が 異 な る judgment に 達 す る リ ス ク な し = 真 の ★★★ で は な い。

余 湖 さ ん の 直 接 指 摘 (2026-05-19):

> こ の docs は あ く ま で 実 装 agent が 迷 わ ず 判 断 す る た め の も の。 だ か ら た し か に wording は 絶 対 に 統 一 し た 方 が い い の は 間 違 い な い が、 「ユ ー ザ ー が 誤 解 す る」 と か は 全 然 違 う。 user facing な ド キ ュ メ ン ト は 完 成 後 に 作 る。 [...] 「こ の ま ま AI に 手 放 し で 実 装 さ せ た ら 矛 盾 が 出 て し ま う よ う な 点」 な ど を 優 先 的 に 潰 し た い。

= **棚 卸 し priority 軸 が 明 確 に 提 示**: 「impl 矛 盾 リ ス ク」 を 唯 一 の judgement 軸 と し て docs 化 必 要。

### Decision

**v1.0.0 ship 前 docs の 読 者 = impl AI agent**。 user-facing docs (= getting started / API reference / tutorials) は v1.0.0 完 成 後 別 phase で 作 る = い ま 関 心 範 囲 外。

**priority filter の 唯 一 の 軸**:

| 評 価 | 例 | 行 動 |
| --- | --- | --- |
| **Yes** = impl AI agent が 手 放 し で 実 装 し た 時 に 矛 盾 が 出 る | 仕 様 prose 内 で 矛 盾 / dangling、 異 な る agent が 異 な る judgment に 達 し て 矛 盾 し た 実 装 が 出 る | ★★★ priority、 余 湖 さ ん grill 必 要 |
| **No** = impl AI agent は 1 意 に 読 め る | wording rename / 表 記 揃 え / user 読 解 違 和 感 だ が 仕 様 invariant 不 変 | mechanical sweep 領 域、 freeze 前 に 1 batch、 余 湖 さ ん grill 不 要 |

「user が 誤 解 す る」 「mental model が 揺 れ る」 「読 解 違 和 感」 等 の user-facing 視 点 で priority を 上 げ る な = 累 犯 リ ス ク。 wording rename が impl 矛 盾 を 引 き 起 こ す ケ ー ス は 例 外 的 (= 識 別 子 名 衝 突 等)、 通 常 は 「言 葉 の あ や」 = L4 sweep。

**L1-a 「phase」 wording sweep (= Q51 followup)** を 同 commit で 完 了:

「`forSample` は loop primitive で あ っ て phase で は な い」 (Q51) を 反 映 し て、 docs 全 体 で 構 造 名 詞 「Per-block phase / per-sample phase = the two execution phases」 を 撤 廃 し adjective (= per-block / per-sample) の み を 維 持 (= (A) Retire author side、 compiler side は 別 軸 で 維 持) す る:

- 構 造 名 詞 (「two execution phases」 / 「single-phase」 / 「multi-phase」 / 「multiple forSample phases」) を 撤 廃
- adjective (「per-block」 / 「per-sample」) は 時 間 軸 説 明 と し て 維 持 (= 「per-block code」 「per-sample code」 「per-block top level」)
- §6 heading `The process phase` → `The process body`、 §10.4.1 `Single-phase` → `Per-sample-only`、 §10.4.2 `Multi-phase` → `Mixed (interleaved per-block and per-sample, with SIMD)`
- canonical Ex 3 description `multi-phase` → `mixed per-block + per-sample`、 SIMD example の `// Phase 1: ... // Phase 2: ... // Phase 3:` → `// Step 1: ... // Step 2: ... // Step 3:`
- compiler phase (= `03-compiler.md` 内 「graph capture phase」 / 「Phase walk」) は build pipeline 内 部 用 語 で 別 軸 = 触 ら ず
- DSP 領 域 用 語 (= minimum-phase / linear-phase) / oscillator の `phase = state.f32(...)` 物 理 phase counter / 「fall out of phase」 音 響 phase / Q51 ratify mental model 段 落 内 の 否 定 文 「no fixed phase boundary」 「not a phase the framework reorders」 は 全 て retain (= 別 意 で 自 然)

### Why this and not alternatives

- **「user 視 点」 を priority 軸 と し て 残 す 案** 棄 却: user-facing docs は v1.0.0 完 成 後 別 phase = 今 関 心 範 囲 外、 user-facing 視 点 で 軸 を 設 定 す る と mechanical sweep が priority 上 位 に 流 れ 込 む = 余 湖 さ ん 負 担 累 犯
- **「全 doc 矛 盾 解 消 を 一 律 priority」** 棄 却: 「矛 盾」 で も impl AI agent が 1 意 に 読 め る 矛 盾 (= wording 揺 れ、 Q51 ratify mental model 段 落 で disambiguate 可) は mechanical sweep、 真 の 「矛 盾」 = 異 な る agent が 異 な る judgment に 達 す る prose 衝 突 だ け を ★★★ と す る 厳 密 化 が 必 要
- **構 造 名 詞 「phase」 を docs で 維 持 + redefine 案** 棄 却 (L1-a 内 (B) 案): Q51 ratify と 並 存 状 態 が 続 く、 wording sweep コ ス ト が 後 倒 し に な る だ け
- **compiler 側 「phase」 も rename 案** 棄 却 (L1-a 内 (D) 案): compiler 側 既 ratify (Q22 / Q34 等) で 「graph capture phase」 が 確 立、 rename す る と 過 去 decisions-log 引 用 と drift、 sweep 量 大 + 価 値 小

### Side effects

- `open-questions.md` 冒 頭 「ratify 範 囲」 section を **「ratify 範 囲 と priority filter」** に 拡 張、 「docs 読 者 = impl AI agent」 + 「priority filter = impl 矛 盾 リ ス ク」 を 明 文 化
- `open-questions.md` 「層 内 順 序 の 判 断 軸」 を 「impl 矛 盾 リ ス ク」 軸 で update (旧 「公 開 surface 確 定 度」 軸 を 置 換)
- `open-questions.md` か ら L1-a entry 削 除 (= sweep 完 了)、 L1-b の 「な ぜ こ の 位 置」 prose を 「L1 内 最 上 段」 + 「真 の impl 矛 盾 リ ス ク = L498 prose と Q51 ratify の prose 衝 突」 に update
- L1-a wording sweep の docs 反 映:
  - `00-foundations.md` §3 vocabulary: `Per-block phase / per-sample phase` heading → `Per-block code / per-sample code`、 prose `two execution phases` → `two kinds of code`、 関 連 adjective 化
  - `01-dsl.md` §1.1 / §3.1 / §3.3 / §4.2 / §5 / §6 / §7 / §10.1 等 で 構 造 名 詞 「phase」 撤 廃、 §6 heading `The process phase` → `The process body`、 §10.4.1 / §10.4.2 heading rename
  - `02-messaging.md` §1 / `11-midi.md` §2.4: adjective 化
  - `12-canonical-examples.md` Ex 3 description: 「multi-phase」 → 「mixed per-block + per-sample」
- canonical examples integrity 確 認: oscillator phase counter / minimum-phase / linear-phase / 音 響 phase 用 語 は DSP 領 域 別 意 = 触 ら ず、 構 造 名 詞 撤 廃 と 整 合 (= AGENTS.md HARD CONTRACT 同 commit 整 合 確 認 済 み)
- 新 memory `feedback_docs-readership-and-priority.md` 作 成 (= 行 動 規 律 と し て session 跨 ぎ 引 用 可)
- TaskList #82 (L1-a) completed

---

## Q56 — Handler body の expression scope (= L1-b、 Q51 followup)

**Status:** resolved.

### Problem

Q51 で 「process body 任 意 位 置 で sample-offset primitive (`audioIn.at` / `audioOut.set` / `param.at`) OK」 と ratify。 し か し `01-dsl.md` §4.2 L500 prose は 「Inside a handler, only state writes, buffer writes, and scalar arithmetic are allowed — sample-offset `i` is not in scope, so audio I/O primitives produce TypeScript reference errors」 と 残 っ た ま ま、 Q51 と 真 っ 向 衝 突。 同 doc 内 で §4.1 (event `emitIf`) / §5.6.4 (subgraph method context) / §6 (process body summary) / Q32 (= `emitIf` 統 一) は 既 に 「handler body 内 で `emitIf` / subgraph method 呼 び 出 し OK」 と 規 定 し て お り、 §4.2 L500 が 唯 一 の 狭 い prose と し て 残 っ て い た = impl AI agent が 異 な る judgment に 達 す る dangling、 真 の impl 矛 盾 リ ス ク。

### Decision

handler body (= `messageDecl.onReceive(handler)` / `midiInput().onEvent(type, handler)` の callback body) の expression scope は **`forSample` callback と 完 全 一 致 ル ー ル**:

- **legal**: primitive operators / `state.load` / `state.store` / buffer read+write / audio I/O (`audioIn.at(c, i)` / `audioOut.set(c, i, v)`) / `param.at(i)` / `emitIf` / subgraph methods / L1 helper 呼 び 出 し
- **illegal**: 新 規 declaration (`state.*` / `buffer.*` / `param.*` / `createSubgraph(...)`)
- **sample-offset 引 数** = `Node<'i32'> | number` 一 律、 source 制 限 ナ シ (= handler arg の `atSample` (MIDI handler) / state slot value / buffer read / JS literal の ど れ も OK)
- **surrounding `forSample` の `i`** = scope 外 (= 既 規 定 通 り、 handler は forSample の 前 に drain さ れ る た め)

= **「handler body も `forSample` と 同 じ context」** を 1 ル ー ル に 統 一。

### Why this and not alternatives

**判 断 軸** = mental model シ ン プ ル さ (= user が 覚 え る context rule の 数) + 公 開 surface の 概 念 量 (= 例 外 規 則 の 有 無)。

- **案 A (= 採 用)**: context rule 1 個 (= handler と `forSample` 同 一)、 例 外 規 則 ナ シ。 Q51 ratify (= 「process body は top-to-bottom 一 種 類、 `forSample` は loop primitive」) と 整 合。 §4.1 / §5.6.4 / §6 / Q32 既 規 定 と も 完 全 整 合 (= 「`emitIf` は OK だ が audio I/O は NG」 の 半 端 な 例 外 規 則 を 残 さ な い)。
- **案 (d) = 一 切 禁 止 (= 既 L500 prose 維 持、 「handler は state 書 き 込 み 専 用 segment」)** 棄 却:
  - user に context rule を 2 種 (= `forSample` 用 + handler 用) 覚 え さ せ る、 mental model の 概 念 量 が 1 個 増 え る
  - 同 じ 関 数 (`audioOut.set` 等) が 同 じ `process` 内 の 別 lexical 位 置 で 「legal / illegal」 が 変 わ る compile error 罠 を 1 個 追 加
  - §4.1 / §5.6.4 / §6 / Q32 既 規 定 で 既 に handler body 内 `emitIf` / subgraph method OK = 案 (d) 維 持 で も 半 端 な 例 外 規 則 が 残 る
  - 案 A 採 用 で も 案 (d) の 書 き 方 (= handler で `state.store` + `forSample` で 比 較) は そ の ま ま 残 る、 表 現 を 1 個 増 や す だ け で 何 も 失 わ な い
- **案 (a) JS literal だ け 受 け 入 れ** 棄 却: handler arg (= MIDI handler の `atSample`) を sample-offset と し て 渡 せ な い 不 自 然 制 約 を 1 個 追 加、 `forSample` 内 規 則 と 揃 わ な い (= no-artificial-constraint 違 反)
- **案 (b) `Node<'i32'>` だ け (= literal 不 可)** 棄 却: `forSample` 内 で literal `0` OK な の に handler 内 で だ け 不 可 = 純 然 た る 例 外 規 則、 不 自 然
- **「使 わ れ な い 機 能 を 開 け な い」 と い う 直 感 か ら の 案 (d) 寄 り 評 価 は 棄 却**: handler 内 で の sample-accurate 1 sample hit (= 案 A の 副 次 advantage) は kick / drum で も 実 際 は decay envelope が 必 要 = `forSample` 内 計 算 forced = 1 行 形 は 使 わ れ な い fact は 真。 ただ し 案 A の 主 軸 = mental model 統 一 で あ っ て sample-accurate hit 機 能 で は な い、 副 次 利 益 の 弱 さ で 主 軸 を 捨 て る path は 棄 却。

### Side effects

- `01-dsl.md` §4.2 L500 prose を 書 き 換 え (= 「same expression-scope rules as a `forSample` callback」 形 で 統 一 規 定)
- `02-messaging.md` §1 L23 末 尾 prose を 拡 張 (= 「Handlers may also call `emitIf`...」 → expression-scope rule 全 体 統 一 規 定)
- `11-midi.md` §2.3 末 尾 に 1 段 落 追 加 (= MIDI handler 側 で も 同 invariant を 明 言、 state-slot-driven trigger pattern を canonical と し て retain prose 付 与)
- `00-foundations.md` §3 「Expression scope」 entry L60 = 既 に handler body も 並 列 規 定、 触 ら ず (= 既 整 合)
- `00-foundations.md` §3 「Sample-offset (i)」 entry L70 = per-block / forSample の 規 則 prose、 handler body は L60 の expression scope 規 定 で 暗 黙 整 合、 触 ら ず
- canonical Ex 5 / Ex 6 / Ex 8 の handler 内 は 全 て `state.store` の み 使 用、 案 A / 案 (d) で 同 じ コ ー ド = AGENTS.md HARD CONTRACT 同 commit 整 合 確 認 済 み
- `open-questions.md` か ら L1-b entry 削 除、 Layer 1 件 数 を 3 → 2 に 更 新 (= 残 = L2-c / L2-d)
- TaskList #84 (L1-b) completed

---

## Q57 — `createNode({ restore })` option 廃 止 (= L2-c)

**Status:** resolved.

### Problem

`05-client.md` §1 の `CreateNodeOptions<C>.restore?: Uint8Array` は 「Schema mismatch routed through the processor's `migrations` chain (see `01-dsl.md` §8.3)」 と 書 く が、 `createNode` の 戻 り 値 は `Promise<UnworkletNode<C>>` で `RestoreResult` を 含 ま な い。 別 path の `node.restore(blob)` (= Q45 ratify) は `RestoreResult` discriminated union を 戻 り 値 で 返 し て migration が throw し た 場 合 の 失 敗 情 報 を expose し て い る が、 `createNode({ restore })` 経 由 で migration が throw し た 場 合 の 報 告 path が 仕 様 化 さ れ て い な い = **異 な る impl agent が 異 な る surface に 行 く dangling**、 真 の impl 矛 盾 リ ス ク。

### Decision

**`CreateNodeOptions<C>.restore?: Uint8Array` を v1.0.0 surface か ら 廃 止**。 `createNode` の 戻 り 値 形 は 常 に `Promise<UnworkletNode<C>>` で 統 一。 snapshot 復 元 し た い consumer は **2 step pattern** を 書 く:

```typescript
const node   = await createNode(audioContext, processor);
const result = await node.restore(blob);
if (!result.ok) { /* migration failure surface (Q45) */ }
```

### Why this and not alternatives

**判 断 軸** = 公 開 surface の 概 念 量 + 戻 り 値 形 の 統 一 度 + canonical Ex 群 と consumer 実 装 の 実 態 整 合。

- **案 (A) 戻 り 値 を `Promise<{ node: UnworkletNode<C>; restore: RestoreResult }>` に 拡 張** 棄 却:
  - restore option を 渡 し た 時 だ け wrap、 渡 さ な い 時 は 従 来 通 り = 戻 り 値 形 が option 有 無 で **2 種** に 分 岐、 TS overload 2 種 増
  - 同 じ 関 数 で 「destructure し て い い 時 / し な い 時」 が surface に 出 る = mental model の 概 念 量 増
- **案 (B) `onError` event で 通 知、 `createNode` 自 体 は 必 ず resolve** 棄 却:
  - `onError` event は worklet trap / queue overflow / SAB-mode 変 化 等 の **起 動 後 の 非 同 期 event** 用 (= 既 §2 surface)
  - 「migration が throw」 は node 起 動 時 の **同 期 flow** = 結 果 を 同 期 で 待 ち た い flow を 非 同 期 event に forced は mental model 衝 突、 「失 敗 後 に node を 使 う か 否 か」 の 同 期 分 岐 が 書 け な い
- **案 (C) = 採 用 (= 経 路 廃 止)**:
  - 公 開 surface が 1 個 減 る (= `restore` option を v1.0.0 か ら 削 る)
  - `createNode` の 戻 り 値 形 が 常 に `Promise<UnworkletNode<C>>` で 統 一 (= overload 2 種 ナ シ)
  - mental model = 「node 作 成 と state 復 元 は 別 step」 を 1 step 化 で 曖 昧 に せ ず 明 確 化
  - canonical Ex 群 (= Ex 1 〜 Ex 8) で `createNode({ restore })` 使 用 例 ナ シ = consumer は **既 に 2 step pattern で 書 い て い る fact**、 ergonomic loss は +1 行 で 軽 微
  - v1.x.0 で 「1 step ergonomic」 必 要 性 が 出 た ら 案 A 形 を additive 追 加 可 = [[no-preemptive-defer]] 観 点 で OK (= API surface / 型 / mental model に 染 み 出 さ ず、 純 加 算 surface)

### Side effects

- `05-client.md` §1 `CreateNodeOptions<C>` か ら `restore?: Uint8Array` field 削 除 + 関 連 comment 削 除
- `05-client.md` §1 末 尾 に 1 段 落 + code block 追 加 = 2 step pattern が canonical と 明 文 化 (= Q45 `RestoreResult` 経 由 で migration 失 敗 surface 取 得 を 明 記)
- `13-offline-render.md` §2 TODO comment (L45) + §4 prose (L58) の `createNode(..., { restore })` 参 照 を `node.restore(blob)` 経 由 表 記 に rename
- canonical Ex 群 で `createNode({ restore })` 使 用 ナ シ を 確 認 (= L330 Ex 3 で `createNode(audioContext, linearPhaseEQ, { initial: { /* none */ } })` の `initial` 経 由 だ け) = AGENTS.md HARD CONTRACT 同 commit 整 合 確 認 済 み
- `open-questions.md` か ら L2-c entry 削 除、 Layer 1 件 数 を 2 → 1 に 更 新 (= 残 = L2-d 1 件)
- TaskList #88 (L2-c) completed

---

## Q58 — L1 helper の nested `forSample` 明 示 化 (= L2-d、 旧 L3-b)

**Status:** resolved.

### Problem

`01-dsl.md` §5.5.5 既 prose は L1 helper 内 で `forSample(...)` 呼 び 出 し が 「rare; usually iteration is the caller's job and the helper is invoked from inside the caller's `forSample`」 と OK 寄 り に 書 い て あ る。 §10.3 forSample body constraints も 「Allowed: ... nested `forSample` (rare; typically used for tile iteration in 2D buffers)」 と OK 寄 り。 ただ し:

- caller が `forSample` 内 か ら helper を 呼 び、 helper も 内 部 で `forSample` を 呼 ん だ 時 の 二 重 ル ー プ 動 作 が spec で 明 文 化 さ れ て い な い
- 内 外 callback の `i` の scoping ル ー ル が 暗 黙 (= TS 関 数 引 数 の 標 準 動 作 だ が spec で 言 及 ナ シ)
- RT-safe 静 的 解 析 が 内 外 両 方 の forSample に bounded check を 適 用 す る か が 暗 黙

= 異 な る impl agent が (A) 暗 黙 OK / (B) 禁 止 / (C) tile use case 限 定 の どれ か を 別 々 に 採 用 し て 公 開 surface が 衝 突 し う る dangling、 真 の impl 矛 盾 リ ス ク。

### Decision

L1 helper 内 で `forSample(...)` 呼 び + caller が `forSample` 内 か ら helper を 呼 ぶ pattern (= 暗 黙 nested forSample) を **v1.0.0 で 認 め る**。 §10.3 既 wording の 自 然 帰 結 と し て 「直 接 `forSample` 内 で `forSample` を 呼 ぶ」 pattern も 同 様 に legal。

仕 様 invariant:

- **二 重 ル ー プ 構 造**: 内 forSample は 外 forSample の iteration ご と に 1 回 走 る (= 外 128 回 × 内 128 回 = 16384 sample operations / quantum for stride-1 nesting)、 WASM 上 で は 単 純 な ネ ス ト ル ー プ と し て emit。
- **sample-offset の 独 立 性**: 内 外 callback は 別 々 の TypeScript 関 数 = 各 `i` arg は callback ご と に 別 物 (= 通 常 の TS 関 数 引 数 scope)、 framework 側 で 特 別 な scoping rule 不 要。
- **RT-safe 静 的 解 析**: bounded loop check (= `SAMPLES_PER_BLOCK` 上 限) を 内 外 両 方 の forSample に 独 立 に 適 用 = 既 invariant (Q22 / Q29) の 自 然 拡 張、 新 ル ー ル ナ シ。
- **計 算 量 責 任**: ネ ス ト 時 の per-quantum iteration 量 が target latency と 整 合 す る か は user の 設 計 責 任。

### Why this and not alternatives

**判 断 軸** = helper の 関 数 抽 象 維 持 + 既 invariant と の 整 合 + 既 prose と の 衝 突 回 避。

- **案 A (= 採 用)**: helper の 呼 び 位 置 で 動 作 が 変 わ ら な い (= 関 数 抽 象 維 持)、 既 bounded-loop invariant の 自 然 適 用 で 新 ル ー ル ナ シ、 §10.3 既 wording を 拡 張 す る だ け で 明 文 化 完 了。
- **案 (B) nested forSample 禁 止** 棄 却:
  - 「helper を 呼 ぶ 位 置 に よ っ て graph-capture-time error に な る / な ら な い」 = 関 数 抽 象 の 漏 れ、 user は 「こ の helper、 forSample の 外 か ら し か 呼 べ な い」 と 余 計 な ル ー ル を 1 個 覚 え る ([[no-artificial-constraint]] 違 反)
  - §10.3 既 prose 「nested forSample (rare; typically used for tile iteration in 2D buffers)」 と 真 っ 向 衝 突、 wording 撤 回 が 必 要
- **案 (C) 案 A + canonical Ex 1 例 追 加** 棄 却:
  - v1.0.0 ship 必 須 で は な い (= rare use case、 主 要 use case は Ex 1〜8 で カ バ ー 済 み)
  - canonical 追 加 は メ ン テ コ ス ト 増、 L4-d / L4-e (= voice-allocation / overlap-add recipe) と 同 軸 で v1.x.0 / recipes/ で defer 可 = [[no-preemptive-defer]] 観 点 で OK (= API surface / 型 / mental model に 染 み 出 さ ず、 純 加 算 docs)

### Side effects

- `01-dsl.md` §5.5.5 L718 wording を 拡 張 (= 既 「rare; usually iteration is the caller's job」 prose に + 1 文 で 二 重 ル ー プ 動 作 + sample-offset 独 立 性 + RT-safe check 範 囲 + 計 算 量 注 意 喚 起 を 明 文 化)
- `01-dsl.md` §10.3 L1305 wording を 拡 張 (= 既 「nested `forSample` (rare; ...)」 prose に + 1 文 で sample-offset 独 立 性 + RT-safe check 内 外 独 立 適 用 を 明 記、 「L1 helper 経 由 で 成 立 す る nested」 も 同 wording で カ バ ー)
- `00-foundations.md` §3 + RT-safe table (L210 / L231) = 既 「Every loop emitted into WASM has a build-time-known upper bound」 invariant の 自 然 適 用 = 触 ら ず (= nested で も bounded で あ る こ と は 当 然 帰 結)
- `03-compiler.md` §2.4 Layer 3 loop-boundedness check = 既 prose 「across forSample / everyNSamples / ...」 で 暗 黙 整 合 = 触 ら ず
- canonical Ex 群 で nested forSample 使 用 ナ シ = AGENTS.md HARD CONTRACT 整 合 確 認 済 み (= 触 ら ず)
- `open-questions.md` か ら L2-d entry 削 除、 **Layer 1 件 数 0 = Layer 1 section の dangling 全 解 消**、 section heading は retain し て 「該 当 entry ナ シ」 prose を 入 れ る (= 後 続 grill で 新 規 dangling 発 見 時 の 受 け 皿)
- TaskList #90 (L2-d) completed

---

## Q59 — SIMD `sumLanes` を v1.0.0 で 出 す (= L3-a)

**Status:** resolved.

### Problem

`@unworklet/core/simd` の v1.0.0 MVP surface (= `01-dsl.md` §7.2) に は `vec4` / `splat` / `addVec` / `subVec` / `mulVec` / `divVec` / `vec.lane(0..3)` / `buf.loadVec` / `buf.storeVec` が 並 ぶ。 4 lane を 1 scalar に collapse す る 「horizontal reduction」 primitive (= `sumLanes(v: Node<'f32x4'>): Node<'f32'>`) を v1.0.0 surface に 含 め る か、 v1.x.0 へ defer す る か が 未 決。 SIMD 主 要 use case (= 4-tap FIR / dot product / per-block accumulator collapse) で 「vec → scalar」 collapse が 出 る た び、 user は `add(add(v.lane(0), v.lane(1)), add(v.lane(2), v.lane(3)))` の 4 行 を 書 く こ と に な る。

### Decision

`sumLanes(v: Node<'f32x4'>): Node<'f32'>` を **v1.0.0 で export**。 `@unworklet/core/simd` の MVP surface に Lane access の 直 後 「Horizontal reduction」 sub-section と し て 追 加。

仕 様 invariant:

- **戻 り 値**: 4 lane の sum を `Node<'f32'>` で 返 す (= `v.lane(0) + v.lane(1) + v.lane(2) + v.lane(3)` と 数 値 的 等 価)
- **WASM emit**: framework が shuffle + add に lowering (= WASM SIMD spec に float horizontal reduce 直 接 ナ シ)、 性 能 は 4 行 形 と ほ ぼ 同 等、 利 益 は ergonomic
- **公 開 surface**: free function、 import path = `@unworklet/core/simd`

### Why this and not alternatives

**判 断 軸** = 既 知 必 要 性 + ergonomic 利 益 の cumulative 累 積 + minimal 哲 学 と の 整 合。

- **案 A (= 採 用)**:
  - canonical Ex 3 / Ex 7 で 既 に 3 箇 所 で 4 行 pattern を 使 っ て い る fact = 主 要 use case で 既 知 必 要
  - 既 `vec.lane(0..3)` の natural な 終 端 操 作 (= lane 個 別 ア ク セ ス を SIMD 全 体 で 1 scalar に collapse す る) で、 minimal 哲 学 か ら 外 れ な い (= SIMD 概 念 の 自 然 帰 結、 toolbox 化 で は な い)
  - v1.x.0 で 追 加 し て も 同 じ surface 1 個 増、 い ま 入 れ る か v1.x.0 か の 差 は 「user が SIMD を 触 り 始 め た 瞬 間 か ら 1 行 で 書 け る か」 だ け
- **案 (B) v1.x.0 defer** 棄 却:
  - 既 知 必 要 を defer す る = [[no-preemptive-defer]] 違 反 リ ス ク
  - SIMD primitive family (= comparison / mask / shuffle / gather / scatter / f64x2 / i32x4) の v1.x.0 拡 張 と は **別 軸** (= lane access の 終 端 操 作 で 単 独 primitive)、 family と し て の v1.x.0 batch に 含 め る 根 拠 が 弱 い
  - canonical Ex で 既 に 4 行 pattern を 書 い て い る = consumer が v1.x.0 ま で 4 行 pattern を 継 続 = 既 知 不 便 を 課 す

### Side effects

- `01-dsl.md` §7.1 prose + SIMD-using import 例 に `sumLanes` 追 加 (= 「vec4 / splat / addVec / mulVec / subVec / divVec / sumLanes are free functions」)
- `01-dsl.md` §7.2 Lane access sub-section の 直 後 に 「Horizontal reduction」 sub-section 新 規 追 加 (= signature + lowering note + typical use 例 を 1 段 落)
- `01-dsl.md` §7.3 「Beyond v1.0.0 (deferred)」 = 既 list に sumLanes 不 在 = 触 ら ず (= v1.0.0 採 用 で 整 合)
- `12-canonical-examples.md` Ex 3 (L315) と Ex 7 (L869 / L870) の 3 箇 所 で 4 行 pattern を `sumLanes(...)` 形 に rewrite、 Ex 3 / Ex 7 の SIMD import 文 (L269 / L804) に `sumLanes` 追 加 = AGENTS.md HARD CONTRACT 整 合
- `open-questions.md` か ら L3-a entry 削 除、 **Layer 2 件 数 0 = Layer 2 additive section の 残 entry 全 解 消**、 section heading は retain し て 「該 当 entry ナ シ」 prose を 入 れ る
- TaskList #66 (L3-a) completed

---

## Q60 — Trivial repo settings batch (= L4-c × 4)

**Status:** resolved.

### Decision

`09-repo-structure.md` §1 / §3 / §4 / §5 を 同 commit で fill。 4 設 定 値 を 1 batch で ratify:

1. **Monorepo tool** = pnpm workspaces。 設 定: root `pnpm-workspace.yaml` + root `package.json` の `packageManager: pnpm@<version>` + cross-package ref は `workspace:*` protocol。 開 発 / CI で の 起 動 は 全 て `vp` CLI 経 由 (= AGENTS.md HARD CONTRACT、 npm / pnpm / yarn / npx 直 接 起 動 永 久 排 除)。 VitePlus は user 選 択 で pnpm / npm / yarn / bun を wrap し、 `vp install` が 内 部 で 選 択 さ れ た package manager を 起 動。
2. **License** = MIT。
3. **npm scope** = `@unworklet` (= 余 湖 さ ん の npm account で 既 確 保 済 み)。
4. **TypeScript minimum** = 5.5。

### Why this and not alternatives

trivial 設 定 値 = 余 湖 さ ん の 既 取 得 / 既 嗜 好 で 決 ま る 値、 impl AI agent は 確 定 値 を 設 定 す れ ば 矛 盾 出 な い = 個 別 grill 不 要 で batch ratify。 各 値 単 独 で の 個 別 棚 卸 し は 余 湖 さ ん attention 浪 費 と し て 一 括 化。

### Side effects

- `09-repo-structure.md` §1 + §3 + §4 + §5 を fill、 Status を `partial (§1–§5 settled at Q60 / Q61; §6 awaits Q14 land)` に 更 新
- §6 versioning policy = Q14 acceptance criteria 連 動 で 後 続 batch、 触 ら ず
- TaskList #77 (Q12) / #79 (Q15) / #80 (Q16) / #81 (Q26) completed

---

## Q61 — Placeholder section 群 = impl 期 owner 任 せ 明 文 化 (= L4-a)

**Status:** resolved.

### Decision

各 doc に 残 る `<!-- placeholder -->` section (= compiler 内 部 / worklet runtime 内 部 / testing 内 部 / vite-plugin 内 部 / deployment / roadmap / offline 等 の internal implementation spec が 大 半、 公 開 surface で は な い) は **impl 開 始 時 に 各 doc owner が 順 次 fill** す る 方 針 と し て docs 化。 v1.0.0 spec freeze 前 に 全 部 drain ナ シ。

対 象 placeholder list:

| doc | placeholder |
| --- | --- |
| `00-foundations.md` | §6 cross-cutting |
| `03-compiler.md` | §1 / §3 / §4 / §5 / §6 / §7 / §8 |
| `04-worklet-runtime.md` | §1 / §2 / §8 |
| `05-client.md` | §3 / §4 |
| `06-testing.md` | §2 / §3 / §4 / §5 |
| `07-vite-plugin.md` | §2 / §3 / §5 / §6.x TODO |
| `08-deployment.md` | §3 / §4 |
| `10-roadmap.md` | §1 / §2 / §3.2 |
| `13-offline-render.md` | §2.x / §3 |

`09-repo-structure.md` §6 (= versioning policy) は Q14 acceptance criteria 連 動 で 別 batch、 こ の Q61 範 疇 外。

### Why this and not alternatives

- 案 (i) freeze 前 全 部 drain 棄 却: placeholder の 大 半 が internal implementation spec = v1.0.0 ship 前 docs (= impl AI agent 仕 様) で 必 須 ナ シ、 余 湖 さ ん attention 投 入 ROI 低 い
- 案 (iii) freeze 後 必 要 順 棄 却: (ii) と ほ ぼ 同 じ だ が freeze 前 / 後 の 区 切 り が 曖 昧、 (ii) の 方 が clear

### Side effects

- 各 placeholder section へ の 統 一 注 釈 prose (= 「impl 開 始 時 に 当 該 module owner が fill、 v1.0.0 spec freeze は 妨 げ な い」 形 式) の 散 布 は **L4-M4 sweep の 領 域** で 後 続 batch、 ratify 自 体 は こ の entry で 完 結
- TaskList #99 (L4-a) completed

---

## Q62 — v1.0.0 acceptance criteria (= L4-b、 Q14)

**Status:** resolved.

### Decision

`10-roadmap.md` §1 を fill。 9 項 目 checklist (= A1〜A3 build/compile + B1〜B2 functional + C1 safety + D1 browser matrix + E1〜E2 integrity + F1 public surface integrity) で impl AI agent が ship 可 否 を 1 意 判 定 で き る 形 に。 1 項 目 で も 落 ち た ら ship 不 可、 全 項 目 OK で ship。

各 項 目 の 内 容 は `10-roadmap.md` §1 を 権 威 と し て 参 照。 こ の Q62 entry は そ の 採 用 / 棄 却 決 定 を 記 録。

### Browser matrix decision

採 用 = **(β) Chromium + Firefox + Safari × {COOP/COEP cross-origin isolated, not isolated} = 6 セ ル full required** (= `08-deployment.md` §2 末 尾 Per-browser validation matrix と 整 合)。

**D1 smoke test 仕 様** の重要 補 足:

- `connectFromWebMIDI` (= Web MIDI 標 準 wrapper) は **smoke test 対 象 外** = unworklet の test 範 囲 で は な い (= Q11 ratify の emission boundary 外 側 = consumer 責 任 と 整 合、 `08-deployment.md` §2 B1)
- 全 browser セ ル で `node.midi.<name>.send(event)` source-agnostic injection (= `11-midi.md` §3) 経 由 で MIDI 動 作 を 統 一 検 証 = Safari セ ル で も 同 path で 6/6 セ ル smoke pass 達 成 可
- = Safari の Web MIDI 非 サ ポ ー ト は unworklet 側 実 装 変 更 を 要 さ な い (= consumer が `navigator.requestMIDIAccess` を feature-detect す る path、 unworklet 内 部 機 能 は Safari で 動 く)

### Why this and not alternatives

- **案 (α) Chromium + Firefox 4 セ ル** 棄 却:
  - Safari は AudioWorklet / SAB (15.2+) / WASM SIMD (16.4+) を 全 て サ ポ ー ト = unworklet の core 機 能 は Safari で 動 く fact
  - Safari の core 制 約 は **Web MIDI 非 サ ポ ー ト** に 限 定 (= Q11 emission boundary 外 側 = unworklet の 問 題 で は な い)
  - = Safari を validation matrix か ら 外 す 根 拠 が 弱 い、 (β) 達 成 可 能
- **案 (γ) Safari best-effort + known limitations 棄 却**:
  - 「best-effort」 = 曖 昧、 impl AI agent が 1 意 判 定 で き な い (= D1 smoke pass か / fail か 不 明 確)
  - (β) で full required + Web MIDI 制 約 は 別 surface (= consumer 責 任) と 厳 密 規 定 す る 方 が clean
- **Safari known issues の 確 認** (= 2026-05 時 点):
  - Web MIDI = ❌ 永 続 非 サ ポ ー ト (Apple 2020 公 式 ス タ ン ス、 fingerprinting 懸 念) → Q11 / B1 で consumer 責 任 既 規 定
  - AudioWorklet = ✅ 14.1+
  - SharedArrayBuffer + COOP/COEP = ✅ 15.2+ (= WebKit bug #237144 「SAB posted to AudioWorkletProcessor not shared」 は postMessage fallback 経 路 = Q11 / A5 既 ratify で 自 動 救 済)
  - WASM SIMD f32x4 = ✅ 16.4+
  - WASM Relaxed SIMD = ⚠ flag-gated だ が v1.0.0 SIMD MVP は fixed-width 128bit f32x4 だ け = 影 響 ナ シ

### Side effects

- `10-roadmap.md` §1 を fill (= 9 項 目 checklist 規 定)、 Status を `partial (§1 written at Q62; §3.1 mandatory deferred mitigations written; §2, §3.2 placeholder)` に 更 新
- `08-deployment.md` §2 B1 末 尾 に Safari Web MIDI 制 約 1 段 落 補 強 (= consumer feature-detect + fallback path の 明 文 化)
- `08-deployment.md` §2 Per-browser validation prose に 1 文 補 強 (= Web MIDI 標 準 自 体 は test 対 象 外、 Safari セ ル smoke 範 囲 の 明 文 化)
- `09-repo-structure.md` §6 versioning policy = Q14 land 連 動 と prose comment に 残 す (= Q62 ratify で versioning 自 体 は touch せ ず、 §6 fill は freeze 前 別 batch)
- TaskList #75 (L4-b) completed

---

## Q17 — Math precision variants

**Status:** resolved.

**Decision:** `@unworklet/core` の math primitive (= `sin` / `cos` / `tan` / `tanh` / `exp` / `log` / `sqrt` 等) を v1.0.0 で **polynomial approximation 1 variant** に 統 一 す る。 全 て 5-7 次 minimax polynomial を WASM 関 数 と し て 直 接 emit、 FFI / JS-WASM boundary cross 不 在 で 全 計 算 が WASM 内 部 完 結、 audio thread realtime safe。 最 大 誤 差 約 1e-4 = 24-bit audio dynamic range の noise floor 以 下 で 不 可 聴。

`/precise` (= WASM 内 bundle libm) / `/table` (= precomputed table lookup) variant は v1.x.0 で additive 追 加 検 討、 v1.0.0 surface に は 入 れ な い。 高 精 度 fp が 必 要 な 数 値 解 析 用 途 は unworklet scope 外 と し て doc 明 示。

authoritative wording: `01-dsl.md` §2 + `00-foundations.md` §5.1 (realtime-safety invariants と 整 合)。

**Rationale:**

- *audio dynamic range で 不 可 聴*: polynomial approximation の 最 大 誤 差 = 約 1e-4、 24-bit audio dynamic range = 約 1e-7 = noise floor 以 下 = 不 可 聴。 audio DSP 用 途 で 唯 一 必 要 な 精 度 を 満 た す。
- *realtime safety*: WASM 関 数 を 直 接 emit = audio thread 上 の 全 計 算 が WASM 内 部 完 結、 FFI / heap alloc / GC / 例 外 な し で realtime-safety invariants と 整 合。
- *並 列 variant 出 し は scope 膨 張*: v1.0.0 で `/precise` / `/table` を 並 列 で 出 す と user に variant 選 択 mental model 強 制、 同 識 別 子 で 別 backend = mental ノ イ ズ、 v1.x.0 で 必 要 性 が 出 れ ば additive 追 加 が 健 全。

**Rejected:**

- *libm wrapper を v1.0.0 default*: WASM 内 bundle libm = binary size 増 + audio dynamic range で 既 不 可 聴 = 不 要 cost。
- *user 選 択 variant flag* (= `defineProcessor({..., mathPrecision: 'fast' | 'precise'})`): variant 選 択 を user に 押 し 付 け = 「ど ち ら を 選 ぶ べ き か」 mental cost、 全 audio DSP で polynomial が 適 切 = default 1 variant で 完 結 が clean。
- *math primitive 全 落 と し で unworklet 範 囲 外*: user が `Math.sin` を JS で 書 い て build error = 仕 様 ホ ー ル、 audio DSP の 基 本 primitive (= `sin` / `cos` / `tan` 等) を unworklet primitive と し て 出 す の が 妥 当。

---

## Q18 — Render quantum handling

**Status:** resolved.

**Decision:** WASM emission で render quantum size 128 を **fully bake** す る (= `forSample` loop bound / audio I/O buffer offset / SIMD lane mapping を 全 て コ ン パ イ ル 時 確 定、 runtime block size 参 照 不 在 で 最 適 化 を 最 大 化)。 worklet `process(inputs, outputs)` の 開 始 時 に `outputs[0][0].length === 128` を runtime check し、 違 反 時 は error + 停 止 (= silent 不 動 作 を 避 け る)。 user code は 128 を 直 接 リ テ ラ ル で 書 か ず、 `@unworklet/core` の top-level constant `SAMPLES_PER_BLOCK` を 経 由 (Q35)。

将 来 ブ ラ ウ ザ 仕 様 変 動 (= render quantum size の 可 変 化 や 別 値 採 用) へ の adaptive emission は v1.x.0 で additive 追 加 検 討、 v1.0.0 で の 投 機 的 対 応 ナ シ。

authoritative wording: `04-worklet-runtime.md` §3 + `01-dsl.md` §1.7 (`SAMPLES_PER_BLOCK` export)。

**Rationale:**

- *コ ン パ イ ル 時 確 定 で 最 適 化 最 大 化*: 128 を 定 数 と し て WASM emission に baked-in す る と loop bound が 静 的 = WASM コ ン パ イ ラ が loop unrolling / SIMD vectorization / dead code elimination を 全 適 用 可。 runtime block size 参 照 = branch + indirection で 最 適 化 阻 害。
- *runtime check で silent 不 動 作 防 止*: 「128 と 異 な る 値 で 入 力 さ れ た 時 silent に 結 果 が 壊 れ る」 = realtime audio で の 最 悪 footgun、 1 度 だ け の 軽 い check で 防 止。
- *Q35 `SAMPLES_PER_BLOCK` 経 由 で user 露 出*: コ ー ド 内 で 直 接 「128」 と 書 か ず constant 経 由 = ブ ラ ウザ 仕 様 変 動 時 に は constant 1 箇 所 更 新 + 全 user code が 追 従、 v1.x.0 adaptive emission 移 行 path を 確 保。
- *adaptive emission の 投 機 deferral*: render quantum 128 は AudioWorklet 仕 様 で 公 式 (= 標 準 化 済 み)、 投 機 的 multi-size support は v1.0.0 scope balloon。

**Rejected:**

- *runtime variable block size (= 各 quantum で `outputs[0][0].length` を 読 ん で loop bound 動 的 決 定)*: per-block branch + 最 適 化 阻 害 + コ ン パ イ ル 時 不 変 vector lane mapping 不 可 = realtime audio で 致 命 的 性 能 劣 化。
- *runtime check な し で silent fallback (= 128 以 外 で も 部 分 動 作)*: 「silent に 結 果 が 壊 れ る」 が 最 悪 mode、 explicit error で 早 期 検 出 が clean。
- *adaptive emission を v1.0.0 ship*: 仕 様 で 128 fixed = 投 機 的 多 size support は scope 膨 張、 必 要 性 が 出 れ ば v1.x.0 で additive。

---

## Q19 — Channel-count specialization

**Status:** resolved.

**Decision:** `audioInput({ channels: C, name })` / `audioOutput({ channels: C, name })` の `channels` declare 値 を WASM emission 時 に **焼 き 込 む** (= mono / stereo / N-channel 別 code path、 sample ご と の channel 判 定 分 岐 不 在、 SIMD lane mapping コ ン パ イ ル 時 確 定)。 帰 結 と し て main 側 で `createNode` を 呼 ぶ 時 に AudioWorkletNode option (= `numberOfInputs` / `numberOfOutputs` / `outputChannelCount`) で I/O channel layout を **上 書 き 不 可** (= 仕 様 ホ ー ル #62 同 時 解 決)。

同 一 processor で の 動 的 channel 切 替 が 必 要 な ら 別 `defineProcessor` を 出 し て consumer 側 で 切 り 替 え る (= channel ご と に 別 processor instance + audio graph re-wire)。

authoritative wording: `04-worklet-runtime.md` §4 + `05-client.md` §1。

**Rationale:**

- *コ ン パ イ ル 時 確 定 で 最 適 化 最 大 化*: channel count を WASM emission baked-in = SIMD lane mapping が 静 的 (= stereo で f32x4 を `[L0, R0, L1, R1]` で interleave / mono で linear pack 等)、 per-sample channel branch 不 在 で 最 適 化 最 大 化。
- *main 側 上 書 き 不 可 で 仕 様 ホ ー ル 撤 廃*: AudioWorkletNode option (= `outputChannelCount`) で channel layout を 上 書 き で き る と WASM 内 ハ ー ド コ ー ド と 矛 盾 = silent corruption、 上 書 き 拒 否 で 仕 様 ホ ー ル を 撤 廃。
- *動 的 切 替 は 別 processor*: 同 一 processor で channel 数 を runtime で 変 え る use case (= mono ↔ stereo 切 り 替 え) は consumer level の audio graph re-wire で 表 現 = framework 内 dynamic dispatch 不 要 = declarative 原 則 と 整 合。

**Rejected:**

- *runtime channel-count dispatch (= 同 processor で sample ご と に channel 数 判 定)*: per-sample branch + SIMD lane mapping 不 確 定 = 最 適 化 阻 害、 declarative 原 則 違 反 (= user が 書 い た channel 数 と WASM 実 行 内 容 が 一 致 し な い)。
- *main 側 で `outputChannelCount` 上 書 き 許 可*: WASM 内 ハ ー ド コ ー ド と 矛 盾 = silent corruption リ ス ク、 明 示 拒 否 で 防 止。
- *channel 数 declare ナ シ で auto-infer*: graph capture 時 に audio I/O 接 続 情 報 が な い (= AudioContext 接 続 は main thread 側 runtime 操 作)、 declare 必 須 で 明 示。

---

## Q20 — Pre-warm correctness

**Status:** resolved.

**Decision:** v1.0.0 で framework 側 の pre-warm 機 構 を 提 供 し な い。 WASM は ブ ラ ウザ で AOT compile な の で JIT spike が 発 生 せ ず、 branch predictor / instruction cache / TLB 等 hardware-level の warmup は runtime 数 quantum 内 に 自 動 で 落 ち 着 き audio 出 力 と し て 不 可 聴。 framework が user code に 暗 黙 で silent block を 走 ら せ る の は declarative 原 則 違 反 寄 り = magic 排 除。

v1.x.0 で 必 要 性 が 出 れ ば opt-in option (= `createNode(..., { preWarm: { ...spec } })`) を additive 追 加 検 討。

authoritative wording: `04-worklet-runtime.md` §5。

**Rationale:**

- *WASM AOT compile で JIT spike 不 在*: ブ ラ ウザ の WASM 実 装 は AOT compile (= module load 時 に native code 生 成)、 JIT warmup 期 待 値 ナ シ。 v8 / SpiderMonkey 等 で 動 的 inline 化 等 二 次 最 適 化 は 存 在 す る が 最 初 の 数 quantum で 落 ち 着 く。
- *hardware warmup は 不 可 聴*: branch predictor / instruction cache / TLB 等 の 暖 機 = 最 初 の render quantum で μs オ ー ダ の 余 計 な CPU cycle が 発 生 す る が、 audio output level で は 完 全 に 不 可 聴。 explicit pre-warm 機 構 不 要。
- *declarative 原 則 と silent block 衝 突*: framework が 暗 黙 で silent block を 走 ら せ る = user の declared graph と WASM 実 行 内 容 が 一 致 し な い (= framework magic anti-pattern と 衝 突)。

**Rejected:**

- *v1.0.0 で 自 動 pre-warm を default*: silent block を user に 隠 し て 入 れ る = declarative 原 則 違 反、 不 可 聴 で あ る hardware warmup を framework 側 で 対 処 す る justification 不 在。
- *opt-in option を v1.0.0 ship*: 必 要 性 が 確 認 さ れ た user case を 待 た ず 投 機 で 入 れ る = scope 膨 張、 v1.x.0 additive で 十 分。

---

## Q21 — Denormal handling

**Status:** resolved.

**Decision:** `state.f32` / `state.f64` の `.store(v)` で コ ン パ イ ル 時 に subnormal ガ ー ド (= `|v| < 1e-30` な ら 0 に 落 と す) を 自 動 insertion、 audio thread の CPU spike を 防 止。 IIR feedback path 等 で fp 値 が subnormal 領 域 に 入 る と CPU が flush-to-zero モ ー ド 外 で 数 十 〜 数 百 倍 の cycle 消 費 = realtime audio で 致 命 的、 こ れ を 撤 廃。

v1.0.0 で opt-out 機 能 ナ シ (= audio DSP で subnormal 保 持 use case が 稀)、 必 要 性 が 出 れ ば v1.x.0 で opt-out option を additive 追 加 検 討。

authoritative wording: `04-worklet-runtime.md` §6。

**Rationale:**

- *IIR feedback path の CPU spike footgun 撤 廃*: BiQuad / SVF / 1-pole etc. の feedback delay z^-1 が 入 力 ゼ ロ ま た は 静 止 で subnormal に 漸 近 = CPU が flush-to-zero モ ー ド 外 で 大 量 cycle 消 費 = audio xrun / glitch リ ス ク。 framework 側 で 自 動 ガ ー ド で 撤 廃 = silent ボ ー ナ ス。
- *audio dynamic range で 不 可 聴*: 1e-30 等 の 極 小 fp 値 = 24-bit audio dynamic range の noise floor 遥 か 以 下 = 0 と し て 扱 っ て も 音 の 意 味 は 変 わ ら な い。
- *audio DSP 業 界 慣 行 と 整 合*: JUCE 等 で 標 準 FTZ (= flush-to-zero) を 既 default、 余 計 な mental model 学 習 不 要。
- *declarative 原 則 と の 微 妙 な 衝 突 を footgun 撤 廃 で 正 当 化*: framework が user 値 を 暗 黙 で 変 え る = declarative 原 則 か ら の 例 外 だ が、 不 可 聴 + 業 界 慣 行 + footgun 防 止 で 正 当 化、 例 外 を docs 明 示。

**Rejected:**

- *opt-out 機 能 を v1.0.0 ship*: subnormal 保 持 を 必 要 と す る audio DSP use case が 確 認 さ れ て お ら ず、 投 機 surface 膨 張、 v1.x.0 で 必 要 性 が 出 れ ば additive。
- *subnormal ガ ー ド を 入 れ な い (= declarative 純 度 維 持)*: IIR feedback path の CPU spike footgun が 高 頻 度 で audio xrun を 引 き 起 こ す = realtime audio framework と し て 致 命 的、 declarative 純 度 を 守 っ て user に footgun を 押 し 付 け る path は 採 ら な い。
- *ガ ー ド 閾 値 を user 設 定 可*: 1e-30 は IEEE 754 fp の subnormal 範 囲 (= 2^-126 〜 2^-149) を 含 む 単 純 boundary、 user 調 整 余 地 不 要 で 1 値 fix。

---

## Q29 — Variable-rate iteration

**Status:** resolved.

**Decision:** v1.0.0 で sample-loop primitive は **`forSample(callback)` + `forSample.byN(stride, callback)` の 2 形 だ け**。 他 の 形 (= `forSampleRange(start, end, callback)` 等 の 部 分 範 囲 iteration、 `forSamplesUntil(cond, callback)` 等 の runtime early-exit、 runtime variable stride) は v1.0.0 surface に 入 れ な い。

- *v1.x.0 additive 候 補*: `forSampleRange(start, end, callback)` (= 部 分 範 囲 iteration、 build-time bounded、 表 現 力 は 既 forSample + build-time `if` で カ バ ー 済 み だ が 効 率 化 用 途 で 検 討)
- *永 久 排 除*: `forSamplesUntil(cond, callback)` (= runtime early-exit) + runtime variable stride (= realtime safety 違 反 / declarative 原 則 違 反)

authoritative wording: `01-dsl.md` §10.5。

**Rationale:**

- *realtime safety invariants と 整 合*: realtime audio thread で bounded loop が hard rule (= `00-foundations.md` §5.1 invariant #2)、 runtime early-exit / variable stride は bounded loop を 破 る = 静 的 解 析 で 拒 否 す べ き、 surface に も 出 さ な い。
- *forSample + build-time `if` で 表 現 力 カ バ ー*: 部 分 範 囲 iteration は `forSample((i) => { if (lt(i, threshold)) { ... } })` で 表 現 可、 真 の 効 率 化 用 途 (= 不 要 sample で の 計 算 全 skip) が 確 認 さ れ た ら v1.x.0 で `forSampleRange` additive。
- *v1.0.0 surface 最 小 化*: primitive を 多 数 出 す と user に 「ど れ を 使 う べ き か」 mental cost、 forSample + forSample.byN だ け で 90%+ use case を カ バ ー = 初 期 surface 最 小 化 が clean。

**Rejected:**

- *`forSamplesUntil(cond, callback)` を v1.0.0 ship (= runtime early-exit)*: realtime safety bounded loop invariant 違 反、 worst-case CPU 時 間 が 静 的 に 決 ま ら な い = realtime audio framework と し て 致 命 的。
- *runtime variable stride (= `forSample.byN(node)`、 stride を `Node<'i32'>` で 渡 す)*: stride が runtime に な る と SIMD lane mapping コ ン パ イ ル 時 確 定 不 可 = 最 適 化 阻 害、 declarative 原 則 (= 「user が 書 い た 構 造 が そ の ま ま WASM」) も 破 れ る。
- *`forSampleRange` を v1.0.0 ship*: 既 forSample + build-time `if` で 表 現 力 カ バ ー、 真 の 効 率 化 use case が 確 認 さ れ た ら v1.x.0 で additive、 v1.0.0 で の 投 機 surface 膨 張 ナ シ。

---

## Q30 — Memory budget policy

**Status:** resolved.

**Decision:** processor 内 の 全 declaration (= `state` / `buffer` / `message<T>`・`event<T>` payload content / MIDI ringbuffer) を build-time に **自 動 sum** し て WASM linear memory を そ の サ イ ズ で alloc す る。 user 側 で の explicit `memoryLimit` option ナ シ で v1.0.0 出 し、 必 要 性 が 出 れ ば v1.x.0 で additive 追 加 検 討。

- **64 MB 越 え** で build-time **warning** (= ロ ー エ ン ド device で の load 遅 延 配 慮、 ship を 止 め な い)
- **WASM 上 限 (= 4 GB)** 越 え で build-time **error** (= 物 理 的 に WASM module 化 不 能)
- **audio thread で の `memory.grow`** を 永 久 排 除 (= realtime safety bounded-time invariant 違 反)

authoritative wording: `03-compiler.md` §2.4 + `03-compiler.md` §4。

**Rationale:**

- *declarative auto-sum で user 認 知 負 担 削 減*: declaration 群 を build-time に 集 計 す る だ け = user が memory size を 別 path で 指 定 す る 必 要 ナ シ、 declaration 自 体 が 唯 一 の memory 確 保 source = 1 surface で 完 結。
- *audio thread `memory.grow` 永 久 排 除*: `memory.grow` は OS から の 新 page alloc を 含 む = bounded-time invariant 違 反、 realtime audio で 致 命 的、 surface に も 出 さ な い。
- *build-time warning + error 閾 値 で 健 全 化*: 64 MB は ロ ー エ ン ド mobile device で の 体 感 load 遅 延 閾 値、 4 GB は WASM linear memory 仕 様 上 限。 warning は ship を 止 め ず 認 知 強 化、 error は 物 理 不 能 を 早 期 検 出。

**Rejected:**

- *explicit `memoryLimit` option を v1.0.0 ship*: declaration 自 動 sum で 必 要 性 不 在、 user に 重 複 surface 押 し 付 け = mental ノ イ ズ、 v1.x.0 で 必 要 性 が 出 れ ば additive。
- *runtime `memory.grow` を audio thread で 許 可*: bounded-time invariant 違 反、 realtime audio で 致 命 的、 永 久 排 除。
- *budget 違 反 を 全 て build-time error*: 64 MB 越 え を error に す る と 真 の 必 要 use case (= 大 IR convolution / 大 wavetable bank) が ship 不 能、 warning + 上 限 error の 2 段 で 健 全 化。

