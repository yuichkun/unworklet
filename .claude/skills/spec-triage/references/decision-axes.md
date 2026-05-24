# spec-triage 決定 軸

`docs/open-questions.md` の 個別 entry を 「自律 で 直す」 「自律 で close」 「余湖さん 相談」 に 振り分ける ため の 軸 集。 spec-triage skill が 参照 する。

live document として 上書き で 更新 する。 temporal 表現 (= 「previously」 「now」 「retired」 等) を 書か ない。 新 決定 が 出る 度 に 該当 軸 を 直接 書き換え。

---

## 1. 共通 base = unworklet core principles

unworklet が 目指す 姿、 守る べき 性質、 醜い と み なす もの は **`.claude/skills/_shared/core-principles.md` を 参照**。 spec-integrity-sweep の `references/priority-filter-rationale.md` と 同 base file。

ここ で declare し直さ ない (= 二重 管理 NG)。 哲学 update は core-principles.md 1 か所 で 完結。

---

## 2. 個別 entry を 自律 / 相談 に 分ける 軸

入力 = `docs/open-questions.md` の 1 entry (= `## タイトル` + `**場所**:` + `**何 が 起きて いる か**:` + `**impl AI 影響**:` + `**判断 軸**:`)。

判別 順序 = a → b → c → d → e → f → g → h → i の 順 で hit すれば そこ で 確定。 hit せず i まで 到達 した entry は 軸 が 足り ない signal = §5 メンテナンス で 軸 自体 を 更新 する trigger。

### 自律 path (= a / b / c / d / e)

a-d = docs 修正 して commit。 e = docs 修正 ナシ で entry close + decisions-log に 1 行 ratify 追記。

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

#### c. core principles の 既 哲学 で 答え が 1 つ に 絞られる

**何 を 表す か**: `core-principles.md` §2 で declare した 守る べき 性質 を 個別 entry に 当てて、 path が 1 つ に 絞られる もの。

**派生 root の 典型**:

- 「declarative」 → framework auto-rewrite を 完全 列挙 義務、 暗黙 書き換え 追加 NG
- 「user free が default」 → 制約 を 入れる 方 が 例外、 「美学」 で 制約 を 自動 追加 し ない
- 「既知 必要 を 後回し に し ない」 → AI 並列 で 厚 化 できる もの 以外 defer NG
- 「mental model unification ≠ feature reduction」 → simpler mental の 名目 で feature を 削ら ず opt-in / namespaced で 解決
- 「実装 コスト で scope を 絞ら ない」 → 工数 だけ で 設計 を 曲げ ない

**check する 場所**:

- entry の 「判断 軸」 行 で core-principles §2 の どの 性質 と 一致 する path が 既 推奨 されて いる か
- core-principles §2 の 性質 を 個別 に 当てて path が 1 つ に 絞られる か (= 複数 哲学 が 衝突 する なら h に 落ちる)

**典型 fix**: 哲学 派生 path に prose を 揃える 1 commit、 適用 した core-principles §2 項目 を commit message に 引用。

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

#### e. 実装 AI 判断 領域 = 自律 close

**何 を 表す か**: entry が 提起 し て いる の が **TypeScript form 細部 / 識別子 命名 / internal mechanism 自由 度 だけ** で、 仕様 invariant (= mental model / wire byte / API surface 形 / lifecycle) が 動か ない もの。 spec docs に entry と して 残す 価値 ナシ。

**典型 source** (= 何 が 「実装 AI 判断」 か):

- TS type alias 名、 generic constraint の 切り 方
- callable + property hybrid form (= `{ (...): void; diagnostics: ... }` vs `{ .send(...): void; .diagnostics: ... }` 等)
- 同概念 の 別 命名 の どち ら を 別名 に 寄せる か (= enforcement layer vs integration layer の L1/L2/L3 命名 等)
- internal mechanism の 実装 path 自由 度 (= main 側 event drain が MessageChannel ping か Atomics.notify か rAF か)
- 別 entry の decide で 自動 解消 する もの (= 他 entry の 軸 hit が 解 け ば この entry も 解 け る pattern)
- **main / worklet 間 内 部 wire layout** (= SAB ringbuffer slot 並 び、 event slot / MIDI slot field 並 び、 sysex content buffer 並 び 等): framework 同 ship 内 で main bundle / worklet bundle ペ ア = ship ご と に 自 由 = user 不 観 測 = 仕 様 invariant 動 か ず = e 軸 で close (= ship 後 凍 結 さ れ る wire は `node.snapshot()` blob だ け、 内 部 wire は 別 軸)

