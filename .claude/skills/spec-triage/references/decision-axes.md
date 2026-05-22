# unworklet の 目指す 姿 と 決定 軸

このファイル は `docs/open-questions.md` の 個別 entry を 「自律 で 直す」 「余湖さん 相談」 に 分ける ため の 知識 ベース。 spec-triage skill が 参照 する。

live document として 上書き で 更新 する。 temporal 表現 (= 「previously」 「now」 「retired」 等) を 書か ない。 新 決定 が 出る 度 に 該当 軸 を 直接 書き換え。

---

## 1. プロダクト の 目指す 姿

### 1.1 unworklet とは

TypeScript-first な 宣言的 DSL で 書かれた DSP を Audio Worklet 上 の WebAssembly に compile する ライブラリ。 ユーザー は graph を declare する だけ で、 framework が capture → static analysis → WASM emission → runtime guard を 担う。

v1.0.0 ship 前 の 現在 docs の 第一 読者 は **実装 期 の AI agent**。 user-facing tutorial / chooser doc は ship 後 phase で 別途 整える。

### 1.2 守る べき 性質

以下 は 「unworklet で あり 続ける ため に」 削れ ない 性質。 個別 判断 で この いずれか と 衝突 する 提案 が 出たら 採用 NG。

- **declarative**: user が 書いた 構造 が そのまま WASM に なる。 framework が 意味 を 変える 自動 書き換え は 列挙 限定。 意味 を 変え ない 最適化 (= dead code elimination、 SIMD ベクトル化 等) は OK だが、 user 値 を 黙って 別 値 に 差し替える / 隠れた delay を 入れる / sequence を rewrite する 系 は NG。
- **AI agent paradigm**: 実装 工数 で scope を 絞ら ない。 v1.0.0 で 「あと で」 が 効か ない の は wire byte 等 の 後戻り 不可 領域 と、 mental model に 染み出す API surface のみ。 工数 だけ を 理由 に した defer は NG。
- **v1.0.0 ship 前 = 仕様 直す コスト ≪ 実装 直す コスト**: 既 決定 と 新 知見 が 衝突 した 時、 retract コスト で 設計 案 を 曲げ ない。 ボツ 案 は decisions-log に rejected として 残す = 資産。
- **user free が default**: 制約 を 入れる 方 が 例外。 「mental」 「美学」 「対称性」 で 勝手 に 制約 を 入れ ない。 制約 を 入れる に は 仕様 invariant か 哲学 派生 の justify が 必要。
- **既知 必要 を 後回し に し ない**: PoC で 確認 でき + AI agent で 並列 に 厚く できる もの (= MIDI message variants、 SIMD instruction families 等) のみ defer 可。 API surface / 型 / メンタル モデル に 染み出す 選択 は 今 decide。
- **mental model unification ≠ feature reduction**: 「simpler mental model」 を 口実 に feature を 削ら ない。 opt-in / namespaced surface で 「必要 ない user に は 見え ない、 必要 な user に は 第一級」 を 探す。
- **canonical-examples が 仕 様 規 範 anchor**: `docs/12-canonical-examples.md` 全 example が build 可能 で 仕様 と 1 対 1 で zip する こと が AGENTS.md HARD CONTRACT。 仕様 変更 ごと に Coverage table 同 commit 修正 必須。

### 1.3 醜い と み なす もの

- framework が user 値 を 「意味 が 変わる」 形 で 暗黙 に 書き換える (= subnormal flush / carrier-clamp / param clamp 等、 列挙 した もの は OK、 列挙 漏れ NG)
- 工数 見積 で scope を 絞る (= 「人間 N 週間」 式 の 判断)
- 「mental 簡素」 を 口実 に した feature 削減
- 過去 決定 の 撤回 コスト で 設計 を 曲げる
- temporal 表現 を docs prose に 残す (= 「previously」 「now」 「earlier draft」 「retired」 等)

---

## 2. 個別 entry を 自律 / 相談 に 分ける 軸

入力 = `docs/open-questions.md` の 1 entry (= `## タイトル` + `**場所**:` + `**何 が 起きて いる か**:` + `**impl AI 影響**:` + `**判断 軸**:`)。

判別 順序 = a → b → c → d → e → f → g → h の 順 で hit すれば そこ で 確定。 hit せず h まで 到達 した entry は 軸 が 足り ない signal = §5 メンテナンス で 軸 自体 を 更新 する trigger。

### 自律 で 直す (= a / b / c / d)

