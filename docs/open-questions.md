# Open questions — v1.0.0 spec

未 決 着 の 設 計 question を 集 約 す る single source of truth。 設 計 が ratify さ れ た ら `decisions-log.md` に 移 し (summary table + detail entry、 同 commit)、 こ の file か ら 削 る。

## 運 用 ル ー ル

- question が 浮 上 し た 時 点 で こ の file に 追 加 (= grill 途 中 で も)。 揮 発 性 を 持 た せ な い。
- 各 entry: **何 が 未 決 / どの doc が 触 れ る / 選 択 肢 / こ の 層 に 入 れ た 理 由 / 関 連 pillar** を 揃 え る。
- 層 順 は ratify ご と に 再 評 価。 audit 由 来 の tier や issue 番 号 を そ の ま ま 流 す こ と 禁 止 = 余 湖 さ ん の attention は 有 限。
- TaskList (claude-code 側 progress 管 理) は こ の file に 従 う。 GitHub issues 化 は v1.0.0 spec freeze 後 (L4-f) に 一 括。

## 4 層 filter

unworklet の pillar を 基 準 に 設 計 question を 4 層 に 分 け る。

| Pillar | 略 称 |
|---|---|
| (P1) declarative — user 書 い た 構 造 が そ の ま ま WASM | declarative |
| (P2) TypeScript-first — branded `Node<T>`、 literal lift | TS-first |
| (P3) realtime-safe by construction | RT-safe |
| (P4) runtime-agnostic — standards Web Audio の み | standards |
| (P5) minimal DSL foundation — primitives の み、 toolbox で は な い | minimal |
| (P6) JUCE / AudioWorklet mental model 保 持 — top-to-bottom、 forSample は loop primitive | JUCE-MM |

層 定 義:

- **Layer 1 — lifecycle / API surface**: 後 で 直 す = breaking change / mental model 破 壊。 pillar 直 撃。 最 優 先。
- **Layer 2 — DSL ergonomics**: 命 名 / API shape。 一 度 ship し た ら 変 え に く い が mental model 自 体 は 揺 ら が な い。
- **Layer 3 — type system / compile-time**: 追 加 surface。 entry を 増 や す 方 向 で 後 か ら additive に 入 れ ら れ る。
- **Layer 4 — 局 所 (polish / hygiene / process)**: 仕 様 freeze の 前 に 一 括 で 片 付 け る。 docs 整 備、 bookkeeping、 「ど う で も い い」 値 決 め。

---

## Layer 1 — lifecycle / API surface

### L1-a. 「phase」 terminology の 内 部 矛 盾

**何 が 未 決** — Q51 で 「`forSample` は **loop primitive で あ っ て phase で は な い**、 framework は process body を reorder/constrain し な い」 と ratify し た。 と こ ろ が docs の 中 に は 「`Per-block phase` / `Per-sample phase` = the two execution phases of a `process` body」 と い う 構 造 名 詞 と し て の 用 法 が 残 っ て い る (`00-foundations.md` L72-77、 `01-dsl.md` L27-32 ほ か)。 同 じ doc 内 で 「phase じ ゃ な い」 と 「two phases」 が 同 居 し て て、 読 者 が pillar P6 (JUCE-MM) を 内 在 化 で き な い。

**な ぜ 重 い** — pillar P6 に 直 結。 user が 最 初 に §3 を 読 ん だ 時 に 「framework は 2 つ の phase で 処 理 を 仕 切 っ て い る」 と 誤 認 す る と、 そ こ か ら 全 chapter の 読 み 方 が ズ レ る。

**ど の doc が 触 れ る** — `00-foundations.md` §3 vocabulary (L72 subsection、 L107 param 説 明、 L70 sample-offset、 L78 prose)、 `01-dsl.md` §1 (L27-32 prose、 L37/L53 example comment、 L161-162 phase split、 L326 state phase prose、 L399/L404 param phase prose、 L583 subgraph phase prose、 L608 L1 phase、 L840 method context、 L902 §6 "The `process` phase" 見 出 し、 L1273-1301 §10 `forSample` の "per-block phase" 言 及)、 `03-compiler.md` §2.2 "Phase walk" 見 出 し + §3/§4 section 見 出 し ("Static analysis **phase**" 等 = こ ち ら は compiler の phase で 別 意)、 `12-canonical-examples.md` comment 群。

**選 択 肢:**