**check する 場所**:

- entry が 触る surface に 仕様 invariant (= wire byte、 mental model、 API surface 形、 lifecycle) が 動 い て いる か → **動 い て いる なら e で は ない**、 f-i の 相談 軸 を 当 たる
- TS form / 命名 / mechanism の 細部 だけ で、 user 視点 から 観測 さ れる semantics が 動か ない か
- 別 entry の decide で 自動 解消 する pattern か (= cascade 解消)

**典型 fix**: docs 修正 ナシ。 open-questions.md か ら entry 削 除 + decisions-log.md に 1 行 ratify 追記 (= 「実装 AI 領域 と し て close、 仕 様 invariant 動 か ず、 form 細部 は 実装 期 任 せ」)。 commit message に decision-axes: e + 「仕様 invariant 動 か ず」 1 行 理由。

**例**:

- 「L1/L2/L3」 略称 衝突 = 命名 の どち ら を 別 命名 に 寄 せ る か = 実装 AI 判 断 (ただ し error message label に 露 出 す る な ら h 軸 寄 り)
- `forSample.byN` function + property hybrid = TS form 細部、 canonical で `forSample.byN(...)` が 動 く invariant 維 持 で 内 部 form 自 由
- `node.messages.<name>` callable + property 同居 surface 構造 = TS form 細部 (ただ し 構 造 分 解 後 観 測 path が user 視 点 で 動 く な ら h 軸 寄 り)
- 同名 input/output の overflowCount counter 由来 = MIDI declaration name 必須性 decide で 自動 解消 (= cascade)
- SAB mode event drain mechanism = MessageChannel / Atomics.notify / rAF の どれ も 観測 ル ー ル を 満 たす = mechanism 自由 度
- **main / worklet 間 内 部 wire layout** (= event slot / MIDI slot で atSample 位 置 が 別、 variable-length 中 身 並 び 方 が event と MIDI sysex で 別、 sysex slot に atSample 不 在 等): user 観 測 surface (= handler arg shape / API surface / lifecycle) が 動 か な い 限 り 内 部 wire 並 び は framework ship ご と に 自 由 = 実 装 AI 領 域

### 余湖さん 相談 必要 (= f / g / h / i)

入力 が 客観的 に は 揃わ ない + 後戻り 不可 / 趣味 余地 の もの。 batch で 相談 md (= `$TMPDIR` 下 の grill md) に まとめて 余湖さん に 渡す。 1 相談 md = 1 entry または 同 trade-off の 数 entry を 束ねる。

#### f. 過去 の 決定 を 撤回 する 必要 が ある

**何 を 表す か**: docs 内 既 ratify Q を 撤回 し ない と 残り の 矛盾 が 解け ない、 かつ 撤回 path が core-principles §2 哲学 で は 一意 に 出 ない もの。

**な ぜ 自律 不可**: 仕様 retract = 既 ratify を rejected として 残す ≒ 過去 自分 の 判断 を 修正 する 操作。 v1.0.0 前 = 仕様 直す コスト ≪ 実装 直す コスト で retract 自体 は OK だ が、 retract path が 複数 等価 で 残る 場合 は 余湖さん が decide する 領域。

**check する 場所**:

- entry が 既 ratify Q番号 と 直接 衝突 する か
- 撤回 path が core-principles §2 哲学 で 一意 か (= 一意 なら c 寄り、 等価 解 が 残る なら f)
- 撤回 すると cascade で 他 Q も 動く か (= 動く なら 影響 範囲 を 相談 md に 含める)

**典型 出し 方**: 撤回 必要 な Q番号 + 撤回 path 候補 を 相談 md に 列挙、 各 path の trade-off を 並べ、 余湖さん 判断 待ち。

**例**:

- `event<T>` payload で float 値 受容 (= Q46 撤回 必要、 撤回 path 3 way 等価)

#### g. ship 後 変え 不可 な byte 並び (= `node.snapshot()` blob だけ)

**何 を 表す か**: **`node.snapshot()` の Uint8Array blob byte 並 び の み**。 user が persist し て 新 ship で restore す る path = ship 後 互 換 性 で 凍 結 + migration mandatory 領 域。

