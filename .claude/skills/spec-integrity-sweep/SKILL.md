---
name: spec-integrity-sweep
description: unworklet v1.0.0 spec 全 docs の整合性を 12 軸 sub-agent 並列 audit + raw 隔離 + priority 別並び替えで `docs/open-questions.md` に zip する大規模 process。 「全 docs 整合性監査して」 「open-questions.md に挙げる issue を全部 harvest して」 「spec 全体に矛盾 / 揺れ / 仕様 hole がないか徹底チェック」 「複数観点で sub-agent に検査させて並び替えて」 「整合性 sweep」 「spec audit 回して」 等の trigger で必ず起動。 open-questions.md が空 / ratify 進んで肥大化したタイミングでの再実行 path 想定。 軽い grep-base 確認や 1〜2 file の整合性 check では起動せず、 全 docs 規模の徹底 audit でのみ走る。
---

# spec-integrity-sweep

unworklet docs 全体の整合性を多数の sub-agent で徹底 audit し、 結果を 1 つの優先度付き `docs/open-questions.md` に zip するプロセス。 v1.0.0 ship 前の spec を impl AI agent が矛盾なく実装できる状態に追い込むためのもの。

## 1. このスキルが扱う対象 + 想定タイミング

**対象**: `docs/` 配下の全 spec markdown (= `00-foundations.md` 〜 `13-offline-render.md` + `decisions-log.md` + `12-canonical-examples.md`)。 v1.0.0 ship 前の live document。

**出力**: `docs/open-questions.md` の整理済み entry 群 (= 冒頭 preface + P1 / P2 / P3 section + 各 entry を軸 cluster 別 sort)。

**起動タイミング**:
- open-questions.md が empty / 軽い状態 で 「もう一度 spec 全体を見直して残 question を洗い出したい」 と user が判断した時
- 大量 ratify が land して spec が変化した後の整合性 sweep
- v1.x.0 / 別 phase で同 path を回す時

**起動しない場合**:
- 1〜2 file の局所整合性確認 (= 通常の grep / Read で済む)
- 単発の Q ratify grill (= `$TMPDIR` の grill md path)
- 既に audit 済みで残 task が priority 別に整理されている時の進行

## 2. 観点軸 (= default 12 軸)

各軸 1 sub-agent を並列 dispatch。 user が削除 / 追加 / rename 可能。

1. **型 system 整合** — `Node<T>` / `Buffer<T>` / `State<T>` / `Param` 等の generic 並び + literal lift rule + ScalarType 集合
2. **越境表現整合** — build-time / audio-thread / main-thread 境界、 per-block / per-sample / handler-body の lexical scope
3. **realtime-safety invariant matrix** — 5 invariant (no alloc / no unbounded / no throw / no I/O / no GC) × 4 enforcement layer (TS / capture / static / emission / runtime guard)
4. **canonical-examples integrity** — `docs/12-canonical-examples.md` 全 example の prose / code / Coverage table 整合
5. **messaging wire format** — ringbuffer header / slot layout / variable-length payload / SAB vs postMessage fallback / Atomics protocol
6. **snapshot/restore/migrations** — snapshot blob format / RestoreResult / migration chain / replaceProcessor / inspect free function
7. **scope rule + 命名 + import path** — declaration scope / expression scope / handler context / export 命名 / subpath import
8. **Q-ref 引用整合** — decisions-log 内 Q番号引用が現存 + 内容一致、 Status 文 / summary table の zip
9. **placeholder 整合** — `<!-- placeholder -->` HTML comment と既 written prose の二重化 / 未 ratify 概念混入
10. **SIMD surface** — vec primitive 列挙 / canonical exercise / stride check / generic `Buffer<T>`
11. **main-thread typed surface** — `UnworkletNode<C>` / `.params` / `.state` / `.events` / `.messages` / `.midi` / `.outputs` / `.inputs` / `.onError` / `dispose`
12. **test / offline determinism** — `@unworklet/offline` config / matcher / acceptance criteria / bit-exact 約束 / browser smoke

各軸詳細 (= 対象 file / 重点 prose / 典型 issue 形) = `references/12-axes-default.md`。

## 3. 実行 process (= 7 Phase)

### Phase 1: 観点軸の並列 dispatch

12 sub-agent を **1 message 内で並列 batch** に Agent tool で起動 (= `subagent_type: general-purpose`)。

