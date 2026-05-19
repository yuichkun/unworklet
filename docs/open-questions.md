# Open questions — v1.0.0 spec

未 ratify 設 計 question を 集 約 す る single source of truth。 ratify さ れ た ら `decisions-log.md` に 移 し (summary table 行 + detail entry、 同 commit)、 こ の file か ら 削 る。

## 運 用 ル ー ル

- question が 浮 上 し た 時 点 で こ の file に 追 加 (= grill 途 中 で も)、 揮 発 性 を 持 た せ な い。
- 各 entry: **何 が 未 決 / どの doc が 触 れ る / 選 択 肢 / こ の 層 に 入 れ た 理 由 / 関 連 pillar** を 揃 え る。
- 層 順 は ratify ご と に 再 評 価。 audit 由 来 の tier や issue 番 号 を そ の ま ま 流 さ な い (= 余 湖 さ ん の attention は 有 限)。
- TaskList (claude-code 進 行 管 理 側) は こ の file に 従 う。 GitHub issue 化 は v1.0.0 spec freeze 後 (L4-g) に 一 括。

## 4 層 filter

unworklet の pillar:

| 略 称 | 内 容 |
|---|---|
| P1 declarative | user 書 い た 構 造 が そ の ま ま WASM |
| P2 TS-first | branded `Node<T>`、 literal lift |
| P3 RT-safe | by construction、 layered enforcement |
| P4 standards | Web Audio 標 準 の み、 host 形 式 ナ シ |
| P5 minimal | primitives の み、 toolbox で は な い |
| P6 JUCE-MM | top-to-bottom process body、 forSample は loop primitive |

層 定 義:

- **Layer 1 — 余 湖 さ ん の judgment 必 要、 mental model / 公 開 API surface 直 撃。** 後 で 直 す = breaking change。
- **Layer 2 — 余 湖 さ ん の judgment 必 要、 ergonomics 軽 め。** 1 度 ship し た ら 変 え に く い が mental model は 揺 れ な い。
- **Layer 3 — 余 湖 さ ん の judgment 必 要、 additive surface。** v1.x.0 で 後 か ら 入 れ ら れ る。
- **Layer 4 — mechanical bookkeeping、 余 湖 さ ん の judgment 不 要 / 軽 度。** 1 commit で 一 括 sweep 可。

**層 内 順 序 の 判 断 軸:**

1. **公 開 surface 確 定 度** — 公 開 import path / 公 開 type 定 義 不 在 を 先 に 確 定 (後 で 直 す = breaking)
2. **議 論 の 軽 さ** — 軽 い ratify を 先 に 片 付 け て attention を mental model judgment に 集 中
3. **依 存 関 係** — L1-c (公 開 type 確 定) が 終 わ ら な い と L1-b (handler arg type 解 釈) の type 表 現 が 不 定

---

## Layer 1 — judgment 必 要、 API surface / mental model

### L1-d. Package layout — doc heading vs Q23 ratify の 衝 突

**何 が 未 決** — Q23 ratify (`decisions-log.md` L35, L1957-) は v1.0.0 を **`@unworklet/core` + `@unworklet/vite-plugin` + `@unworklet/offline` + `@unworklet/test`** の **4 package 構 成** で 統 一 し た。 ところ が doc heading は:

- `01-dsl.md`: `# 01 — DSL (\`@unworklet/core\` + \`@unworklet/dsp\`)` — 別 package `@unworklet/dsp` を 名 乗 る
- `03-compiler.md`: `# 03 — Compiler (\`@unworklet/compiler\`)` — 独 立 package
- `04-worklet-runtime.md`: `# 04 — Worklet runtime (\`@unworklet/worklet\`)` — 独 立 package

一 方 canonical examples (12-canonical-examples.md) の import 行 は **全 部 `@unworklet/core`** で 統 一。 Q23 ratify と canonical の 実 体 が 一 致 し て て、 doc heading だ け 古 い。 audit B §3 拾 い。

**な ぜ こ の 位 置 (= L1 内 最 上 段)** — 公 開 import path 不 定 = **全 user code に 影 響**。 v1.0.0 ship 後 に 変 更 = 互 換 破 り 最 大。 議 論 自 体 は 軽 い (= Q23 反 映 + 数 件 の 派 生 question)、 先 に 確 定 す る べ き。

**派 生 question:**

- `@unworklet/compiler` を **公 開 package** と す る か (= user が 直 接 import す る surface か、 vite-plugin に hidden な 内 部 dep か)
- `@unworklet/worklet` runtime を `@unworklet/core` に 含 め る か 別 package に す る か
- `@unworklet/dsp` を 公 開 import path と し て 残 す か (例 `import { sin, cos } from '@unworklet/dsp'`) or `@unworklet/core` 1 つ に 統 合 す る か