**main / worklet 間 内 部 wire は g 軸 で は な い**: SAB ringbuffer slot 並 び、 event slot / MIDI slot field 並 び (= atSample 位 置 等)、 sysex content buffer 並 び 等 は framework 同 ship 内 で main bundle / worklet bundle ペ ア = ship ご と に 自 由 = user 不 観 測 = **e 軸** (= 実 装 AI 領 域)。 「wire byte 並 び」 と い う wording で 反 射 的 に g 軸 に 寄 せ な い、 「user が persist す る か」 (= snapshot blob か どう か) を 1 ヶ 所 で check。

**な ぜ 自律 不可** (= snapshot blob 限 定): ship 後 互換 = 1 度 出 し た byte 並 び は v1.x.0 で 戻 せ ず、 v2.0.0 で migration mandatory。 「あ と で 直 せ ば 良 い」 が 効 か な い 領 域 で、 余 湖 さ ん 視 認 必 須。

**check する 場所**:

- entry が `node.snapshot()` blob byte 並 び を 触 る か (= main 側 で user が persist す る Uint8Array)
- entry が main / worklet 間 内 部 wire (= SAB ringbuffer / event slot / MIDI slot / sysex content buffer) を 触 る だ け な ら **e 軸 寄 り** (= user 観 測 surface 動 か な い な ら e 軸 close)

**典型 出し 方**: snapshot blob byte 並 び 候 補 を A / B / C 表 で 相 談 md、 各 候 補 の blob 形 + migration path を 図 化、 余 湖 さ ん decide。

**例**:

- snapshot blob の field 並 び (= state slot 値 / buffer 内 容 / metadata 並 び 順、 migration semantics)
- migration 関 数 が catch す る blob 形 (= 旧 ship blob → 新 ship blob 変 換 入 出 力)

#### h. UX / 美学 で 複数 解 が 等価 (= 仕様 invariant が 動く 寄り)

**何 を 表す か**: 複数 path が core-principles §2 哲学 / 外部 標準 で 等価、 user に 観測 さ れる semantics (= 公開 動作、 error fallback、 lifecycle observable) で 余湖さん 趣味 が 入る もの。

**注 意**: 命名 / TS form 細部 だ け で semantics が 動 か な い も の は **e (= 実装 AI 領域)** に 倒 れ る。 h は 「user 視点 で 観測 さ れ る 振る舞い が 候補 ご と に 別」 の 場合 限定。

**な ぜ 自律 不可**: 「美学」 「対称性」 で 自動 化 する と core-principles §3 醜い と み なす もの (= artificial 制約) 違反。 余湖さん 主観 で 趣味 を 反映 する 領域 で、 勝手 に 一つ 採用 し ない。

**check する 場所**:

- path が core-principles §2 哲学 で 等価 か (= a-d で 出 ない か)
- user 視点 で 観測 さ れる semantics が 候補 ご と に 別 か (= 別 = h、 form だ け 違 う = e)
- 「複数 哲学 が 衝突」 で c 不可 に なる ケース が 多 い

**典型 出し 方**: 等価 path を 並べた 相談 md、 各 path の user 視点 trade-off を 明示、 余湖さん 推奨 待ち。

**例**:

- render quantum 不一致 時 動作 (= silence + onError か process return false か onError 発火 後 silence か、 = user 観測 audio output が 別)

#### i. 規範 例 の 大規模 改変

**何 を 表す か**: `12-canonical-examples.md` の 既 Ex を 数 十 行 規模 で 拡張 / 改変、 または 新 Ex を 立てる もの。 AGENTS.md HARD CONTRACT (= canonical 整合 性 視認) を 直接 触る。

**な ぜ 自律 不可**: canonical = 全 仕様 の 規範 確認 anchor、 大 改変 は 余湖さん 設計 視認 領域 (= AGENTS.md 明言 「out of process」)。 小 改変 (= 既 Ex の 1-5 行 code / 数 行 prose) は a / b 寄り だが、 数 十 行 規模 は i。

**閾値**:

- 1 Ex に 数 十 行 追加 / 新 Ex 1 件 立てる → i
- 既 Ex の 1-5 行 code 修正 / 数 行 prose 揃え → a / b

**check する 場所**:

- entry が canonical の Coverage table の どの 行 を 動かす か
- code 追加 規模 を 行数 概算

**典型 出し 方**: 改変 / 新規 Ex の design draft を 相談 md に 提示、 数 十 行 分 の code 案 を 含めて 余湖さん decide。

**例**:

