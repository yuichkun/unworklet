# Open questions — v1.0.0 spec

未 ratify 設 計 question を 集 約 す る single source of truth。 ratify さ れ た ら `decisions-log.md` に 移 し (summary table 行 + detail entry、 同 commit)、 こ の file か ら 削 る。

## 運 用 ル ー ル

- question が 浮 上 し た 時 点 で こ の file に 追 加 (= grill 途 中 で も)、 揮 発 性 を 持 た せ な い。
- 各 entry: **何 が 未 決 / どの doc が 触 れ る / 選 択 肢 / こ の 層 に 入 れ た 理 由 / 関 連 pillar** を 揃 え る。
- 層 順 は ratify ご と に 再 評 価。 audit 由 来 の tier や issue 番 号 を そ の ま ま 流 さ な い (= 余 湖 さ ん の attention は 有 限)。
- TaskList (claude-code 進 行 管 理 側) は こ の file に 従 う。 GitHub issue 化 は v1.0.0 spec freeze 後 (L4-f) に 一 括。

## ratify 範 囲 と priority filter

**docs 読 者** = impl AI agent (= v1.0.0 ship 前 docs は impl agent が 迷 わ ず 判 断 す る ため の 仕 様、 user-facing docs = getting started / API reference / tutorials は v1.0.0 完 成 後 別 phase で 作 る、 い ま 関 心 範 囲 外)。

**ratify 範 囲** = **仕 様 invariant** (= 振 る 舞 い / 制 約 / mental model / 公 開 surface に 何 が 出 て く る か / 仕 様 内 の 矛 盾 / dangling) だ け。 TS signature 細 部 / 識 別 子 名 の 好 み / generic constraint 表 現 等 は impl AI agent が TS compiler 経 由 で 機 械 的 に 確 定 す る 領 域 (= 「曖 昧 さ を 残 す」 で は な く 「適 切 な layer に 委 譲」、 `decisions-log.md` Q53)。

**priority filter** = 「**impl AI agent に 手 放 し で 実 装 さ せ た ら 矛 盾 が 出 る か**」 を 唯 一 の judgement 軸 と す る (Q55)。 「user が 誤 解 す る」 「mental model が 揺 れ る」 「読 解 違 和 感」 等 の user-facing 視 点 で 上 げ る な = mechanical sweep 領 域、 freeze 前 に 1 batch。 真 の ★★★ は **異 な る impl agent が 異 な る judgment に 達 し て し ま う 仕 様 prose 内 の 矛 盾 / dangling** だ け。

## 5 層 filter

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

- **Layer 1 — 真 の ★★★ = impl 矛 盾 リ ス ク 高。** 仕 様 prose 内 矛 盾 / dangling、 異 な る impl agent が 異 な る judgment に 達 す る = 矛 盾 し た 実 装 が 出 る。 余 湖 さ ん grill 必 須。
- **Layer 2 — additive surface。** v1.0.0 公 開 surface に 含 め る か decide、 含 め な い 場 合 は v1.x.0 で 追 加 可、 impl 矛 盾 リ ス ク 低 い。
- **Layer 3 — freeze 前 process / trivial 設 定 値。** v1.0.0 freeze 直 前 1 batch、 軽 量 judgment (= owner 任 せ 方 針 / acceptance criteria / license / npm scope 等)。
- **Layer 4 — mechanical sweep。** 余 湖 さ ん judgment 不 要、 freeze 前 1 batch (= decisions-log integrity / line-ref / README / docs prose 揃 え / canonical integrity 等)。
- **Layer 5 — freeze 後 / v1.x.0。** v1.0.0 ratify 範 囲 外、 freeze 後 に GitHub issue 化 or v1.x.0 docs/recipes/ で 追 加。 い ま は touch し な い。

**ID prefix の 注 釈:** entry ID (= `L1-b` / `L2-c` 等) は 歴 史 的 命 名 で **過 去 ratify / decisions-log 引 用 と の 整 合 維 持** の た め fix。 Layer 配 置 は ratify ご と に 現 priority filter (= impl 矛 盾 リ ス ク 軸) で 動 く = ID prefix と Layer 番 号 が 一 致 し な い ケ ー ス あ り。

**層 内 順 序 の 判 断 軸:**

1. **impl 矛 盾 リ ス ク** — 仕 様 prose 内 の 矛 盾 / dangling、 異 な る impl agent が 異 な る judgment に 達 す る も の が 上 位 (= ship 後 breaking)
2. **議 論 の 軽 さ** — 軽 い ratify を 先 に 片 付 け て attention を 重 い judgment に 集 中
3. **依 存 関 係** — invariant ratify 間 の 順 序 整 合