**ど の doc が 触 れ る** — `01-dsl.md` heading、 `03-compiler.md` heading + §2 / §4 等 内 部 参 照、 `04-worklet-runtime.md` heading、 `07-vite-plugin.md` §2、 `09-repo-structure.md` §2 (placeholder の ま ま、 Q13 と セ ッ ト)、 `decisions-log.md` Q13 / Q23 entries。

**選 択 肢:**

- **(A) Q23 を strict に 適 用 し て 4 package で 統 一。** compiler / worklet runtime / dsp は 全 て `@unworklet/core` 内 部 module と み な し、 公 開 surface は `@unworklet/core` 1 つ + simd subpath (`@unworklet/core/simd`)。 doc heading 修 正、 03/04 doc 自 体 は 「`@unworklet/core` 内 の compiler section / worklet runtime section」 と framing。
- **(B) 5 package: core + compiler + worklet + vite-plugin + offline + test.** compiler と worklet runtime を 独 立 package 化。 こ れ は Q23 を override す る = re-ratify 必 要。
- **(C) 妥 協: core + vite-plugin + offline + test (= Q23 ratify) + 「compiler / worklet runtime / dsp は core 内 internal module、 doc は 整 理 上 別 file」 と 明 文 化。** doc heading か ら package 表 記 を 外 し、 「internal module of @unworklet/core」 と 注 釈。

**Pillar 関 連** — P5 (minimal) + 公 開 API surface design。

---

### L1-c. 公 開 type 定 義 の 大 量 不 在

**何 が 未 決** — docs 横 断 で 公 開 type と し て 約 束 さ れ て い る 識 別 子 の 正 式 declaration が 不 在。 `defineProcessor` / `createSubgraph` の signature 自 体 が 未 定 義 identifier に 依 存 し て い る。 audit A §4 + B §4 拾 い。

具 体 的 に 不 在 な type:

- `ProcessorContext` — `defineProcessor` body の `ctx` 型。 `ctx.sampleRate` 等 field が prose で 言 及 さ れ る が `type ProcessorContext = {...}` declaration ナ シ。
- `ProcessorBody` — `defineProcessor` body 返 り 値。 `{ process: () => void; ... }` shape が 暗 黙。
- `CompiledProcessor<C>` — `defineProcessor` 戻 り 値、 `createNode` 引 数。
- `State<T>` / `Param` / `EventDecl<T>` / `MessageDecl<T>` / `MidiInputHandle` / `MidiOutputHandle` — `01-dsl.md` §1.6.1 で 「`@unworklet/core` か ら export」 と 約 束 だ け、 body shape declaration ナ シ (`EventDecl<T>` は Q32 detail に 1 箇 所 declare あ り、 仕 様 本 体 に 無 し)。
- `SubgraphDecl` / `LambdaArgs` — `createSubgraph` signature の 引 数 型 placeholder。
- **`SubgraphInstance<S>`** — `01-dsl.md` §1.6.1 export 約 束、 §5.6 で 戻 り 値 型 と し て 一 度 も 参 照 ナ シ (= dangling)。 派 生 question: 「helper signature で `inst: SubgraphInstance<typeof onepole>` と 書 け る 必 要 が あ る か?」
- `ChannelIndex<C>` — comment narrative の み (`type X = ...` declaration ナ シ)。
- `TypedArrayFieldRef<T>` — Q36-b で proxy 名 確 定 だ が 仕 様 本 体 に shape declaration ナ シ。

**な ぜ こ の 位 置 (= L1 内 2 番 目)** — `.d.ts` emission の 「正 解」 を impl agent が 持 て な い。 公 開 API field 不 定 = 後 で 直 す と 互 換 破 り。 ただ し L1-d (公 開 import path) よ り は user 影 響 限 定 (= type rename な ら user は 1 import 行 + α、 import path 変 化 な ら 全 file)。 議 論 は 軽 い (= 既 spec か ら mechanical extract で 90%、 派 生 数 件)、 mental model judgment よ り 先 に 片 付 け る。

**ど の doc が 触 れ る** — `01-dsl.md` §1.6.1 (集 約 先 候 補)、 §3 / §4 / §5 / §8 各 declaration 仕 様、 `05-client.md` §2 (main 側 export)、 `decisions-log.md` Q32 / Q34 / Q36 / Q41 等。

**選 択 肢:**

