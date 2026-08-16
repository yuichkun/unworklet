---
name: adversarial-review-loop
description: unworklet の実装コードを、独立した subagent 群による批判的レビュー → agent 自身のトリアージ → 判断が要る項目だけ余湖さんに質問 → TDD で自律 fix → 再レビュー、を「指摘ゼロ or トリアージ結果が要対応ゼロ」に収束するまで回す収束ループ。「バッチレビューして」「adversarial review 回して」「codex-review-loop と同じ手法で」「コードベース全体を客観的に見てもらって」「実装を徹底的に監査して」「review loop 回して」「収束するまでレビュー」「subagent に客観レビューさせて」等で必ず起動。単一実装者バイアス・八百長テスト・既存バグを独立視点で潰すためのもの。対象は実装コード (packages/*/src)。判断基準はプロダクトの方向性 (設計時の spec 文書は削除済みで、照合先は実装と `skills/unworklet/`)。1〜2 file の軽い確認や grep ベースの check では起動せず、コードベース規模の批判的監査ループでのみ走る。
---

# adversarial-review-loop

実装コードを独立 subagent 群で批判的にレビューし、agent が triage し、判断が要る所だけ余湖さんに聞き、TDD で直し、再レビューする。これを収束するまで繰り返す。

対象は `packages/*/src` の実装コード。判断の主基準は `../_shared/core-principles.md` (プロダクトの方向性)。

## なぜこの形か

実装したコードには **単一実装者バイアス**が残る。書いた本人は「正しいはず」の前提を持っているし、自分で書いた test はその前提を共有しているので、八百長 (実装を後追いするだけで regression を catch しない test) を自力で見つけにくい。だから:

- **独立した目** が要る。観点別に subagent を並列展開し、最近の差分に限定せずコードベース全体を批判的に読ませる。
- **批判的 verify** が要る。reviewer の finding には誤検出も hallucination も混ざる (実例: 存在しないファイルを指摘した reviewer がいた)。独立 skeptic に REFUTE を試させて落とす。
- **agent 自身の triage** が要る。verify を通った finding も鵜呑みにせず、重要なものは自分でコードを当てて確認する。subagent の verdict は二次情報。
- **聞くのは判断フォークだけ**。明確なバグを一々確認するのは余湖さんの時間の浪費。設計・scope 判断だけ聞く。
- **収束** が要る。1 周で全部は出ない。指摘が尽きるまで回す。

## 起動条件

- **走る**: 「全体を客観的にレビューして」「バッチレビュー」「徹底監査」「収束するまで review」など、コードベース規模の批判的監査の依頼。実装が一段落した節目 (大きい機能を入れた後、merge 前など)。
- **走らない**: 1〜2 file の局所確認、grep ベースの軽い check、単発の質問対応。

## 前提

- VitePlus プロジェクト (`vp` コマンド)。**全コマンドは `vp test run`（watch ではなく）+ timeout 付き** で囲む。`vp check` で typecheck + lint + fmt。詳細は `../_shared/core-principles.md` と AGENTS.md。
- multi-agent orchestration を使う = Workflow tool を起動してよい (このループはまさにその opt-in)。

---

## 収束ループ

```
  ┌─────────────────────────────────────────────────────┐
  │ Phase 1  batch adversarial review (Workflow)         │
  │ Phase 2  triage (agent 自身、コードを当てる)         │
  │ Phase 3  判断フォークだけ ask-user-style で質問       │
  │ Phase 4  全回答揃ったら TDD で 1対応1commit 自律 fix  │
  │ Phase 5  再レビュー (= Phase 1)                       │
  │ Phase 6  収束判定 → 未収束なら 1 へ                  │
  └─────────────────────────────────────────────────────┘
            収束したら → Phase 7  playground で一緒に動作確認を提案
```

### Phase 1 — batch adversarial review

観点別 subagent を Workflow で並列展開 → dedup → 各 finding を独立 skeptic が verify。

`references/review-workflow.js` が実証済みの Workflow script。同じ repo の再レビューならそのまま使い、コードベースが大きく変わったら観点 (`DIMENSIONS`) と対象 path だけ調整する。Workflow tool に `script` で渡すか、`scriptPath` でこのファイルを指して起動する。

**バイアスを一切注入しない**のが核。subagent には「このライブラリは何か」「守るべき invariant は何か」という**事実 context だけ**渡し、「ここは検証済み」「ここは正しいはず」という評価は決して刷り込まない。むしろ「壊れている前提で疑え、code を根拠 (file:line) に示せ、憶測禁止」と adversarial stance を取らせる。reviewer は最近の差分ではなくコードベース全体を全文読みで見る (grep 拾いはサボり)。

**照合先は「動くもの」** (`../_shared/core-principles.md` §1)。振る舞いの正本は実装で、それを説明する唯一の面が `skills/unworklet/` (例が CI で compile され、guidance-dogfood で実装と突き合わせ済み)。実装を駆動した設計時の spec 文書群は削除済みなので、「spec と違う」という finding 分類自体が存在しない。code と guide が食い違ったらそれは本物の finding だが、どちら側が悪いかは guide literalism ではなく**プロダクトの方向性**で判定する (最終判定は Phase 2 の triage)。

観点の既定セット (`review-workflow.js` の `DIMENSIONS`): realtime-safety / memory-layout / concurrency-SAB / wire-format / graph-capture / type-contract / test-integrity / lifecycle-resource / error-edge。プロジェクトの核となる性質を attack する軸を選ぶ。guide と実装の突き合わせそのものは `guidance-dogfood` の担当なので、この loop では観点に立てない。

verify は各 finding に独立 skeptic を当て、REFUTE を試させる (default skeptical、コードを読んで確証した時だけ is_real)。これが誤検出と hallucination を落とす。

### Phase 2 — triage (agent 自身)

verify を通った confirmed を、**agent 自身が**さばく。verdict は二次情報なので鵜呑みにしない。判断軸は `references/triage-discipline.md`、哲学 filter は `../_shared/core-principles.md`。要点:

- **重要 finding は自分でコードを当てて** real/false を再確認する。特に crash / corruption / 自分が書いたコードに触れるものは必ず読む (自分のコードは bias がかかりやすい)。
- **mine vs pre-existing** を区別する (今回入れたものか、branch 以前からか)。pre-existing も real なら拾う (全体レビューの狙い)。
- **severity** を付け直す (reviewer の付けすぎ / 過小を補正)。
- **哲学 filter**: `../_shared/core-principles.md` の「守るべき性質 / 醜いもの」に照らす。実装期任せの領域 (TS form 細部、内部 wire、命名) を「bug」として上げているものは落とす or 格下げ。意味を変える自動書き換え・realtime-safety 違反・「型は通るが壊れる」系は核に反するので重く見る。
- **guide 非神格化**: code が `skills/unworklet/` の記述と違う finding は、「guide と一致するか」でなく「**方向性に合うか**」で判定する。乖離を見たら「実装が正しい (guide が古い) のか、実装が方向性に反するのか」を良心で判断する。guide に寄せるのが正とは限らない — guide の方を直す判断もある (どちらに倒しても、正本は 1 つに保つ)。
- 結果を 4 バケツに分ける: **A 自律で直す明確なバグ** / **B 判断が要る (設計・scope)** / **C 後回し可能な nit** / **D refuted・false**。
- triage は読む量が多い。多階層の表を TUI に流さず md に書く (`playground/review-triage.md` 等)。TUI には要約 + path + 次の一手だけ。

### Phase 3 — 判断フォークだけ質問

バケツ B (設計・scope 判断) だけを `ask-user-style` skill の規範で**1つずつ**聞く。明確なバグ (バケツ A) は聞かない。質問が互いに依存するなら順次出す (1 質問 = 判断 1-2 軸)。

「判断が要る」= 余湖さんにしか決められないもの: 機能を実装するか禁止するか、リファクタの範囲を今やるか次版か、相反する 2 実装のどちらが正か、など。「明らかに直すべき」は質問対象外。

### Phase 4 — TDD で自律 fix

全回答が揃ったら、黙々と直す。1 対応 1 commit。

- **test 先行・black box** (入出力で検証、AST 内部を覗かない)。八百長禁止 = test の期待値は実装の出力を写すのでなく第一原理 / 参照から導く。
- バケツ A (明確バグ) + 回答済みの B を、依存順で。各 commit で `vp check` + 該当 package の `vp test run` (timeout 付き) を緑にしてから commit。
- `git add` は触った path だけ (`-A` / `.` / `-a` 禁止)。`git status --short` で確認。
- crash / 全 processor 影響のような土台のバグから先に。

**どのテストをどこで書くか** (unworklet 固有、mock pass ≠ real pass):

- **純ロジック** (codec の encode/decode、純関数、型レベル) → node unit test。最速。
- **deterministic な DSP / graph 振る舞い** (compile → WASM → 出力、MIDI in/out、snapshot/restore のロジック) → `@unworklet/offline` の `renderOffline` を主オラクルに node test。同一入力 → 同一出力で tolerance 0、第一原理で期待値を導く。
- **thread / SAB / Atomics / rAF / 実 worklet 経路** (main↔worklet transport、block-atomic、real ring concurrency) → **real browser e2e が完了バー** ([[e2e-test-is-completion-bar]] の規律)。`__tests__/browser/` に `OfflineAudioContext` + `?worklet` fixture で deterministic に走らせる (real worklet thread を駆動するが flaky でない)。node の mock unit が緑でも実 thread で落ちうるので、ここは mock で代用しない。
- browser test は CI / 実機で走る。ローカル環境で worklet registration が通らないことがある (env gap) — その場合は CI / 実機を実行環境とし、未実行を正直に申告する。
- crash / corruption / hang を直したら、それを catch する異常系 test を必ず先に書く (latent だった = 既存 test が素通りした証拠)。

### Phase 5 — 再レビュー

Phase 1 を再度回す。前回直した範囲が本当に閉じたか + 新たに見えるものがないかを、また独立 subagent で。

### Phase 6 — 収束判定

再レビューの結果を Phase 2 と同じ基準で triage し、**要対応 (バケツ A + B) がゼロ**になったら収束 = 終了。残っていれば Phase 3 へ戻る。

収束を報告する時は、各周で何件 → 何件に減ったか、最終的に残った refuted / nit を簡潔に示す。

### Phase 7 — playground で一緒に動作確認を提案

収束したら、直した機能を **playground (gitignore 済の書き捨て場) で余湖さんと一緒に動かして確認するのを提案する**。test が緑でも、実際に動かして目で見る確認は別物 (特に thread / audio 経路)。書き捨て script や real browser run で 1 つずつ触れる形にして「これ動かして確認する?」と振る。余湖さんの最終チェックはここ。

---

## 横断規律

- **subagent にバイアスを注入しない** (事実 context のみ、評価を刷り込まない)。これを破ると review の客観性が死ぬ。
- **verdict 鵜呑み禁止**、agent 自身がコードで triage。
- **ハング可能コマンドは timeout で囲む** (`vp test run`、browser test、playwright)。watch を無制限に流さない。
- **commit は 1 対応 1**、`git add` は path 明示。
- **TDD 八百長禁止** (test 先行・入出力検証)。
- 報告は短く 1 行ずつ、jargon を撒かない (`../_shared/core-principles.md` 周辺の通信規律)。
- 重い読み物 (triage 一覧) は md、TUI は要約 + path + 次の一手。

## メンテナンス

哲学 filter は `../_shared/core-principles.md`。観点の穴 (例: ある種のバグを毎回見逃す) に気づいたら `references/review-workflow.js` の `DIMENSIONS` に観点を足す。triage の判断基準が変わったら `references/triage-discipline.md` と core-principles の両方を整合させる。
