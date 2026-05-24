# Sub-agent prompt templates

Phase ごとに sub-agent dispatch の prompt template を集約。

## Phase 1: 観点軸 dispatch (= raw report 生成 + 直接 Write)

各 sub-agent に同一 base prompt + 軸ごとに inject。 **重要**: sub-agent が raw report を直接 `audit/raw/NN-<axis>.md` に Write する。 parent message に raw 本体を返さない。

```
あなたは unworklet v1.0.0 spec の 「<軸名>」 観点で全文 audit する agent。

# 責務
不整合 / 矛盾 / dangling / 揺れ / 仕様 hole を徹底的に抽出する。

# bias 排除規律 (= 余湖さん明言)
「これ問題ない」 結論バイアス禁止。 エコ贔屓禁止。 「重要な欠陥を見つけることがプロダクトにとっての最善」 (user 直接明言)。 真摯に矛盾 / 揺れを抽出すること。

# scope 外 (= report しない)
- 仕様 ratify 済 Q への異議
- user-facing 視点の wording 揺れ (= docs 読者 = impl AI agent、 user tutorial では ない)
- 単純な typo / 表記ゆれ (= mechanical sweep 領域、 audit 対象外)

# 対象 file
<file path 列挙>

# 重点 prose
<重点 prose 列挙、 references/12-axes-default.md 該当軸より>

# 出力先 (= 重要)

raw report 本体を Write tool で `/Users/yuichkun/workspace/unworklet/audit/raw/<NN>-<axis>.md` (= 例: `01-type-system.md`) に**直接書き出す**。

parent message への返事は以下だけ:
- file path
- entry 件数
- 一言補足 (= 例えば 「重点 prose A は cover、 B は scope 外で skip 等」)

raw report 本体を parent message には絶対に流さない (= parent context 膨張防止)。

# raw report の format

各 issue を以下の 4 段構造で 1 entry に zip。 末尾に `---` separator。 file 内では entry を順に並べる。

\`\`\`
## <平易日本語タイトル>

**場所**: `<file>:<line>`、 `<file>:<line>` (複数列挙可)

**何が起きているか**: <1-3 文で矛盾 / 揺れ / dangling を具体的に>

**impl AI 影響**: <1-2 文で impl が drift する path を具体的に>

**判断軸**: <ratify 時の入り口、 推奨方向あれば 1 言>

---
\`\`\`

# 規律
- 全 file 全文 read (= grep 拾い読み NG)
- 文脈込みで判断
- 1 issue = 1 entry、 統合 / 整理は親が後で行う
- 重大度判定は不要 (= 親が priority 判断する)
- 結果のみ output、 余計な前置きナシ
```

## Phase 3: filter + 統合 + 重複 skip (= serial dispatch)

各 sub-agent を **serial** で dispatch (= 並列だと open-questions.md write 競合)。

```
あなたは raw audit report file `/Users/yuichkun/workspace/unworklet/audit/raw/<NN>-<axis>.md` を filter + 統合 + 重複 skip して `docs/open-questions.md` に追記する agent。

# 入力
- raw file: `audit/raw/<NN>-<axis>.md`
- 既 open-questions.md: `docs/open-questions.md`

# 責務
- raw file を全文 read
- 既 open-questions.md を全文 read (= 重複判定の base)
- 1 entry ずつ評価:
  - filter: 「impl AI 矛盾リスク軸でない」 (= user-facing wording 揺れ / 仕様 ratify 済 Q への異議) → skip
  - 重複: 既 open-questions.md に同じ趣旨の entry あり → skip
  - 統合可能: 別 axis の sub-agent も同 issue を report していそう → 1 entry に zip
  - その他: open-questions.md 末尾に追記
- 完了報告:
  - 追加 N 件
  - skip M 件 (= 内訳: 軸外 X / 重複 Y)
  - 統合 P → Q 件

# 規律
- 親脳内 dedupe NG (= sub-agent 自身が既 open-questions.md を全文 read してから照合)
- 追記時に format (= `## タイトル` + 4 段構造 + `---`) を維持
- 結果のみ output、 余計な前置きナシ
```

## Phase 5: 並び替え機械実行 (= 1 sub-agent で全 file rewrite)

```
あなたは `docs/open-questions.md` を並び替える機械実行 agent。

# 入力
- file: `docs/open-questions.md`
- priority mapping (= 親が提示):
  - P1 = ship blocker (X 件): <entry タイトル先頭文字列の列挙 + cluster 分け>
  - P3 = prose 揺れ (Z 件): <entry タイトル先頭文字列の列挙>
  - P2 = 残り (Y 件): = file 順そのまま

# 責務
- 全 file を chunked read (= 25k token 上限注意、 1415 行なら 4 chunks 程度)
- 全 entry の `## タイトル` を mapping と照合
- file 全文を以下 order で rewrite:
  - 新 preface (= 規範 form は SKILL.md §5)
  - `## P1 — ship blocker 系 (X 件)` + cluster header + P1 entries
  - `## P2 — 仕様 invariant + lifecycle (Y 件)` + P2 entries (= file 順)
  - `## P3 — prose 揺れ / mechanical sweep (Z 件)` + P3 entries (= file 順)

# 制約
- entry 本文 prose は **1 文字も触らない** (= 順序入れ替えだけ)
- 全 entry を 1 つも skip しない、 1 つも duplicate しない
- missing / duplicate あれば親に報告

# 完了報告
- P1 cluster 件数
- P2 / P3 件数
- missing / duplicate confirm
- 最終 file 行数
- 既存重複 separator 等の特殊 case 検出
```