- **(A) 1 batch で 既 spec か ら 機 械 的 に extract、 `01-dsl.md` §1.6.1 周 辺 に declaration block を 集 約。** ratify 内 容 を 変 え ず prose を 形 式 化。 派 生 判 断 は 「公 開 す る か 内 部 type に 留 め る か」 の 数 件 の み。
- **(B) impl 期 に 各 owner が `.d.ts` で 書 く、 spec docs に は 形 式 declaration 不 要。** spec は prose の ま ま、 公 開 type は impl 成 果 物 が 正 本。 但 し AGENTS.md HARD CONTRACT (canonical example integrity) と の 整 合 が 弱 ま る。
- **(C) Hybrid: 主 要 type (`State<T>` / `Param` / `EventDecl<T>` / `MessageDecl<T>` / `MidiInputHandle` / `MidiOutputHandle` / `Buffer<T>` / `Node<T>` / `SubgraphInstance<S>` / `CompiledProcessor<C>`) は spec docs に declaration block、 internal placeholder type (`SubgraphDecl` / `LambdaArgs` / `ProcessorBody`) は impl 任 せ。**

**Pillar 関 連** — P2 (TS-first) 直 撃。

---

### L1-b. Handler body で sample-position primitive を 受 け 入 れ る か (Q51 followup)

**何 が 未 決** — Q51 で `param.at(0)` / `audioIn.at(c, 0)` / `audioOut.set(c, 0, v)` を process body 任 意 位 置 で OK と 決 め た。 一 方 `01-dsl.md` L498-500 (`messageDecl.onReceive` body 規 則) と `11-midi.md` 同 等 箇 所 は 「handler 内 で audio I/O / param 一 切 不 可、 `i` not in scope」 と 書 い た ま ま、 Q51 と 衝 突。 audit B §2 も 「同 commit 内 で 並 存 = 最 大 の 構 造 的 矛 盾」 と 指 摘。

**な ぜ こ の 位 置 (= L1 内 3 番 目)** — pillar P6 + P1 直 撃 (mental model)。 公 開 API arm (`Node<'i32'> | number` を handler context で 切 る か 維 持 か) が 変 わ る = breaking。 ただ し 影 響 範 囲 は handler body の み (= user code の 1 部 分)、 L1-d / L1-c よ り は 局 所。 mental model judgment は 重 い の で attention 集 中 が 必 要。

**派 生 依 存** — L1-c (公 開 type 確 定) が 終 わ っ て な い と 「handler arg の `atSample` を `Node<'i32'>` で 受 け る or `number` plain で 受 け る」 の type 表 現 が 揺 れ る。 L1-c 後 に 議 論。

**ど の doc が 触 れ る** — `01-dsl.md` §4.2、 §3.3、 `02-messaging.md` §1、 `11-midi.md` §3、 `00-foundations.md` §3 sample-offset entry、 `03-compiler.md` §2.4。

**選 択 肢:**

- **(a) JS literal だ け 受 け 入 れ。** `param.at(0)` / `audioIn.at(c, 0)` / `audioOut.set(c, 0, v)` を handler 内 で 可 能 に、 handler arg の `atSample: Node<'i32'>` は forSample 限 定 を 維 持。 Q51 と 整 合、 L498 だ け 緩 め る。
- **(b) `Node<'i32'>` も 受 け 入 れ。** handler arg の `atSample` を `audioOut.set(c, atSample, v)` に 渡 し て sample-accurate per-event 出 力 可 能。 MIDI → audio pulse 1 行 で 書 け る が timing 契 約 と の 整 合 必 要。
- **(c) Both. (a) + (b) 両 立。**
- **(d) 一 切 禁 止。** 既 存 制 限 維 持、 Q51 を 「process body top-level に だ け 適 用、 handler body は 別 segment」 と 明 文 化。 mental-model 例 外 を 1 個 残 す。

**Pillar 関 連** — P6、 P1、 P2。

---

### L1-a. 「phase」 terminology の 内 部 矛 盾

**何 が 未 決** — Q51 で 「`forSample` は **loop primitive で あ っ て phase で は な い**、 framework は process body を reorder/constrain し な い」 と ratify し た。 と こ ろ が docs に 「`Per-block phase / per-sample phase` = the two execution phases of a `process` body」 が 構 造 名 詞 と し て 残 存 (`00-foundations.md` L72、 `01-dsl.md` L27 ほ か 10+ 箇 所)。 同 doc 内 で 「phase じ ゃ な い」 と 「two phases」 が 並 存 = pillar P6 (JUCE-MM) の mental model を user が 内 在 化 で き な い。

