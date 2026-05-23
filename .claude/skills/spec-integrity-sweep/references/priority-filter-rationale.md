# Priority filter rationale

## 共通 base = unworklet core principles

unworklet が 目指す 姿、 守る べき 性質、 醜い と み なす もの は **`.claude/skills/_shared/core-principles.md` を 参照**。 spec-triage の `references/decision-axes.md` と 同 base file。 ここ で declare し直さ ない (= 二重 管理 NG)、 哲学 update は core-principles.md 1 か所 で 完結。

## 軸 = 「impl AI agent が手放し実装した時に矛盾 / 揺れが出るか重大度」

唯一の判断軸。 docs 読者 = impl AI agent (= user tutorial では ない、 累犯規律)。

## P1 — ship blocker (38〜45 件規模)

以下のいずれかに該当:
- **wire byte が drift**: main / worklet boundary で deserializer 不一致を起こす
- **canonical 自身が build 不能**: `12-canonical-examples.md` が type system rule を違反、 TS compile error
- **同 source code で別 impl が reproducible でない**: 同じ user code が impl ごとに pass / fail で別結果
- **realtime safety invariant 直結**: audio thread allocation 起動 / GC trigger / unbounded loop

cluster 例 (= P1 内並び順):
1. 型 system core
2. canonical integrity / Q ratify との衝突
3. snapshot blob byte 並 び (= ship 後 凍 結 領 域、 内 部 wire は scope 外)
4. handler / drain / boundary timing
5. realtime safety invariant
6. MIDI declaration + sysex inbound
7. state/buffer publish 衝突
8. snapshot / restore lifecycle
9. main 側 / offline / acceptance

## P2 — 仕様 invariant + lifecycle (50〜70 件規模)

以下のいずれかに該当:
- **public surface completeness**: API surface に method 抜け / type 抜け / 列挙不完全
- **mental model 整合性**: 同概念を別命名 / lifecycle state が観測 surface と zip しない
- **placeholder zip**: HTML comment placeholder が既 written prose と二重化 / 未 ratify 概念混入

P2 は file 順そのまま並べる (= cluster header ナシ)。 同 file で近接 entry を 1 度に edit するため。

## P3 — prose 揺れ / mechanical sweep (15〜25 件規模)

以下のいずれかに該当:
- **prose 表現揺れ**: 同概念を別 wording で表現するが impl AI は 1 意で読める
- **mechanical fix**: Status 文の Q範囲更新 / 「`Qxx` land 待ち」 表現 stale / Coverage table 行不一致

P3 は user grill 不要、 親が 1 batch で sweep。 commit 別単位で OK。

## scope 外 = sweep 時 entry に 出さ ない

以下 は sweep 時 そもそも entry と して 拾わ ない (= scope 外、 entry に 出 す と triage 側 で e 軸 close 寄り = sweep 段階 で 弾く 方 が 効率 的)。