入力 が 客観的 に 揃う もの。 commit message に 適用 軸 (a-d の どれ か) と 引用 行 を 1 行 で 書く。

#### a. ドキュメント の 別 場所 で 既 に そう 書か れて いる

**何 を 表す か**: entry が 提起 する 問題 に つ いて、 docs の どこ か 1 ヶ所 で すで に 明文 化 された 答え が あり、 残り の ばらつき は その 既 明文 に 揃える だけ の もの。

**check する 場所**:
- foundations / 該当 章 prose に 該当 問題 への declare 文 が ある か
- decisions-log Q ratify entry が ある か (= 該当 Q番号 が entry 内 で 引用 されて いれば 高 確率)
- entry の 「判断 軸」 行 で 「prose path を 一本化」 「既 〜 path に 揃える」 文言 が 出て いる か

**典型 fix**: 散らばり 箇所 を 既 明文 に rewrite する 1 commit。

**例**:
- `'u8'` を 型 system の どこ に 入れる か (= `00-foundations.md` が 既 「scalar type set に 入れ ない」 と 明言)
- MIDI 送信 の sample 番号 引数 (= `11-midi.md` §4.2 prose 既 規定)

#### b. 規範 例 で 既 に その 形 が 動 いて いる

**何 を 表す か**: docs 散文 で は ばらついて も、 `12-canonical-examples.md` の 既 規範 例 が すで に その 形 を 前提 と して 書か れて おり、 規範 例 を 信用 して prose を 揃える だけ で 答え 出る もの。

**check する 場所**:
- canonical 内 で 該当 機能 を 動かして いる Ex は どれ か
- その Ex の code が どの path を 前提 と して 書か れて いる か
- AGENTS.md HARD CONTRACT (= 全 仕様 を canonical で 1 意 exercise) を 既 守って いる か

**典型 fix**: prose を 規範 例 path に 揃える 1 commit。 canonical が 規範 で あり、 散文 を canonical に 合わせる の が default 方向。

**例**:
- SIMD method の リテラル lift (= 規範 例 が 既 lift 前提 で 書か れて いる)
- implicit widening 違反 修正 (= `00-foundations.md` §4 既 規定 に 規範 例 を zip し 直す)

#### c. 余湖さん の 既 哲学 で 答え が 1 つ に 絞られる

**何 を 表す か**: §1.2 で declare した 守る べき 性質 を 個別 entry に 当てて、 path が 1 つ に 絞られる もの。

**派生 root の 典型**:
- 「declarative」 → framework auto-rewrite を 完全 列挙 義務、 暗黙 書き換え 追加 NG
- 「user free が default」 → 制約 を 入れる 方 が 例外、 「美学」 で 制約 を 自動 追加 し ない
- 「既知 必要 を 後回し に し ない」 → AI 並列 で 厚 化 できる もの 以外 defer NG
- 「mental model unification ≠ feature reduction」 → simpler mental の 名目 で feature を 削ら ず opt-in / namespaced で 解決
- 「実装 コスト で scope を 絞ら ない」 → 工数 だけ で 設計 を 曲げ ない

**check する 場所**:
- entry の 「判断 軸」 行 で §1.2 の どの 性質 と 一致 する path が 既 推奨 されて いる か
- §1.2 の 性質 を 個別 に 当てて path が 1 つ に 絞られる か (= 複数 哲学 が 衝突 する なら g に 落ちる)

**典型 fix**: 哲学 派生 path に prose を 揃える 1 commit、 適用 した §1.2 項目 を commit message に 引用。

**例**:
- worklet 側 から typed-array を 流す path を event<T> でも 一般 化 (= 「既知 必要 を 後回し に し ない」 で MIDI sysex 限定 を 解く)
- framework 自動 書き換え の 完全 列挙 (= 「declarative」 で 列挙 義務)

#### d. 外部 標準 / 客観 事実 で 一意

**何 を 表す か**: Web 標準 / IEEE 754 / JS Atomics API 仕様 等、 unworklet の 設計 領域 を 外れた 客観 事実 で 答え が 確定 する もの。

**典型 source**:
- JS Atomics API (= integer typed array 限定)
- IEEE 754 (= subnormal 範囲、 floating-point 表現)
- AudioWorklet API (= render quantum 128 sample 固定)
- Web Audio API (= AudioParam の k-rate / a-rate)
- TypeScript type system (= conditional types、 generic constraint 等)