**な ぜ こ の 位 置 (= L1 内 最 下 段)** — pillar P6 (JUCE-MM) 全 体 を 揺 る が す mental model 矛 盾、 影 響 は **全 chapter の 読 み 方**。 ただ し docs prose の み が 変 化 す る = **公 開 API surface は 変 わ ら な い** = ship 後 で も 修 正 可 能 (= breaking で は な い、 docs 修 正 のみ)。 議 論 は 重 い (mental model judgment + 用 語 体 系 設 計)。 L1-d / L1-c で 軽 い 確 定 を 先 に 終 え て attention 集 中。

**ど の doc が 触 れ る** — `00-foundations.md` §3 vocabulary、 `01-dsl.md` §1 / §3 / §5 / §6 / §10、 `03-compiler.md` §2.2 + §3/§4 見 出 し (= compiler phase 別 意 で 残 す か)、 `12-canonical-examples.md` comment 群。

**選 択 肢:**

- **(A) Retire 「phase」 を 構 造 名 詞 と し て 撤 廃。** "top-level statements" / "`forSample`-bound statements" に 置 換。 §3 の `Per-block phase / per-sample phase` subsection ご と 削 除。 compiler phase は 別 意 と し て 残 し 注 釈。
- **(B) Keep but redefine.** §3 vocabulary に 「`phase` は 本 docs 上 の **lexical-position shorthand** で あ っ て framework-enforced segmentation で は な い」 と 一 度 だ け 明 文 化。 既 存 用 法 そ の ま ま。
- **(C) Author 側 retire、 compiler 側 残 す。** runtime 側 retire + compiler phase 残 し で 2 義 性 disambiguate。

**Pillar 関 連** — P6 主 軸、 P1 (declarative) も。

---

## Layer 2 — judgment 必 要、 ergonomics

### L2-c. `createNode({ restore })` 経 路 で migration 失 敗 を ど う surface す る か

**何 が 未 決** — `05-client.md` §1 の `CreateNodeOptions<C>.restore?: Uint8Array` は 「Schema mismatch routed through the processor's `migrations` chain」 と 書 く が、 戻 り 値 は `Promise<UnworkletNode<C>>` で `RestoreResult` を 含 ま な い。 `node.restore(blob)` method 経 由 は `RestoreResult` discriminated union を 返 す が、 `createNode({ restore })` で migration が throw し た 場 合 の レ ポ ー ト path が 仕 様 化 さ れ て い な い。 audit A §5 拾 い。

**な ぜ L2 内 最 上 段** — 公 開 API 戻 り 値 shape (= ship 後 に 変 え る と breaking)。 L2-a (命 名) よ り 重 い。 選 択 肢 自 体 は 3 案 で 軽 い ratify。

**選 択 肢:**

- **(A) `createNode({ restore })` の 戻 り 値 を `Promise<{ node: UnworkletNode<C>; restore: RestoreResult }>` に。** breaking ま で 行 か な い が API 形 変 化。
- **(B) `restore` 失 敗 時 は `onError` event で 通 知、 `createNode` 自 体 は 必 ず resolve。** 簡 潔 だ が consumer の 監 視 forced。
- **(C) `createNode({ restore })` 経 路 自 体 を 廃 止、 「`createNode → await restore(blob)`」 を canonical pattern と し て docs 化。** v1.0.0 surface 削 減。 既 存 canonical で `restore` 経 路 を 使 う 例 は ナ シ (`initial` の み)。

**ど の doc が 触 れ る** — `05-client.md` §1 / §2.6 / §6.5。

**Pillar 関 連** — P2。

---

### L2-a. `loadVec` / `everyNSamples` 命 名 見 直 し

**何 が 未 決** — SIMD bulk read primitive `buf.loadVec(offset)` / sub-rate primitive `everyNSamples(N, callback)` は 早 期 draft で 付 け た 名 前 で、 IDE autocomplete / 初 読 体 験 と し て の affordance を 評 価 し 直 し て な い。

**な ぜ L2 内 2 番 目** — 公 開 API 識 別 子 名 (= 一 度 ship し た ら breaking) だ が、 影 響 範 囲 は SIMD subset (= 全 user で は な い) と sub-rate (= 局 所)。 L2-c (戻 り 値 shape) よ り 軽 い。

**ど の doc が 触 れ る** — `01-dsl.md` §3.2 (`Buffer<T>` 型)、 §7.2、 §9 (`everyNSamples`)、 §10 (forSample)、 `12-canonical-examples.md` SIMD 例。

**Pillar 関 連** — P2。

---

### L2-d. L1 helper の nested `forSample` を 明 示 化 (旧 L3-b)