---

## Layer 1 — 真 の ★★★ (impl 矛 盾 リ ス ク 高)

### L2-c. `createNode({ restore })` 経 路 で migration 失 敗 を ど う surface す る か

**何 が 未 決** — `05-client.md` §1 の `CreateNodeOptions<C>.restore?: Uint8Array` は 「Schema mismatch routed through the processor's `migrations` chain」 と 書 く が、 戻 り 値 は `Promise<UnworkletNode<C>>` で `RestoreResult` を 含 ま な い。 `node.restore(blob)` method 経 由 は `RestoreResult` discriminated union を 返 す が、 `createNode({ restore })` で migration が throw し た 場 合 の レ ポ ー ト path が 仕 様 化 さ れ て い な い。 audit A §5 拾 い。

**な ぜ こ の 位 置 (= Layer 1)** — 真 の impl 矛 盾 リ ス ク = 戻 り 値 surface dangling、 異 な る impl agent が (A) 戻 り 値 を `{ node, restore }` に 拡 張 / (B) `onError` で 通 知 / (C) 経 路 自 体 削 除 の どれ か を 別 々 に 採 用 し て 公 開 surface が 衝 突。 ship 後 breaking。 選 択 肢 自 体 は 3 案 で 軽 い ratify。

**選 択 肢:**

- **(A) `createNode({ restore })` の 戻 り 値 を `Promise<{ node: UnworkletNode<C>; restore: RestoreResult }>` に。** breaking ま で 行 か な い が API 形 変 化。
- **(B) `restore` 失 敗 時 は `onError` event で 通 知、 `createNode` 自 体 は 必 ず resolve。** 簡 潔 だ が consumer の 監 視 forced。
- **(C) `createNode({ restore })` 経 路 自 体 を 廃 止、 「`createNode → await restore(blob)`」 を canonical pattern と し て docs 化。** v1.0.0 surface 削 減。 既 存 canonical で `restore` 経 路 を 使 う 例 は ナ シ (`initial` の み)。

**ど の doc が 触 れ る** — `05-client.md` §1 / §2.6 / §6.5。

**Pillar 関 連** — P2。

---

### L2-d. L1 helper の nested `forSample` を 明 示 化 (旧 L3-b)

**何 が 未 決** — `01-dsl.md` §5.5.5 で L1 helper 内 `forSample(...)` 呼 び 出 し が 「rare; usually iteration is the caller's job」 と OK 寄 り、 §10.3 forSample body constraints で 「Allowed: ... calls to L1 helpers」 と 書 く。 こ の 2 つ を 組 み 合 わ せ る と **L1 helper が 内 部 で `forSample` を 呼 ぶ + 呼 び 出 し 側 も `forSample` 内** = 暗 黙 に nested `forSample` 成 立。 spec で 明 示 化 ナ シ。 audit B §2 拾 い。

**な ぜ こ の 位 置 (= Layer 1)** — RT-safe 静 的 解 析 (= bounded loop check) の 範 囲 が dangling = 異 な る impl agent が nested loop の bound check 範 囲 / sample-offset 独 立 性 を 別 々 に 判 断 し て 矛 盾 し た 実 装 が 出 る。 公 開 API surface 追 加 で は な い が、 静 的 解 析 invariant の dangling = 真 の impl 矛 盾 リ ス ク。

**選 択 肢:**

- **(A) 暗 黙 OK を 明 文 化。** §5.5.5 に 「helper の forSample は caller の forSample と nested で 動 く、 sample-offset は caller の `i` と は 独 立 」 と 明 記。
- **(B) Nested forSample を spec で 禁 止。** 「helper の forSample は caller が forSample 外 か ら 呼 ぶ 場 合 限 定」 と 規 則 化。 §10.3 「nested forSample (rare; typically used for tile iteration in 2D buffers)」 wording を 削 除。
- **(C) Tile iteration use case (= forSample 内 で nested forSample で 2D buffer 走 査) を 明 示 use case と し て 採 用、 例 を 1 個 canonical に 追 加。**

**Pillar 関 連** — P6、 P3 (RT-safe — nested は 静 的 解 析 で bounded 確 認 必 要)。

---

## Layer 2 — additive surface (v1.x.0 OK 寄 り)

### L3-a. SIMD horizontal reduce (`sumLanes`) を v1.0.0 で 出 す か