- **TS form 細部 / 命名 / mechanism 自由 度** (= core-principles §2 「実装 期 任せ」 派生): TypeScript signature 細部 (= type alias 名、 generic constraint の 切り 方、 callable + property hybrid 等)、 同概念 の 別 命名 の どち ら を 別名 に 寄せる か、 internal mechanism の 実装 path 自由 度 (= main 側 event drain が MessageChannel / Atomics.notify / rAF の どれ か 等)。 仕様 invariant (= wire byte、 mental model、 API surface 形、 lifecycle) が 動 い て いる か を sub-agent prompt で 必ず check、 動 い て い ない なら 拾わ ない。
- **user-facing wording 揺れ** (= 既存 累犯 規律): tutorial / API reference / chooser doc 視点 の wording 揺れ は v1.0.0 ship 後 phase で 別途 処理。 sweep audit 範囲 外。
- **canonical で primitive / declaration 個別 hit ナシ = 規範 例 不足** (= core-principles §2 「canonical = curated 規範 例集」 派生): 個 別 primitive / declaration が `12-canonical-examples.md` で 1 回 も 動 か な い こ と を 「HARD CONTRACT 違 反」 「規 範 確 認 不 在」 と し て 拾 い 上 げ る path は **scope 外**。 AGENTS.md L16 「exercise the full surface」 を 機 械 網 羅 と 読 む の は 過 剰 解 釈、 curated 規 範 例 集 と し て full surface に 触 れ る 寄 り が 真。 example で hit ナ シ ≠ 仕 様 違 反。 sub-agent prompt で 「個 別 primitive の canonical hit 有 無」 を 拾 う 指 示 は 出 さ な い。 「仕 様 prose を 変 え た 結 果 affected example が 既 awkward / unrealistic に な る」 は HARD CONTRACT 範 囲 = 拾 う、 区 別 必 須。
- **main / worklet 間 の 内 部 wire layout** (= core-principles §2 「内 部 wire = 実 装 期 任 せ」 派 生): SAB ringbuffer slot 並 び、 event slot / MIDI slot field 並 び (= atSample 位 置 等)、 sysex content buffer 並 び 等 main / worklet 間 の 内 部 wire layout は **ship 後 凍 結 で は な い** = framework 同 ship 内 で main bundle / worklet bundle ペ ア = ship ご と に 自 由 = user 不 観 測。 「wire byte が drift」 「shared machinery」 「slot 並 び」 で 反 射 的 に 拾 い 上 げ る な、 user 観 測 surface (= handler arg shape / API surface / lifecycle observable) が 動 い て いる か を 必 ず check し、 動 か な い な ら scope 外。 ship 後 凍 結 さ れ る wire = `node.snapshot()` の Uint8Array blob 並 び の み = こ れ だ け が 真 の wire format 軸。

## 累犯規律 = 赤信号 wording

priority 判断中に以下の wording が自分の頭で出たら **赤信号** = 軸が user-facing に 流れた / 実装 AI 領域 に 流れた signal、 即修正:

- 「user が誤解する」 / 「user 学習 path」 / 「pattern doc 領域」 → user-facing 寄り = scope 外
- 「mental model が揺れる」 / 「読み手が混乱」 → user-facing 寄り = scope 外 ま た は P3 mechanical
- 「TS form の 書き方 が」 / 「命名 が 統一 さ れて ない」 / 「mechanism が impl ご と に drift」 → 実装 AI 領域 = scope 外
- 「canonical で 動 か な い」 / 「規 範 確 認 ナ シ」 / 「Coverage table 不 完 全」 / 「全 surface を 1 回 ず つ exercise」 / 「primitive 機 械 網 羅」 → canonical = curated 規 範 例 集 性 質 を 失 念 し た 過 剰 解 釈 = scope 外
- 「wire byte が drift」 / 「slot 並 び が doc 間 で 別」 / 「shared machinery 主 張 と 衝 突」 / 「same transport」 → 内 部 wire 層 で 止 ま っ て いる pattern。 user 観 測 surface (= handler arg / API surface / lifecycle) が 動 く か を 必 ず check、 動 か な い な ら scope 外 (= 内 部 wire = ship 後 凍 結 ナ シ = 実 装 期 任 せ)

これら 出 たら mechanical sweep 領域 (= P3) へ 移 す か、 そ も そ も sweep 時 entry に 拾 わ ず scope 外 と して 切 る か、 「impl AI 矛盾リスク 軸」 で 再 評価。

## docs 読者 = impl AI agent (= 累犯規律)

v1.0.0 ship 前の docs は impl AI agent が迷わず判断するための仕様。 user-facing docs (= getting started / API reference / tutorial) は v1.0.0 完成後の別 phase で作る、 audit 範囲外。

priority filter の真の軸:
> 「これを放置したら impl AI agent がどちらの rule を採用すべきか迷うか?」

- Yes (= 仕様 prose 内で矛盾 / dangling、 異なる agent が異なる judgment に達する) → P1 priority
- No (= wording rename / 表記揃え / user 読解違和感だが impl AI は 1 意で読める) → mechanical sweep 領域 (= P3)、 親 grill 不要

## P1 cluster sort の意義

P1 内は cluster 別 sort = ratify 順序の自然さ確保:
- 基礎 (型 system / canonical integrity) → boundary (wire format / handler drain) → 局所 (publish / snapshot / acceptance)
- 余湖さんが上から順に ratify を進めれば 「最も影響大」 から消化、 attention 経済 最適

P2 / P3 は cluster ナシで file 順 = 同 file の近接 entry を 1 度に edit / sweep するため。