**何 が 未 決** — `01-dsl.md` §5.5.5 で L1 helper 内 `forSample(...)` 呼 び 出 し が 「rare; usually iteration is the caller's job」 と OK 寄 り、 §10.3 forSample body constraints で 「Allowed: ... calls to L1 helpers」 と 書 く。 こ の 2 つ を 組 み 合 わ せ る と **L1 helper が 内 部 で `forSample` を 呼 ぶ + 呼 び 出 し 側 も `forSample` 内** = 暗 黙 に nested `forSample` 成 立。 spec で 明 示 化 ナ シ。 audit B §2 拾 い。

**な ぜ L3 か ら L2 に 引 き 上 げ** — mental model 明 示 化 系。 公 開 API surface 追 加 で は な く 既 存 規 則 の 解 釈 を 1 行 docs で 確 定 さ せ る だ け だ が、 RT-safe 静 的 解 析 (= bounded loop check) の 範 囲 に 影 響、 mental model 一 致 性 で も 重 要。 L2 寄 り。

**選 択 肢:**

- **(A) 暗 黙 OK を 明 文 化。** §5.5.5 に 「helper の forSample は caller の forSample と nested で 動 く、 sample-offset は caller の `i` と は 独 立 」 と 明 記。
- **(B) Nested forSample を spec で 禁 止。** 「helper の forSample は caller が forSample 外 か ら 呼 ぶ 場 合 限 定」 と 規 則 化。 §10.3 「nested forSample (rare; typically used for tile iteration in 2D buffers)」 wording を 削 除。
- **(C) Tile iteration use case (= forSample 内 で nested forSample で 2D buffer 走 査) を 明 示 use case と し て 採 用、 例 を 1 個 canonical に 追 加。**

**Pillar 関 連** — P6、 P3 (RT-safe — nested は 静 的 解 析 で bounded 確 認 必 要)。

---

### L2-b. `param.at(0)` framing refine

**何 が 未 決** — 現 docs は `param.at(0)` を 「block-start value (k-rate semantics)」 と framing。 Q51 + Q36-a を 踏 ま え る と 「`at(i)` は sample-offset `i` の 値、 `0` は block 先 頭 sample」 と uniform 説 明 が mental model 一 致。

**な ぜ L2 内 最 下 段** — prose の み の cosmetic refine、 公 開 API surface 不 変。 L1-a (phase terminology retire) の 後 で 連 動 し て や る ほ う が 自 然 (= 「phase」 用 語 が docs か ら 消 え た 後 に `at(i)` uniform framing を 書 き 直 す)。

**ど の doc が 触 れ る** — `01-dsl.md` §3.3、 `00-foundations.md` §3。

**Pillar 関 連** — P6、 P2。

---

## Layer 3 — judgment 必 要、 additive surface

### L3-a. SIMD horizontal reduce (`sumLanes`) を v1.0.0 で 出 す か

**何 が 未 決** — `Node<'f32x4'>` の 4 lane 合 計 を 返 す primitive (`sumLanes(v): Node<'f32'>`) を v1.0.0 SIMD surface に 入 れ る か。 v1.x.0 で additive に 入 れ ら れ る。

**ど の doc が 触 れ る** — `01-dsl.md` §7.2 / §7.3、 `03-compiler.md` §4。

**Pillar 関 連** — P5 (minimal = 入 れ な い 方 が pure)、 P2。

---

## Layer 4 — mechanical bookkeeping (judgment 不 要 / 軽 度)

以 下 は 余 湖 さ ん の judgment を 求 め ず、 ratify 内 容 を 変 え ず に docs を 揃 え る sweep。 1 commit で 一 括 が 望 ま し い (= AGENTS.md HARD CONTRACT の canonical integrity rule を 同 時 に 守 る)。

**M-sweep 内 順 序** = impl 開 始 前 に 必 要 な 順:

1. **L4-M1 decisions-log integrity** — Q-reference の 正 本 整 備。 他 sweep の 引 用 元 が 揃 う。
2. **L4-M2 line-ref → section-anchor** — M1 完 了 後 sweep。
3. **L4-M3 README 整 合 性** — top-level navigation の 修 正。 impl agent が 最 初 に 読 む 入 口 を fix。
4. **L4-M4 docs prose 揃 え** — vocabulary / listing / context の 一 貫 性。
5. **L4-M5 canonical examples integrity** — AGENTS.md HARD CONTRACT。 ratify 内 容 を 揃 え た 後 に。
6. **L4-M6 / L4-M7 / L4-M8** — 残 hygiene。

### L4-M1. decisions-log integrity sweep

