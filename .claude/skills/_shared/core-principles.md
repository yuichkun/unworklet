# unworklet core principles

このファイル は spec-integrity-sweep と spec-triage の 両 skill が 参照 する **共通 base** = unworklet の 目指す 姿 + 守る べき 性質 + 醜い と み なす もの。

live document として 上書き で 更新 する。 temporal 表現 (= 「previously」 「now」 「retired」 等) を 書か ない。

---

## 1. unworklet とは

TypeScript-first な 宣言的 DSL で 書かれた DSP を Audio Worklet 上 の WebAssembly に compile する ライブラリ。 ユーザー は graph を declare する だけ で、 framework が capture → static analysis → WASM emission → runtime guard を 担う。

v1.0.0 ship 前 の 現在 docs の 第一 読者 は **実装 期 の AI agent**。 user-facing tutorial / chooser doc は ship 後 phase で 別途 整える。

---

## 2. 守る べき 性質

以下 は 「unworklet で あり 続ける ため に」 削れ ない 性質。 個別 判断 で この いずれか と 衝突 する 提案 が 出たら 採用 NG。

- **declarative**: user が 書いた 構造 が そのまま WASM に なる。 framework が 意味 を 変える 自動 書き換え は 列挙 限定。 意味 を 変え ない 最適化 (= dead code elimination、 SIMD ベクトル化 等) は OK だが、 user 値 を 黙って 別 値 に 差し替える / 隠れた delay を 入れる / sequence を rewrite する 系 は NG。
- **AI agent paradigm**: 実装 工数 で scope を 絞ら ない。 v1.0.0 で 「あと で」 が 効か ない の は wire byte 等 の 後戻り 不可 領域 と、 mental model に 染み出す API surface のみ。 工数 だけ を 理由 に した defer は NG。
- **v1.0.0 ship 前 = 仕様 直す コスト ≪ 実装 直す コスト**: 既 決定 と 新 知見 が 衝突 した 時、 retract コスト で 設計 案 を 曲げ ない。 ボツ 案 は decisions-log に rejected として 残す = 資産。
- **user free が default**: 制約 を 入れる 方 が 例外。 「mental」 「美学」 「対称性」 で 勝手 に 制約 を 入れ ない。 制約 を 入れる に は 仕様 invariant か 哲学 派生 の justify が 必要。
- **既知 必要 を 後回し に し ない**: PoC で 確認 でき + AI agent で 並列 に 厚く できる もの (= MIDI message variants、 SIMD instruction families 等) のみ defer 可。 API surface / 型 / メンタル モデル に 染み出す 選択 は 今 decide。
- **mental model unification ≠ feature reduction**: 「simpler mental model」 を 口実 に feature を 削ら ない。 opt-in / namespaced surface で 「必要 ない user に は 見え ない、 必要 な user に は 第一級」 を 探す。
- **canonical-examples が 仕 様 規 範 anchor**: `docs/12-canonical-examples.md` は **curated 規 範 例 集 / 整 合 anchor** (= AGENTS.md HARD CONTRACT)。 仕 様 を 変 え る 時 affected example が realistic / 自 然 か 確 か め、 同 commit で zip 修 正 必 須。 ただ し **「全 primitive / 全 declaration を canonical で 1 回 ず つ 個 別 hit」 は rule で は な い** (= AGENTS.md L16 「exercise the full surface」 は curated 規 範 例 集 と し て full surface に 触 れ る 寄 り、 機 械 網 羅 ナ シ)。 個 別 primitive / declaration が canonical 例 で hit ナ シ ≠ 仕 様 違 反。 Coverage table も 「user が 例 か ら 規 範 を 引 け る map」 で あ り、 機 械 網 羅 check list で は な い。
- **TS form 細部 / 命名 / mechanism 自由 度 = 実装 期 任せ**: TypeScript signature の 細部 (= type alias 名、 generic constraint の 切り 方、 callable + property hybrid 等 の form)、 識別子 命名 (= enforcement layer の 別名 等)、 internal mechanism の 選択 自由 度 (= main 側 event drain が MessageChannel ping か Atomics.notify か 等) は 仕様 invariant が 動か ない 限り 実装 期 の AI agent が 機械 的 に 決める 領域。 spec docs に entry と して 残す 価値 ナシ。 sweep 時 は entry に 拾わ ず scope 外、 万一 拾われ た 場合 は triage e 軸 で 自律 close (= 二重 防御)。
- **main / worklet 間 の 内 部 wire = 実 装 期 任 せ**: SAB ringbuffer slot 並 び、 event slot / MIDI slot field 並 び、 sysex content buffer 並 び 等 main / worklet 間 の 内 部 wire layout は **ship 後 凍 結 で は な い** (= framework 同 ship 内 で main bundle / worklet bundle ペ ア で deploy さ れ、 ship ご と に 自 由 に 変 え ら れ る、 user code に は wire byte 並 び が 見 え な い)。 = 仕 様 invariant が 動 か な い 限 り 実 装 期 の AI agent が 決 め る 領 域 = e 軸。 ship 後 凍 結 さ れ る wire byte は **`node.snapshot()` の Uint8Array blob 並 び の み** (= user が persist + 新 ship で restore = migration mandatory)。

---

## 3. 醜い と み なす もの

- framework が user 値 を 「意味 が 変わる」 形 で 暗黙 に 書き換える (= subnormal flush / carrier-clamp / param clamp 等、 列挙 した もの は OK、 列挙 漏れ NG)
- 工数 見積 で scope を 絞る (= 「人間 N 週間」 式 の 判断)
- 「mental 簡素」 を 口実 に した feature 削減
- 過去 決定 の 撤回 コスト で 設計 を 曲げる
- temporal 表現 を docs prose に 残す (= 「previously」 「now」 「earlier draft」 「retired」 等)
- TS form / 命名 / mechanism 自由 度 の 細部 を spec entry と して 余湖さん に 上げる (= 過剰 エスカレーション、 attention 浪費)
- canonical で 個 別 primitive / declaration が hit ナ シ を 「規 範 確 認 不 在」 「HARD CONTRACT 違 反」 と し て sweep / triage で 拾 い 上 げ る (= AGENTS.md 「exercise the full surface」 を 機 械 網 羅 と 過 剰 解 釈、 curated 規 範 例 集 性 質 を 失 念、 余 湖 さ ん attention 浪 費)
- main / worklet 間 内 部 wire (= SAB ringbuffer slot 並 び / event slot / MIDI slot / sysex content buffer 等) を 「wire byte 並 び は ship 後 凍 結」 と し て sweep / triage で 拾 い 上 げ る (= snapshot blob だ け が 真 の 凍 結 領 域、 内 部 wire は framework 同 ship 内 ペ ア = 自 由、 余 湖 さ ん attention 浪 費)

---

## 4. メンテナンス

このファイル を 更新 する 際 は **両 skill (= spec-integrity-sweep と spec-triage) の 動作 に 影響** する こと を 意識。 update 後 は 必要 に 応 じて:

- `references/decision-axes.md` (= triage 側) の §2 軸 例 を refresh
- `references/priority-filter-rationale.md` (= sweep 側) の filter rule + 累犯 規律 wording を refresh