- **(A) Retire 「phase」 を 構 造 名 詞 と し て 撤 廃。** "top-level statements" / "`forSample`-bound statements" に 置 換。 「per-block phase」 は 「process body の top level」 等 に 言 い 換 え。 §3 の `Per-block phase / per-sample phase` subsection ご と 消 す。 compiler phase (graph capture / static analysis / WASM emission) は 別 意 な の で 残 す が、 docs に 「runtime に "phase" は な い、 こ こ で の phase は compile-time pipeline」 と 注 釈。
- **(B) Keep but redefine.** §3 vocabulary に 「`phase` は こ の docs 上 の **lexical-position shorthand** で あ っ て framework-enforced segmentation で は な い」 と 一 度 だ け 明 文 化。 既 存 用 法 は そ の ま ま。
- **(C) Author 側 retire、 compiler 側 残 す。** runtime side ("per-block phase" / "per-sample phase") は (A) と 同 じ く 撤 廃、 compiler side ("graph capture phase" 等) は 残 す。 word の 2 義 性 を disambiguate。

**Pillar 関 連** — P6 (JUCE-MM) 主 軸、 P1 (declarative) も — 「phase」 が structural noun と し て 残 る と 「framework が phase で 区 切 っ て い る」 印 象 = declarative 哲 学 に 抵 触。

---

### L1-b. Handler body で sample-position primitive を 受 け 入 れ る か (Q51 followup)

**何 が 未 決** — Q51 で `param.at(0)` / `audioIn.at(c, 0)` / `audioOut.set(c, 0, v)` は 「process body の 任 意 位 置 で JS-literal sample-offset を 受 け 入 れ る」 と 決 め た。 が `01-dsl.md` L498-500 (`messageDecl.onReceive` の body 規 則) と `11-midi.md` の 同 等 箇 所 は 「handler 内 で は audio I/O / param 不 可、 `i` not in scope」 と 書 い た ま ま で、 Q51 と 衝 突 し て い る。 handler は process body の 中 で registr さ れ る が ranned 場 所 は 「render quantum の 頭 で 全 handler drain → 残 り の body」 (Q38-b) と 別 segment。 こ こ で sample-position primitive を 認 め る か。

**な ぜ 重 い** — pillar P6 + P1 直 撃。 handler 内 で `param.at(0)` 禁 止 だ と user は 「あ 、 framework が body 位 置 で 制 限 か け て る」 と 誤 認、 mental model に 例 外 が 入 る。 一 方、 audio I/O に sample-offset 取 ら せ る な ら 「handler の atSample (Q4 で MIDI event payload に 載 っ て る) を ど う 解 釈 す る か」 が 派 生 question に な る。 type 上 は handler argument の `atSample: Node<'i32'>` を `audioOut.set(c, atSample, v)` の 第 2 引 数 に 渡 せ る べ き か (= sample-accurate な MIDI → audio 即 時 出 力)。 こ れ を OK に す る と 「handler は process の 頭 で drain」 と い う tim ing 契 約 と 「atSample で 後 ろ の sample を 直 接 書 け る」 が 同 居 す る。

**ど の doc が 触 れ る** — `01-dsl.md` §4.2 (L498-500 message handler 制 約 文)、 §3.3 (param.at の prose)、 `02-messaging.md` §1 (handler 仕 様)、 `11-midi.md` §3 (`onEvent` handler body 制 約)、 `00-foundations.md` §3 sample-offset entry、 `03-compiler.md` §2.4 (関 連 static-analysis 規 則 が 増 え る 可 能 性)。

**選 択 肢:**

- **(a) JS literal だ け 受 け 入 れ。** `param.at(0)` / `audioIn.at(c, 0)` / `audioOut.set(c, 0, v)` が handler 内 で 可 能。 handler argument の `atSample: Node<'i32'>` を sample-offset に 渡 す の は 禁 止 (= `Node<'i32'>` 経 路 は forSample 内 限 定 を 維 持)。 Q51 と 整 合、 docs L498 だ け 緩 め る 形。
- **(b) `Node<'i32'>` も 受 け 入 れ。** handler argument の `atSample` を `audioOut.set(c, atSample, v)` に 渡 し て sample-accurate な per-event 出 力 を 認 め る。 MIDI → audio pulse / click 生 成 が handler 内 1 行 で 書 け る が、 「handler は block 頭 で drain」 timing 契 約 と の 整 合 が 必 要 (= write は block 内 future sample へ の 予 約 と し て 解 釈)。
- **(c) Both. (a) + (b) 両 立。**
- **(d) 一 切 禁 止。** 既 存 の handler body 制 限 を そ の ま ま 維 持、 Q51 を 「process body top-level に だ け 適 用、 handler body は 別 segment」 と 明 文 化。 mental-model 例 外 を 1 個 残 す。

**Pillar 関 連** — P6 (JUCE-MM)、 P1 (declarative)、 P2 (TS-first — `Node<'i32'> | number` arm を handler context で 切 る か 維 持 す る か)。