- **Q17 / Q18 / Q19 / Q20 / Q21 / Q29 / Q30 の 7 件 で detail entry 不 在** — summary cell に prose 詰 め 込 み + detail-entry shape (Status / Decision / Rationale / Rejected) ナ シ = 半 ratify 状 態。 summary cell prose を そ の ま ま 規 範 shape に 展 開 (新 規 grilling 不 要)。 audit C §1 + audit A §1 拾 い。
- **Q22 summary row stale** (`L34: "d open"` → `"d resolved (Rust-style template)"`) + **Q22-d 物 理 位 置 修 正** (`L852-892` は Q31 detail 末 尾 に nested、 独 立 `## Q22-d` heading に 昇 格 or Q22 section 末 尾 移 動)。 audit C §3。
- **L7 Status paragraph stale** (`"Q1–Q10, Q22, Q27 resolved"` → 実 際 35+ Qs resolved に 更 新)。 audit C §3。
- **Q22-c detail body** (`L569` 周 辺) で 「output coverage / duplicate-write を Layer 2 error」 と 書 く が Q37 で retire 済 み = body を Q37 反 映 で 書 き 直 す。 audit A §2 + B §5 拾 い。
- **Q5-e detail body** で `migrations([...])` function call 形 表 記 → options bag の `migrations: [...]` field に。 audit A §3 拾 い。
- **Q31-d body** (`L811`) の `steps[s]` bracket indexing → `steps.at(s)` (Q36-b 確 定 後 の prose 更 新 漏 れ)。 audit B §4 拾 い。
- **Q27-c detail** + **`02-messaging.md` §1.1 L29** で 「next render quantum」 表 記 → 「current (worklet 視 点)」 (Q31-a / Q38-a Side effect 完 遂)。 audit A §3 + B §1 拾 い。
- **Q47 「廃 止 さ れ た publish phase」** trace を `04-worklet-runtime.md:83` / `01-dsl.md:906` で 整 理 (`There is no separate publish lambda` wording は 維 持 OK、 ただし 何 が retire さ れ た か 文 脈 補 強)。 audit B §5 拾 い。

### L4-M2. line-number cross-ref 一 律 sweep (旧 L4-h)

- decisions-log detail entry 内 の `01-dsl.md L460` 等 line-number 参 照 を **section-anchor** (例 `#3-process-body`) 参 照 に sed 置 換 で 統 一。 Q35 L1187、 Q48 L1855、 Q11 L1950、 Q23+Q24+Q25 L2012、 ほ か 体 系 的 に drift 確 認 済 み (audit C §5)。

### L4-M3. README 整 合 性 sweep

- **L49 `04-worklet-runtime.md` Status 行** stale (Q18-21 resolved 反 映 漏 れ、 §3-§6 written と 同 期)。 audit A §1 + B §6 拾 い。
- **L7 / L59 `decisions-log.md` Status 行** stale。 audit B §6 拾 い。
- **L51-58 各 doc Status 行** を 実 体 と 同 期 (06-testing、 07-vite-plugin、 08-deployment、 10-roadmap、 13-offline-render)。
- **L17-32 Dependency graph** に `06-testing.md → 13-offline-render.md` の 依 存 矢 印 を 追 加 (= 06 doc 内 で 「`@unworklet/test` depends on `@unworklet/offline`」 と 明 記 済 み)。 audit B §6 拾 い。 (旧 L4-c)

### L4-M4. docs prose 揃 え sweep

- **`sample-offset` / `sample-position` 表 記 統 一** — `00-foundations.md` §3 vocabulary が `Sample-offset (i)` を canonical 名 と し て い る の で 全 docs を `sample-offset` に。 audit B §1 拾 い。
- **`00-foundations.md` L106 buffer access methods listing** に `copyFrom` 追 加 (`01-dsl.md` §3.2 と 同 期)。 audit B §1 拾 い。
- **`03-compiler.md` §2.2 declaration scope listing** に `event<T>` / `message<T>` / `midiInput` / `midiOutput` / `createSubgraph` 追 加。 `defineSubgraph` 説 明 を 「module-level subgraph constructor」 に 修 正。 audit A §2 拾 い。
- **`01-dsl.md` §4.1 / §4.2 Options listing** に `payloadCapacity?: number` 追 加 (§4.3 prose と 同 期)。 audit A §2 拾 い。
- **`01-dsl.md` §6 prose** の emitIf context 列 挙 に 「per-block top level」 追 加 (L435 と 同 期)。 audit B §2 拾 い。
- **`01-dsl.md` §10.1 forSample.byN prose** の `audioOut.storeVec is not part of v1.0.0 SIMD MVP` wording と §2.1 Memory inventory の 「`audioOutput` に は 乗 ら な い」 wording を 統 一 (= 同 結 論 だ が 将 来 軸 含 み が 違 う、 一 方 に 寄 せ る)。 audit B §2 拾 い。
- **`04-worklet-runtime.md` L7 Status 行** を doc 実 体 と 同 期 (L4-M3 と セ ッ ト)。