**何 が 未 決** — `Node<'f32x4'>` の 4 lane 合 計 を 返 す primitive (`sumLanes(v): Node<'f32'>`) を v1.0.0 SIMD surface に 入 れ る か。 v1.x.0 で additive に 入 れ ら れ る。

**な ぜ こ の 位 置 (= Layer 2)** — 公 開 surface decide だ が、 含 め な い 選 択 で も impl AI は 仕 様 通 り 含 め ず に 動 け る = impl 矛 盾 リ ス ク 低 い。 v1.x.0 で additive に 追 加 可。

**ど の doc が 触 れ る** — `01-dsl.md` §7.2 / §7.3、 `03-compiler.md` §4。

**Pillar 関 連** — P5 (minimal = 入 れ な い 方 が pure)、 P2。

---

## Layer 3 — freeze 前 process / trivial 設 定 値

v1.0.0 freeze 直 前 1 batch で 決 定、 余 湖 さ ん judgment 軽 量。 ratify 内 部 ループ で は な い 「process question」 + 「trivial 設 定」。

### L4-a. Placeholder section 群 — impl 期 owner 任 せ と 明 文 化

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

### L4-b. Q14 — v1.0.0 acceptance criteria

「v1.0.0 ship 可 能」 と は 何 か の checklist を `10-roadmap.md` §1 に。 候 補: canonical examples 全 compile + 期 待 output / `@unworklet/offline` で reference processor を bit-exact render / `vp build` 通 る / realtime-safety invariants 5 件 全 layer 検 出 / browser × {isolated, not} matrix smoke pass。 設 計 question で は な く process question、 freeze 直 前 に 一 括 決 定 で 十 分。

### L4-c. Trivial v1.0.0 settings

`09-repo-structure.md` の 設 定 値 — Q12 monorepo tool / Q15 license / Q16 npm scope / Q26 TS 最 低 version。 freeze 前 に 1 batch 決 定 (= Q13 initial package layout は Q52 / L1-d ratify で 既 確 定)。

---

## Layer 4 — mechanical sweep (= 余 湖 さ ん judgment 不 要、 freeze 前 1 batch)

以 下 ratify 内 容 を 変 え ず docs を 揃 え る sweep。 1 commit で 一 括 が 望 ま し い (= AGENTS.md HARD CONTRACT の canonical integrity rule を 同 時 に 守 る)。

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

## Layer 5 — freeze 後 / v1.x.0 (= v1.0.0 ratify 範 囲 外)

v1.0.0 ship 完 了 後 に 触 れ る entry。 い ま grill 対 象 外、 freeze 後 GitHub issue 化 or v1.x.0 docs/recipes/ で 追 加。

### L4-d. `docs/recipes/` voice allocation pattern

Polyphony / voice stealing を recipe doc 化 す る か。 canonical Ex 8 で 4-voice mono synth カ バ ー、 v1.0.0 ship 必 須 で は な い。 v1.x.0 補 完 docs と し て 後 で 検 討。

### L4-e. `docs/recipes/` overlap-add pattern

STFT 由 来 の Overlap-Add の recipe。 L4-d と 同 様 v1.0.0 ship 必 須 で は な い。

### L4-f. Issue-ize the finalized v1.0.0 spec

こ の `open-questions.md` が freeze 状 態 に な っ た 時 点 で、 ratify 済 み 設 計 + 残 task を GitHub issues に 1-to-1 化、 `v1.0.0` milestone を 付 け て impl agent 群 に 流 す。 そ れ ま で は こ の file が canonical。

---

## 新 規 question の 追 加 場 所

新 し く 浮 上 し た question は 末 尾 に 暫 定 layer を 付 け て 追 加 し、 次 の ratify 時 に 並 び 替 え る。

---

## audit 出 力 ア ー カ イ ブ

こ の 並 び 直 し の base に な っ た 3 つ の sub-agent audit:

- `/var/folders/.../audit-A-undecided.md` — Prose 内 未 確 定 標 識 / placeholder vs spec 矛 盾 / dead Q-ref / type signature 不 完 全 / v1.0.0 約 束 vs 未 定 義 / canonical drift (6 + 8 + 5 + 5 + 3 + 5 = 32 件)
- `/var/folders/.../audit-B-consistency.md` — cross-doc consistency (同 概 念 別 表 現 / 同 規 則 別 判 定 / package drift / 識 別 子 揺 れ / Q-ref drift / Status TOC drift / canonical vs spec drift、 18 件)
- `/var/folders/.../audit-C-decisions-log.md` — decisions-log integrity (summary 無 detail × 7 件 + Q22 drift × 3 + line-ref drift 体 系 + open follow-up × 5 entry 群)
