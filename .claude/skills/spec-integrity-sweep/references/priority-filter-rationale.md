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
3. wire format byte layout
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

## 累犯規律 = 赤信号 wording

priority 判断中に以下の wording が自分の頭で出たら **赤信号** = 軸が user-facing に 流れた / 実装 AI 領域 に 流れた signal、 即修正:

- 「user が誤解する」 / 「user 学習 path」 / 「pattern doc 領域」 → user-facing 寄り = scope 外
- 「mental model が揺れる」 / 「読み手が混乱」 → user-facing 寄り = scope 外 ま た は P3 mechanical
- 「TS form の 書き方 が」 / 「命名 が 統一 さ れて ない」 / 「mechanism が impl ご と に drift」 → 実装 AI 領域 = scope 外

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