各 sub-agent の prompt 構造 (= `references/sub-agent-prompt-template.md` 参照):
- 軸名 + 該当 docs path 列挙
- 「bias 排除規律」 を冒頭で明示 (= 余湖さん明言の 「重要な欠陥を見つけることがプロダクトにとっての最善」)
- **出力先**: Write tool で `audit/raw/NN-<axis>.md` に raw report を**直接書く** (= Phase 2 と zip、 parent context に raw を流さない)
- 出力 format = entry の 4 段構造 (`## タイトル` + `**場所**:` + `**何が起きているか**:` + `**impl AI 影響**:` + `**判断軸**:` + `---`)
- parent message への返事 = **path + 件数 + 一言補足だけ** (= raw report 本体は parent context に流さない)
- scope 外: 仕様 ratify 済 Q への異議 / user-facing 視点の wording 揺れ

**重要**: sub-agent に 「grep で拾い読み」 させない。 全文 read + 文脈判断必須 (= memory feedback、 累犯規律)。

### Phase 2: raw report の file 隔離

**親 context 経由で raw を手書き写すのは絶対 NG**。 余湖さん明言: 「cp で写した方が確実」。

**primary path: sub-agent に直接 Write させる** (= Phase 1 と zip)

Phase 1 で sub-agent prompt に Write tool 経由の出力先を明示 (= `audit/raw/NN-<axis>.md`)、 parent message には path + 件数だけ返させる path。 これで parent context が膨張せず、 機械 cp 同等の隔離が Phase 1 と同時に実現する (= invocation 数増えない、 jq path 不要)。

**fallback path** (= sub-agent が直接 Write せず raw を parent message に返してしまった場合):

JSONL log + jq 機械抽出。 各 sub-agent の `tool_use_id` を親が記録し、 session JSONL log から抽出 script で raw を取り出す (= `references/jsonl-extraction.md` 参照)。 環境依存 + 後追い path で primary より弱い。

### Phase 3: serial filter + 統合 + 重複 skip

raw 各 file を **sub-agent serial dispatch** で 1 つずつ処理。 並列だと open-questions.md write 競合発生 (= memory feedback)。

各 sub-agent の責務:
- 担当 raw file 全文 read
- 既 open-questions.md 全文 read (= 重複判定の base)
- 1 entry ずつ filter (= 「impl AI 矛盾リスク軸でない」 / 「既 open-questions.md entry と重複」 = skip)
- 必要なら統合 (= 複数 raw entry を 1 entry に zip)
- open-questions.md 末尾に追記
- 完了報告: 「追加 N 件 / skip M 件 (内訳: 非軸 X / 重複 Y) / 統合 N→M 件」

注: 「sub-agent が脳内で重複排除する」 のはサボり。 必ず既 open-questions.md 全 entry を read してから 1 件ずつ照合。

### Phase 4: 親 priority 判断

**sub-agent 丸投げ NG**。 親が全 entry を文脈込みで 1 件ずつ判断する。

軸 = **「impl AI agent がこの docs だけで手放し実装した時に矛盾 / 揺れが出るか重大度」** (= 唯一の判断軸、 累犯規律)。

3 段階:
- **P1**: ship blocker (= wire byte が drift / canonical 自身が build 不能 / 同 source code で別 impl が reproducible でない)
- **P2**: 仕様 invariant + lifecycle (= public surface completeness / mental model / placeholder zip)
- **P3**: prose 揺れ / mechanical sweep (= 親 batch sweep 後 diff review 領域)

**赤信号** (= priority 軸が user-facing に流れた signal):
- 「user が誤解する」 「mental model 揺れる」 「読み手が混乱」 wording が頭の中に出たら 即 priority 軸を修正、 mechanical sweep 領域 (= P3) へ移す
- docs 読者 = impl AI agent (= user-facing tutorial では ない)、 累犯規律

P1 内では軸 cluster で sort (= 例: 型 system core / canonical integrity / wire format / handler drain / realtime safety invariant / MIDI declaration + sysex / publish 衝突 / snapshot lifecycle / main-offline-acceptance)。

詳細 = `references/priority-filter-rationale.md`。

### Phase 5: 並び替え機械実行

親が 「entry タイトル先頭文字列 → P1/P2/P3 + cluster」 mapping を 1 sub-agent に渡して file rewrite を機械実行。

sub-agent 制約:
- entry 本文 prose は **1 文字も触らない** (= 並び順 + section header + preface 追加のみ)
- 全 entry を 1 つも skip しない、 1 つも duplicate しない
- 完了報告: P1/P2/P3 件数 + cluster 件数 + missing/duplicate 確認

### Phase 6: trust but verify

sub-agent 完了報告は信用 + 必ず file 構造で cross-check:

```bash
# header 数
grep -c '^## ' docs/open-questions.md   # = 3 section + N entry
grep -c '^### ' docs/open-questions.md  # = P1 cluster 数
grep -c '^---$' docs/open-questions.md  # = N entry + preface 末 + 既存重複あれば +α
wc -l docs/open-questions.md

# section 位置
grep -nE '^## P[123] ' docs/open-questions.md

# preface 反映確認
head -15 docs/open-questions.md
```