**check する 場所**:
- entry が 引用 する API / 標準 を 1 次 source で 確認 (= MDN / TC39 / W3C / IETF 等)
- 標準 が 明確 に 1 答え を 出す か (= 揺れ が ない か、 implementation-defined で ない か)

**典型 fix**: 標準 が 出す 一 答え に prose を 寄せる 1 commit。

**例**:
- `state.f32` atomic store path (= Atomics は integer typed array 限定 = reinterpret view 経由 が 客観 path)
- subnormal flush 値 (= IEEE 754 subnormal 範囲 ≈ 1.18e-38)

### 余湖さん 相談 必要 (= e / f / g / h)

入力 が 客観的 に は 揃わ ない + 後戻り 不可 / 趣味 余地 の もの。 batch で 相談 md (= `$TMPDIR` 下 の grill md) に まとめて 余湖さん に 渡す。 1 相談 md = 1 entry または 同 trade-off の 数 entry を 束ねる。

#### e. 過去 の 決定 を 撤回 する 必要 が ある

**何 を 表す か**: docs 内 既 ratify Q を 撤回 し ない と 残り の 矛盾 が 解け ない、 かつ 撤回 path が §1.2 哲学 で は 一意 に 出 ない もの。

**な ぜ 自律 不可**: 仕様 retract = 既 ratify を rejected として 残す ≒ 過去 自分 の 判断 を 修正 する 操作。 v1.0.0 前 = 仕様 直す コスト ≪ 実装 直す コスト で retract 自体 は OK だ が、 retract path が 複数 等価 で 残る 場合 は 余湖さん が decide する 領域。

**check する 場所**:
- entry が 既 ratify Q番号 と 直接 衝突 する か
- 撤回 path が §1.2 哲学 で 一意 か (= 一意 なら c 寄り、 等価 解 が 残る なら e)
- 撤回 すると cascade で 他 Q も 動く か (= 動く なら 影響 範囲 を 相談 md に 含める)

**典型 出し 方**: 撤回 必要 な Q番号 + 撤回 path 候補 を 相談 md に 列挙、 各 path の trade-off を 並べ、 余湖さん 判断 待ち。

**例**:
- `event<T>` payload で float 値 受容 (= Q46 撤回 必要、 撤回 path 3 way 等価)

#### f. ship 後 変え 不可 な byte 並び

**何 を 表す か**: wire byte layout (= SAB ringbuffer slot 並び、 sysex content buffer 並び、 snapshot blob 並び 等)、 ship 後 互換 性 で 凍結 さ れる もの。

**な ぜ 自律 不可**: ship 後 互換 = 1 度 出した byte 並び は v1.x.0 で 戻せ ず、 v2.0.0 で migration mandatory。 「あと で 直せば 良い」 が 効か ない 領域 で、 余湖さん 視認 必須。

**check する 場所**:
- entry が main / worklet 間 wire (= SAB byte 並び、 postMessage payload) を 触る か
- entry が snapshot blob byte 並び を 触る か
- 「同 source code で 別 impl が reproducible で ない」 を impl AI 影響 行 で 示唆 して いる か

**典型 出し 方**: byte 並び 候補 を A / B / C 表 で 相談 md、 各 候補 の wire byte 形 を 図 化、 余湖さん decide。

**例**:
- event slot vs MIDI slot で atSample 位置
- variable-length payload 並び 方
- sysex slot に atSample 不在

#### g. UX / 美学 / 命名 で 複数 解 が 等価

**何 を 表す か**: 複数 path が §1.2 哲学 / 外部 標準 で 等価、 user に 出る surface (= 識別子 名、 error message 文言、 fallback 動作) で 余湖さん 趣味 が 入る もの。

**な ぜ 自律 不可**: 「美学」 「対称性」 で 自動 化 する と §1.3 醜い と み なす もの (= artificial 制約) 違反。 余湖さん 主観 で 趣味 を 反映 する 領域 で、 勝手 に 一つ 採用 し ない。

**check する 場所**:
- path が §1.2 哲学 で 等価 か (= a-d で 出 ない か)
- 識別子 / surface 命名 / error 動作 を 直接 触る か
- 「複数 哲学 が 衝突」 で c 不可 に なる ケース が 多 い

**典型 出し 方**: 等価 path を 並べた 相談 md、 各 path の user 視点 trade-off を 明示、 余湖さん 推奨 待ち。