### L4-M5. canonical examples integrity sweep

AGENTS.md HARD CONTRACT (canonical examples integrity rule) 観 点 で 拾 っ た 違 反。

- **Ex 5 L587 / Ex 8 L1052, L1088 の Q1 precision 違 反** — `velocity / 127` / `Math.LN2 / 12` 等 が JS native `/` operator を `Node<T>` operand に 適 用 = `div(f32(velocity), 127)` 等 に 修 正。 audit B §7 拾 い (mental model 破 壊 #2 と し て flag)。 = integrity anchor の 中 で core invariant が 壊 れ て い る、 mechanical fix で OK。
- **Ex 5 import 漏 れ** (`max`, `lt`, `mod`)、 **Ex 6 import 漏 れ** (`lt`) — compile し な い、 self-contained 違 反。 audit B §7 拾 い。
- **Ex 6 dead import** (`audioInput` 使 用 ナ シ)、 **Ex 7 dead param** (`irChoice` 参 照 ナ シ)、 **Ex 3 / Ex 7 dead import** (`vec4` 使 用 ナ シ)。 audit B §7 拾 い。
- **`loadPattern` vs `uploadPattern` 名 前 揺 れ** — canonical Ex 6 / 01-dsl §4.3 / decisions-log Q31-d / Q36-b で 別 名、 1 つ に 統 一。 audit B §4 拾 い。
- **Coverage section 事 実 修 正** (`L1152` `param.at(0)` 「not yet」 → 実 際 Ex 2/4/7/8 で 頻 出、 `L1154` 「scalar constructor not yet」 → Ex 5/8 で 頻 出 ・ cross-precision conversion の み 0、 `L1158` 「polling Ex 4 only」 → Ex 8 に も 存 在、 `L36` Coverage table の `storeVec` → canonical に 使 用 ナ シ で 削 除、 `L15` Coverage table で Ex 5 を `audioInput` user と し て 誤 分 類)。 audit A §6 + B §7 拾 い。
- **sysex coverage gap (`L1157`)** — Q49 ratify で v1.0.0 sysex emit 完 全 spec 化 し た が canonical example で exercise ナ シ。 1 sysex example 追 加 推 奨 (= AGENTS.md HARD CONTRACT 観 点 で 重 い、 ratify 時 acknowledge 済 み だ が 直 し て な い)。 audit A §6 拾 い。
- **Ex 3 L274 prose vs code 不 整 合** — comment が 「forSample.byN (SIMD bulk convolution)」 と 書 く が code は `forSample((i) => {...})` 普 通 形。 audit B §7 拾 い。
- **`13-offline-render.md` L32 `inputs: { in: ... }`** → `inputs: { main: ... }` (canonical の `name: 'main'` 統 一 慣 行 と 同 期)。 audit B §4 拾 い。

### L4-M6. detail entry の Open follow-up 集 約

各 detail entry 末 尾 に 散 在 す る Open follow-up bullet を 1 surface に 集 約 (= session resume で 見 え る surface へ)。 audit C §7 拾 い。

- Q22-d L878: stable error ID inventory の doc 化 → L4-M7 と 統 合 (= 1 docs entry 追 加)。
- Q23+Q24+Q25 L2016: 6 bullets (analysis JSON schema / vite plugin HMR payload / offline generic type / test matcher list / source map detail / COOP-COEP dev warning) → 各 doc の placeholder section 化 (= L4-M3 status table 更 新 ご と)。
- Q11 L1952: 2 bullets (COOP/COEP detect failure warning shape、 future-quirk adjudication doc) → docs polish 任 せ。
- Q50 L2081: 3 bullets (accumulation warning threshold、 oldNode `process()` signaling、 live-coding canonical recipe) → docs polish 任 せ。
- Q51 L2117: 2 bullets (per-block `audioIn.at(c, k)` non-zero literal range check、 per-block call canonical use case) → docs polish 任 せ。

### L4-M7. Stable error ID inventory を docs に

`03-compiler.md` §2.5 (L142) + Q22-d 末 尾 で 「The list of stable error IDs is maintained as a separate inventory」 と 書 い て あ る が docs 内 に inventory 不 在。 v1.0.0 で stable surface を 約 束 し て い る の で 1 docs section 追 加。 audit A §1 + §5 拾 い。

### L4-M8. Q28 番 号 gap 説 明

`decisions-log.md` index で Q1 → Q2 → ... → Q27 → Q29 と Q28 が 飛 ぶ。 historical artifact か intentional skip か 1 行 注 釈。 audit A §3 + C §4 拾 い。

---

### Layer 4 — 個 別 entry (sweep に 統 合 し な い、 freeze 関 連 順)

#### L4-a. Placeholder section 群 — impl 期 owner 任 せ と 明 文 化

各 doc に `<!-- placeholder -->` が 残 っ て い る。 内 部 implementation spec が ほ と ん ど で API surface で は な い。

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

**選 択 肢** — (i) v1.0.0 spec freeze 前 に 全 部 drain、 (ii) impl 開 始 時 に 各 doc owner が 順 次 書 く (推 奨)、 (iii) freeze 後 impl 期 に 必 要 に な っ た 順 で。

**な ぜ こ の 位 置** — 方 針 を 1 行 docs で 明 文 化 す る だ け、 freeze の 前 に 必 要 だ が judgment 軽 い。

#### L4-b. Q14 — v1.0.0 acceptance criteria

「v1.0.0 ship 可 能」 と は 何 か の checklist を `10-roadmap.md` §1 に。 候 補: canonical examples 全 compile + 期 待 output / `@unworklet/offline` で reference processor を bit-exact render / `vp build` 通 る / realtime-safety invariants 5 件 全 layer 検 出 / browser × {isolated, not} matrix smoke pass。 設 計 question で は な く process question、 freeze 直 前 に 一 括 決 定 で 十 分。

**な ぜ こ の 位 置** — freeze 判 定 基 準、 freeze 直 前 で OK。

#### L4-c. Trivial v1.0.0 settings (旧 L4-h)

`09-repo-structure.md` の 設 定 値 — Q12 monorepo tool / Q13 initial package layout (**L1-d と 連 動** = L1-d ratify 後 に 自 動 派 生)/ Q15 license / Q16 npm scope / Q26 TS 最 低 version。 freeze 前 に 1 batch 決 定。

**な ぜ こ の 位 置** — L1-d ratify で Q13 が ほ ぼ 決 ま る。 残 り 4 件 は judgment 軽 い 設 定 値。

#### L4-d. `docs/recipes/` voice allocation pattern (旧 L4-c)

Polyphony / voice stealing を recipe doc 化 す る か。 canonical Ex 8 で 4-voice mono synth カ バ ー、 v1.0.0 ship 必 須 で は な い。 v1.x.0 補 完 docs と し て 後 で 検 討。

#### L4-e. `docs/recipes/` overlap-add pattern (旧 L4-d)

STFT 由 来 の Overlap-Add の recipe。 L4-d と 同 様 v1.0.0 ship 必 須 で は な い。

#### L4-f. Issue-ize the finalized v1.0.0 spec (旧 L4-g)

こ の `open-questions.md` が freeze 状 態 に な っ た 時 点 で、 ratify 済 み 設 計 + 残 task を GitHub issues に 1-to-1 化、 `v1.0.0` milestone を 付 け て impl agent 群 に 流 す。 そ れ ま で は こ の file が canonical。

**な ぜ 最 後 の 位 置** — freeze の 最 終 step。 他 全 て を 終 え た 後。

---

## 新 規 question の 追 加 場 所

新 し く 浮 上 し た question は 末 尾 に 暫 定 layer を 付 け て 追 加 し、 次 の ratify 時 に 並 び 替 え る。

---

## audit 出 力 ア ー カ イ ブ

こ の 並 び 直 し の base に な っ た 3 つ の sub-agent audit:

- `/var/folders/.../audit-A-undecided.md` — Prose 内 未 確 定 標 識 / placeholder vs spec 矛 盾 / dead Q-ref / type signature 不 完 全 / v1.0.0 約 束 vs 未 定 義 / canonical drift (6 + 8 + 5 + 5 + 3 + 5 = 32 件)
- `/var/folders/.../audit-B-consistency.md` — cross-doc consistency (同 概 念 別 表 現 / 同 規 則 別 判 定 / package drift / 識 別 子 揺 れ / Q-ref drift / Status TOC drift / canonical vs spec drift、 18 件)
- `/var/folders/.../audit-C-decisions-log.md` — decisions-log integrity (summary 無 detail × 7 件 + Q22 drift × 3 + line-ref drift 体 系 + open follow-up × 5 entry 群)