### Phase 7: commit + clean up

- `audit/` 削除 (= `rm -rf audit/`、 untracked working directory)
- `git add docs/open-questions.md`
- commit (= subject "docs(open-questions): 全 文 audit で N entry 追 加 + priority 別 並 び 替 え" + body で軸列挙 + P1/P2/P3 件数 + Co-Authored-By line)

## 4. 行動規律 (= memory feedback の集約)

### sub-agent への bias 排除規律

sub-agent prompt の冒頭で必ず明記:

> 君の責務は不整合 / 矛盾 / dangling / 揺れの徹底的な抽出。 「これ問題ない」 結論バイアス禁止、 エコ贔屓禁止。 user (= 余湖さん) は 「重要な欠陥を見つけることがプロダクトにとっての最善」 と明言。 仕様 ratify 済 Q への異議や user-facing 視点の wording 揺れは scope 外。 spec docs 全文を文脈込みで read し (= grep 拾い読み不可)、 1 entry ずつ format 通りに report。

### sub-agent に grep base で指示するな

各 sub-agent に 「全文 read + 文脈判断」 を依頼。 grep regex / 拾い読み path はサボり = NG (= memory feedback 累犯規律)。 各軸 1 sub-agent + 並列 batch で徹底を担保。

### raw report の file 隔離 = 親 context 経由手書き NG

余湖さん明言: 「cp で写した方が確実」、 「ファイル書き出しとかしながら漏れがないように」。 110+ 件規模だと親脳内 dedupe は必ず見落とし発生。 機械 cp 同等 (= JSONL log jq) or sub-agent 直接 write path で隔離。

### priority 判断 = 親 文脈込み判断

「user が誤解する」 wording 出たら赤信号 = priority 軸を修正。 唯一の判断軸 = 「impl AI agent が手放し実装した時に矛盾 / 揺れが出るか」。

### entry 本文 prose は並び替え phase で非変更

並び順 + section header + preface 追加のみ。 entry の中身 prose は 1 文字も触らない (= 並び替えと中身整形を 1 phase に混ぜると、 中身整形で意図 drift する)。

### file 構造 verify を必ず実行

sub-agent 完了報告は trust but verify。 grep / wc で header 位置 / 行数 / `---` 数を cross-check。 missing / duplicate ゼロを確認してから commit。

### pause-before-commit

並び替え完了後、 commit する前に user に diff review opportunity を提示する。 余湖さんが 「commit して」 指示出すまで pause。

## 5. 出力 file 形式 (= 規範)

```markdown
# Open questions

unworklet v1.0.0 spec が impl AI agent によって矛盾なく実装されるための残 grill 項目。 ratify されたら `decisions-log.md` に移してこの file から削る。

全 N entry、 priority 軸 = 「impl AI agent がこの docs だけで手放し実装した時に矛盾 / 揺れが出るか」 重大度。

- **P1 = X 件**: ship blocker (= wire byte が drift / canonical 自身が build 不能 / 同 source code で別 impl が reproducible でない)
- **P2 = Y 件**: 仕様 invariant + lifecycle (= public surface completeness / mental model / placeholder zip)
- **P3 = Z 件**: prose 揺れ / mechanical sweep (= 親 batch sweep 後 diff review 領域)

---

## P1 — ship blocker 系 (X 件)

### cluster (1) 型 system core (n)

## <entry title>

**場所**: `docs/XX.md:LL`、 ...

**何が起きているか**: <1-3 文で矛盾 / 揺れ>

**impl AI 影響**: <1-2 文で impl drift path>

**判断軸**: <ratify 時の入り口、 推奨方向あれば 1 言>

---

[次 entry]

...

## P2 — 仕様 invariant + lifecycle (Y 件)

[entry をそのまま file 順で並べる、 cluster header ナシ]

## P3 — prose 揺れ / mechanical sweep (Z 件)

[entry をそのまま file 順で並べる、 cluster header ナシ]
```

## 6. references/

- `references/12-axes-default.md` — 12 軸 default の各軸詳細 (= 対象 / 重点 prose / 典型 issue 形)
- `references/sub-agent-prompt-template.md` — Phase 1 / Phase 3 / Phase 5 用 sub-agent prompt template
- `references/priority-filter-rationale.md` — P1/P2/P3 軸の rationale + 累犯規律
- `references/jsonl-extraction.md` — Phase 2 用 jq 機械抽出 script + path 設計

全部 SKILL.md に embed すると ~1000 行で読みづらいので references/ に分離。 Phase ごとに必要な reference だけ read する path。