**例**:
- render quantum 不一致 時 動作 (= silence + onError か process return false か onError 発火 後 silence か)
- 「L1/L2/L3」 略称 衝突 解消 (= enforcement layer / integration layer の どち ら を 別 命名 に 寄せる か)

#### h. 規範 例 の 大規模 改変

**何 を 表す か**: `12-canonical-examples.md` の 既 Ex を 数 十 行 規模 で 拡張 / 改変、 または 新 Ex を 立てる もの。 AGENTS.md HARD CONTRACT (= canonical 整合 性 視認) を 直接 触る。

**な ぜ 自律 不可**: canonical = 全 仕様 の 規範 確認 anchor、 大 改変 は 余湖さん 設計 視認 領域 (= AGENTS.md 明言 「out of process」)。 小 改変 (= 既 Ex の 1-5 行 code / 数 行 prose) は a / b 寄り だが、 数 十 行 規模 は h。

**閾値**:
- 1 Ex に 数 十 行 追加 / 新 Ex 1 件 立てる → h
- 既 Ex の 1-5 行 code 修正 / 数 行 prose 揃え → a / b

**check する 場所**:
- entry が canonical の Coverage table の どの 行 を 動かす か
- code 追加 規模 を 行数 概算

**典型 出し 方**: 改変 / 新規 Ex の design draft を 相談 md に 提示、 数 十 行 分 の code 案 を 含めて 余湖さん decide。

**例**:
- SIMD primitive 4 個 を canonical で exercise (= 数 十 行 規模 新 Ex か 既 Ex 拡張)
- Ex 5 grain spawn voice allocation 全 unroll (= 数 十 行 追加)

---

## 3. 自律 で 直す 時 の commit 規律

各 自律 commit (= a / b / c / d 適用) の message に 以下 を 必ず 含める:

```
docs(<scope>): <変更>

decision-axes: <a | b | c | d>
基づく: <docs 行 引用 / Q番号 / §1.2 項目 名 / 外部 標準 link>
理由 1 行: <なぜ この 軸 で 答え 一意 か>
```

余湖さん は `git log --oneline` + commit body で 流し 読み audit。 軸 が 雰囲気 で 当てられて いれば revert candidate。 revert は 「軸 自体 が 不足 / 誤 適用」 の signal で、 §5 メンテナンス trigger。

---

## 4. 相談 の 出し 方

各 相談 (= e / f / g / h 適用) は `$TMPDIR` 下 に 1 相談 md を 出す。 1 md の 構造:

```
# <短 タイトル>

【何 の 話 か】
平易 日本語 で 1-3 段 落、 entry の 中身 を 余湖さん 視点 で 説明。 変数 名 / Q番号 / 内部 用語 を 排除。

【選択肢】
- 案 A: <code 例 / 図 込み> + 余湖さん が 書 く と こう なる
- 案 B: <code 例 / 図 込み> + 余湖さん が 書 く と こう なる
- (必要 なら C / D)

【僕 の 推奨 と 弱点】
推奨 = <案 X>。 ただ し 弱点: <自己 列挙 1-2 個>。

【判断 待ち】
余湖さん が 案 を 選ぶ + 必要 な ら 修正 指示。
```

軸 = e / f / g / h の どれ か を 相談 md 末尾 に 1 行 添え (= 余湖さん が 「これ は h か、 大規模 改変 だ な」 等 と 即 認識 できる)。

余湖さん 回答 後 = 該当 docs 反映 + decisions-log Q 追記 + open-questions entry 削除 を 1 commit。 同時 に 「次 から この タイプ は こう」 を §1.2 哲学 または §2 軸 a-d の 中身 に 追記 (= 軸 が 育つ)。

---

## 5. 軸 集 の メンテナンス

このファイル は live document。

更新 trigger:
- e / f / g / h 該当 を 余湖さん が 答えた 時 = 「次 から この タイプ は こう」 を §1.2 / §2 に 反映
- 自律 commit が revert された 時 = 軸 が 不足 / 誤 適用、 該当 軸 の check 規律 を 厳密 化
- 余湖さん が 「この 軸 ずれて る」 を 直接 指摘 した 時 = 該当 §を 上書き 修正
- 新規 source (= 新しい Q ratify / 新 規範 例) が land した 時 = §2 の 該当 軸 例 を 更新

メンテナンス 自体 も 「temporal 表現 を 残さ ず 上書き」 で。 過去 版 は git log で 辿れる、 prose 内 で 「previously 〜 だった」 と 書か ない。