- Ex 5 grain spawn voice allocation 全 unroll (= 12 冒 頭 「no elisions」 self-rule 直 接 違 反 を 解 消、 数 十 行 追 加)
- 仕 様 prose 変 更 で 既 Ex が awkward / unrealistic に な る 場 合 の Ex rewrite

**scope 外** (= こ の 軸 で 拾 わ な い):

- canonical で 個 別 primitive / declaration が hit ナ シ (= 例: 「SIMD primitive vec4 / subVec / divVec / vec.lane が canonical で 動 か な い」) — `12-canonical-examples.md` は curated 規 範 例 集 で あ り 機 械 網 羅 で は な い (= core-principles §2 + AGENTS.md L16 「exercise the full surface」)。 個 別 primitive が hit ナ シ = 規 範 例 不 足 ≠ 仕 様 違 反、 entry に 立 つ こ と 自 体 が 過 剰 解 釈。 万 一 sweep で 拾 わ れ た 場 合 は 即 close (= 「entry 立 て が rule 過 剰 解 釈」 path)、 軸 i で 相 談 md を 出 さ な い。

---

## 3. 自律 で 直す 時 の commit 規律

### a / b / c / d (= docs 修正 commit)

各 commit の message に 以下 を 必ず 含める:

```text
docs(<scope>): <変更>

decision-axes: <a | b | c | d>
基づく: <docs 行 引用 / Q番号 / core-principles §2 項目 名 / 外部 標準 link>
理由: <1 行 で なぜ この 軸 で 答え 一意 か>
```

### e (= entry close commit = docs 修正 ナシ)

entry を open-questions.md から 削除 + decisions-log.md に 1 行 ratify 追記 + commit。 docs/\*.md (= 00-foundations.md 等) は 触らない。 commit message:

```text
docs(open-questions): <短 タイトル> を 実装 AI 領域 と して close (Q<新番号>)

decision-axes: e
基づく: core-principles §2 「TS form 細部 / 命名 / mechanism 自由 度 = 実装 期 任せ」
理由: <1 行 = 仕様 invariant が 動か ない 根拠 + 別 entry cascade 解消 の 場合 は 該当 entry を 引用>
```

decisions-log.md の Q追記 form:

```text
| Q<番号> | <短 タイトル> | resolved — 実装 AI 判断 領域 と して close。 <1-2 行 で 「TS form / 命名 / mechanism 自由 度 だけ、 仕様 invariant 動か ず」 の 根拠>。 form 細部 は 実装 期 の AI agent が 機械 的 に decide | (= 関連 file path、 ナシ なら 空) |
```

### 余湖さん の audit path

余湖さん は `git log --oneline` + commit body で 流し 読み audit。 軸 が 雰囲気 で 当てられて いれば revert candidate。 revert は 「軸 自体 が 不足 / 誤 適用」 の signal で、 §5 メンテナンス trigger。

---

## 4. 相談 の 出し 方

各 相談 (= f / g / h / i 適用) は `$TMPDIR` 下 に 1 相談 md を 出す。 1 md の 構造:

```text
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

軸 = f / g / h / i の どれ か を 相談 md 末尾 に 1 行 添え (= 余湖さん が 「これ は i か、 大規模 改変 だ な」 等 と 即 認識 できる)。

余湖さん 回答 後 = 該当 docs 反映 + decisions-log Q 追記 + open-questions entry 削除 を 1 commit。 同時 に 「次 から この タイプ は こう」 を core-principles.md (= 哲学 update なら) または §2 軸 a-e (= 軸 例 update なら) に 追記 (= 軸 が 育つ)。

---

## 5. メンテナンス

このファイル は live document。

更新 trigger:

- f / g / h / i 該当 を 余湖さん が 答えた 時 = 「次 から この タイプ は こう」 を core-principles.md または §2 に 反映
- 自律 commit が revert された 時 = 軸 が 不足 / 誤 適用、 該当 軸 の check 規律 を 厳密 化
- 余湖さん が 「この 軸 ずれて る」 を 直接 指摘 した 時 = 該当 §を 上書き 修正
- 新規 source (= 新しい Q ratify / 新 規範 例) が land した 時 = §2 の 該当 軸 例 を 更新
- 哲学 自体 が 動 い た 時 = core-principles.md を 修正 (= こ の file 内 で は 例 / 引 用 だ け 更 新)

メンテナンス 自体 も 「temporal 表現 を 残さ ず 上書き」 で。 過去 版 は git log で 辿れる、 prose 内 で 「previously 〜 だった」 と 書か ない。