---

## Layer 2 — DSL ergonomics

### L2-a. `loadVec` / `everyNSamples` 命 名 見 直 し (TaskList #65)

**何 が 未 決** — SIMD bulk read primitive `buf.loadVec(offset)` / sub-rate primitive `everyNSamples(N, callback)` は 早 期 draft で 付 け た 名 前 で、 IDE autocomplete / 初 読 体 験 と し て の affordance を 評 価 し 直 し て な い。 例 え ば `loadVec` は 「vec を load」 か 「vec の load」 か 曖 昧、 `everyNSamples` は long name で 関 数 名 と し て 重 い。

**な ぜ Layer 2** — public API name = 一 度 ship す る と breaking change。 v1.0.0 freeze 前 に 決 着 が 必 要 だ が、 mental model や type 表 面 自 体 は 揺 れ な い の で Layer 1 で は な い。

**ど の doc が 触 れ る** — `01-dsl.md` §3.2 (`Buffer<T>` 型 定 義 L364-367)、 §7.2 (SIMD 表 面)、 §9 (`everyNSamples` 仕 様 L1172-1267)、 §10 (forSample 仕 様 L1287-1290)、 `12-canonical-examples.md` SIMD 例。

**Pillar 関 連** — P2 (TS-first affordance)。

---

### L2-b. `param.at(0)` framing refine

**何 が 未 決** — 現 docs は `param.at(0)` を 「block-start value (k-rate semantics)」 と framing し て い る (`01-dsl.md` L410、 `00-foundations.md` L107)。 Q51 + Q36-a を 踏 ま え る と 「`at(i)` は sample-offset `i` の 値、 `0` は block の 先 頭 sample」 と uniform に 説 明 す る ほ う が mental model 一 致 (= forSample 内 の `param.at(i)` と 全 く 同 じ 規 則 で 説 明 で き る)。

**な ぜ Layer 2** — type signature 変 化 ナ シ、 prose 修 正 の み。 user mental model を 鋭 く す る が、 cosmetic。 L1-a の retire 後 に や る ほ う が 一 貫 す る。

**ど の doc が 触 れ る** — `01-dsl.md` §3.3 (L398-410 param access prose)、 `00-foundations.md` §3 vocabulary (L107 param 説 明)。

**Pillar 関 連** — P6 (JUCE-MM uniform `at(i)`)、 P2 (TS-first 一 貫 signature)。

---

## Layer 3 — type system / compile-time

### L3-a. SIMD horizontal reduce (`sumLanes`) を v1.0.0 で 出 す か (TaskList #66)

**何 が 未 決** — `Node<'f32x4'>` の 4 lane 合 計 を 返 す primitive (`sumLanes(v): Node<'f32'>`) を v1.0.0 SIMD surface に 入 れ る か defer す る か。 WASM SIMD spec 的 に は `f32x4.extract_lane × 4 + add × 3` で 出 せ る (or `i32x4.bitselect` 経 由 の 短 縮 形 が browser に あ る)。 実 装 は trivial、 設 計 question は API surface 入 れ る か の 判 断 の み。

**な ぜ Layer 3** — 純 加 算 surface、 mental model 影 響 ナ シ、 v1.x.0 で additive に 入 れ ら れ る (`@unworklet/core/simd` 内 の 関 数 追 加)。 入 れ な い 判 断 を し て も 取 り 返 し は つ く。

**ど の doc が 触 れ る** — `01-dsl.md` §7.2 (v1.0.0 SIMD MVP の inventory L929-947)、 §7.3 (deferred to v1.x.0 list L975-983)、 `03-compiler.md` §4 WASM emission (lower 規 則)。

**Pillar 関 連** — P5 (minimal foundation = 入 れ な い 方 が pure か)。 ま た P2 (TS-first 表 面 affordance) も。

---

## Layer 4 — 局 所 (polish / hygiene / process)

### L4-a. README status line が stale

**何 が 未 決** — `docs/README.md` L43-60 status table:

- L49 `04-worklet-runtime.md` の status: `partial (§7 publish scheduling written; §1–§6 + §8 placeholder, Q18 / Q19 / Q20 / Q21 will resolve)` — 実 際 は §3 (Q18) / §4 (Q19) / §5 (Q20) / §6 (Q21) と §7 が written、 §1 / §2 / §8 が placeholder。 全 4 Q resolved。
- 他 status 行 も spec 進 行 と ズ レ が あ る か 順 次 check 必 要。

**Pillar 関 連** — な し (bookkeeping)。

---

### L4-b. Placeholder section 群 — 一 括 drain or freeze 前 一 括

各 doc に `<!-- placeholder -->` が 残 っ て い る。 ほ と ん ど は API surface で は な く 内 部 implementation spec:

| doc | placeholder section |
| --- | --- |
| `00-foundations.md` | §6 cross-cutting conventions |
| `03-compiler.md` | §1 pipeline overview / §3 静 的 解 析 / §4 WASM emission / §5 worklet JS codegen / §6 client TS codegen / §7 source maps / §8 pure-JS backend |
| `04-worklet-runtime.md` | §1 startup sequence / §2 per-block execution / §8 error handling |
| `05-client.md` | §3 param connection / §4 lifecycle states |
| `06-testing.md` | §2 matchers / §3 golden file / §4 property-based / §5 vitest |
| `07-vite-plugin.md` | §2 WASM build / §3 asset resolution / §5 source maps + §6.x TODO |
| `08-deployment.md` | §3 SAB degradation / §4 WASM binary distribution |
| `10-roadmap.md` | §1 v1.0.0 acceptance / §2 later milestones / §3.2 additive |
| `13-offline-render.md` | §2.x type signature / §3 backend |

**選 択 肢** — (i) v1.0.0 spec freeze 前 に 全 部 drain、 (ii) impl 開 始 時 に 各 doc owner が 順 次 書 く (こ れ ら は 実 装 詳 細 で 設 計 grill 不 要)、 (iii) freeze 後 impl 期 に 必 要 に な っ た 順 で 書 く。 推 奨 は (ii)。

**Pillar 関 連** — な し。

---

### L4-c. README dep graph 矢 印 方 向 修 正 (TaskList #72)

`docs/README.md` L17-32 の dependency graph で `@unworklet/test` / `@unworklet/offline` の 矢 印 方 向 が 過 去 audit で 不 整 合 と 指 摘 さ れ た。 1 shot 修 正。

---

### L4-d. `docs/recipes/` voice allocation pattern (TaskList #73)

Polyphony / voice stealing を recipe doc 化 す る か。 v1.0.0 出 す 必 要 性 は な い (canonical examples #12 で 4-voice mono synth は カ バ ー さ れ て い る)。 v1.x.0 補 完 docs と し て 後 で 検 討。

---

### L4-e. `docs/recipes/` overlap-add pattern (TaskList #74)

Short-time Fourier transform 由 来 の Overlap-Add の recipe。 L4-d と 同 様 v1.0.0 ship 必 須 で は な い。

---

### L4-f. Q14 — v1.0.0 acceptance criteria (TaskList #75)

「v1.0.0 ship 可 能」 と は 何 か の checklist を `10-roadmap.md` §1 に 書 く。 候 補:

- canonical examples 全 て compile + 期 待 output 出 す
- `@unworklet/offline` で reference processor を bit-exact render
- vite-plugin で `vp build` 通 る
- realtime-safety invariants 5 件 を 全 layer で 検 出 で き る
- 全 browser × `{cross-origin isolated, not isolated}` matrix で smoke pass

設 計 question で は な く process question な の で 仕 様 freeze の 直 前 に 一 括 決 定 で 十 分。

---

### L4-g. Issue-ize the finalized v1.0.0 spec (TaskList #76)

こ の `open-questions.md` の Layer 4 残 渣 が freeze 状 態 に な っ た 時 点 で、 全 ratify 済 み 設 計 + 残 task を GitHub issues に 1-to-1 化 し、 milestone `v1.0.0` を 付 け て impl agent 群 に 流 す。 そ れ ま で は こ の file が canonical。

---

### L4-h. `decisions-log.md` line-number cross-ref fragility

過 去 audit 指 摘。 detail entry が `01-dsl.md` を line number (`L460` 等) で 参 照 し て い て、 edit ご と に drift。 選 択 肢: (A) section-anchor (`#3-process-body`) 参 照 に 統 一、 (B) HTML anchor (`<!-- anchor: ... -->`) docs 側 に 仕 込 む、 (C) fragility 容 認 (= ratify 時 点 snapshot と 割 り 切 る)。 推 奨 は (A)、 機 械 的 置 換 で 終 わ る。

---

### L4-i. Trivial v1.0.0 settings (TaskList #77-81)

`09-repo-structure.md` に 入 る 設 定 値 — Q12 monorepo tool / Q13 initial package layout / Q15 license / Q16 npm scope / Q26 TS 最 低 version。 余 湖 さ ん 自 ら 「ど う で も い い」 marked。 v1.0.0 freeze 前 に 1 batch で 決 定、 設 計 grill 不 要。

---

## 新 規 question の 追 加 場 所

新 し く 浮 上 し た question は 末 尾 に 暫 定 layer を 付 け て 追 加 し、 次 の ratify 時 に 並 び 替 え る。
