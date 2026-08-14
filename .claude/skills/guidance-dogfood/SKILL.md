---
name: guidance-dogfood
description: unworklet の AI ガイド(`skills/unworklet/` の skill 一式 + `README.md`)が実装と乖離していないかを検証して直す。2 方法を併用する — ① 各ガイドの主張を実装と直接照合する drift 監査(`references/drift-audit-workflow.js` を Workflow で file ごと並列)② ガイドだけを渡した subagent に隔離 repo で公開パッケージから現実のプロジェクトを全機能ぶん作らせる blind dogfood(八百長 = source 読み禁止、`references/dogfood-brief.md`)。出た gap を triage して guide を直し、underlying な library bug は issue 化、blind build が clean になるまで再 dogfood。起動 = ガイドの精度を上げたい / release 前 / 「dogfood して」「ガイドが実態と合ってるか確かめて」。
---

# guidance-dogfood

unworklet の **AI ガイド**(consumer / LLM が読む doc)が、実装の現実とズレていないかを検証して直す skill。

`adversarial-review-loop` が **実装コード**を叩くのに対し、これは **ガイド**を叩く。守る対象が違う:
ガイドは「型は通る」では守れない。書いてあるとおりに人(や AI)が手を動かして、**詰まらず一式を作れるか**でしか分からない。

対象 = **唯一の SSoT**:

- `skills/unworklet/` — `SKILL.md` + `dsl.md` + `setup.md` + `ide-and-typecheck.md` + `testing.md` + `devtools.md`(plugin がそのまま配る)
- `README.md` — user-facing

## なぜこの形か

ガイドを書いた本人(= 実装も知っている人)は、**書いてないことを頭で補完してしまう**。だから自分で読み返すだけでは「足りない手順」「嘘の API 名」「古いコマンド」に気づけない。2 つの独立した目を当てる:

- **直接 drift 監査** — ガイドの各「具体的主張」(API 名 / コマンド / 手順 / 振る舞い / コード例)を、実装の該当箇所と機械的に突き合わせる。嘘・古い・抜けを file:line 根拠で挙げる。reviewer は実装を読むが、**「ガイドが正しい前提」を刷り込まない**(疑って当たる)。
- **blind dogfood** — ガイド**だけ**を渡した別の subagent が、隔離 repo で公開パッケージから現実のプロジェクトを作る。**unworklet の source を読むの禁止(八百長禁止)**。詰まったら回避を探さず gap として記録する。「補完なしで本当に作れるか」を体験で炙り出す。これが本命。

2 つは相補的: drift 監査は「書いてある事の正しさ」を、dogfood は「書いてない事の欠落」を捕る。

**docs を神格化しない**(`../_shared/core-principles.md` §1)。乖離を見つけても「ガイドと実装が違う = ガイドが bug」と機械判断しない。**実装が正しくてガイドが古い**のか、**ガイドは正しくて library が直すべき**(型 ⟺ 動く 違反など)のかは、プロダクトの方向性に照らして triage で良心判断する。

## 起動条件

- **走る**: 「ガイドが実態と合ってるか確かめて」「dogfood して」「release 前にガイドを検証」、ガイドを大きく書き換えた後、新機能を ship した後。
- **走らない**: ガイド 1 文の事実確認(= 直接その file と実装を読めば済む)、軽い typo 直し。

## 前提

- **2 つの作業領域を混同しない**(これが最大の footgun):
  - **monorepo 側**(`/Users/yuichkun/workspace/unworklet`)= vite-plus repo。コマンドは必ず `vp`(`vp check` / `vp test run` / `vp pm pack`)。`npm` / `npx` 禁止。
  - **consumer 側**(隔離 dogfood repo)= vite-plus では**ない**普通の web プロジェクト。ガイドどおり `npm` / `npx` を使う。monorepo の `vp` ルールを持ち込まない。
- **隔離 repo でしか dogfood しない**(`../_shared` の publish 検証規律と同根)。monorepo 内に `workspace:*` や relative import で足すのはチート。**公開パッケージを npm install**、または未 release の変更を試すなら `vp pm pack` の tgz を install。monorepo の外(例 `~/Desktop/uwk-dogfood/`)に作る。**user の workspace 直下に dir を撒かない**。
- **音を鳴らさない / dev server を立てない**。検証は node だけ(`unworklet-tsc --noEmit` / `vite build` / `vitest run`)。audio の実機確認は余湖さん本人がやる。
- **node green ≠ 完全検証**。thread / SAB / 実 worklet / 実 audio は node では出ない。そこは正直に「未検証」と申告し、Phase 6 で余湖さんに渡す。
- ハング可能コマンドは全部 `timeout` で囲む。`vp test` ではなく `vp test run`、consumer 側も `vitest run`(watch 禁止)。
- multi-agent orchestration を使う(Workflow tool の opt-in はこの skill 自体)。

---

## ループ

```
  ┌─────────────────────────────────────────────────────────┐
  │ Phase 0  対象と版を確定(guide 一式 + どの公開版/tgz)   │
  │ Phase 1  直接 drift 監査(Workflow: 1 guide file = 1 agent)│
  │ Phase 2  blind dogfood(隔離 repo・公開 pkg・全機能・八百長禁止)│
  │ Phase 3  triage(WRONG / MISSING / library-bug / by-design)│
  │ Phase 4  判断フォークだけ ask-user-style で質問           │
  │ Phase 5  guide を直す + library bug は issue 化(自律 fix)│
  │ Phase 6  再 dogfood(blind build が clean になるまで → 1へ)│
  └─────────────────────────────────────────────────────────┘
        clean になったら → Phase 7  余湖さんに実機(音)確認を提案
```

### Phase 0 — 対象と版を確定

- 検証するガイド一式を確認(上の SSoT)。
- dogfood が使う版を決める: **公開済みの精度を測る**なら npm の現公開版。**未 release の guide / library 変更**を測るなら `vp pm pack` で全 `@unworklet/*` の tgz を作って使う(`project_unworklet-playground-env` の罠: plugin の compiler は Node 経路で dist を読むので、core を直したら pack しないと反映されない)。

### Phase 1 — 直接 drift 監査(Workflow)

`references/drift-audit-workflow.js` を Workflow tool に `scriptPath` で渡す。1 guide file = 1 agent が、その file の**具体的主張**(API 名 / install・build コマンド / 必須手順 / 振る舞い / コード例)を、対応する実装パッケージと突き合わせる。各 drift に独立 skeptic が REFUTE を試す(default: guide は正しい、コードを読んで確証した時だけ drift 確定)。

**バイアスを注入しない**: agent には「これは unworklet のガイド。実装と突き合わせて、嘘・古い・builder が詰まる抜けを file:line で挙げろ。style は無視、事実の drift だけ。docs と違う = bug と断定するな、方向性で判断は triage に回す」とだけ伝える。「ここは検証済み」は刷り込まない。

### Phase 2 — blind dogfood

`references/dogfood-brief.md` をそのまま渡した subagent を 1 体立てる。ガイド一式のコピーだけを持たせ、隔離 repo で公開パッケージから**クリエイティブな実機プロジェクト**を全機能ぶん作らせる。**source 読み禁止(八百長禁止)**、詰まりは workaround で隠さず gap として記録させる。検証は node のみ。返ってくるのは gap report(どのガイド記述 → 期待 → 実際 → 詰まった度合い)。

全機能 = `.uwk.ts` authoring / `createNode` wire / param・state・event / MIDI in・out / `renderOffline` + `@unworklet/test` matcher で test / `unworklet-tsc` typecheck / devtools panel setup / snapshot・restore。

### Phase 3 — triage(agent 自身)

drift 監査 + dogfood の findings を、**agent 自身がコードを当てて**さばく(subagent の verdict は二次情報)。判断軸は `../_shared/core-principles.md`(方向性)。4 バケツ:

| バケツ          | 中身                                                                                  | 行き先                                                    |
| --------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **WRONG**       | ガイドの記述が事実と違う(嘘の API / 古いコマンド / 動かない手順・例)                  | Phase 5 で guide を直す                                   |
| **MISSING**     | ガイドが正しいが、builder が詰まる手順・注意が抜けている                              | Phase 5 で guide に足す                                   |
| **library-bug** | ガイドは実態に忠実だが、library 側が方向性に反する(型 ⟺ 動く 違反 / realtime 違反 等) | issue 化 + 修正キューへ。guide には当面の実態を正直に書く |
| **by-design**   | guide も library も正しく、学習コストで詰まっただけ                                   | guide を分かりやすくするか、何もしない                    |

`library-bug` か `by-design` かは方向性で判断する(docs に寄せれば正、ではない)。型は通るのに動かない・realtime を壊す・user 値を黙って書き換える系は核に反するので `library-bug`。TS form 細部 / 命名 / 内部 wire は実装期任せなので library-bug にしない。

triage 一覧は md に書く(TUI に多階層表を流さない)。TUI は要約 + path + 次の一手だけ。

### Phase 4 — 判断フォークだけ質問

`library-bug` で「直すか・どう直すか」に余湖さんの判断が要るものだけ、`ask-user-style` の規範で 1 つずつ聞く。WRONG / MISSING(guide 修正)は聞かず直す。**作業が重いことを理由に library-bug を defer しない**(`feedback_no-postpone-by-size-risk-criteria`)— defer 可は「PoC で確認でき + 並列に AI で厚くできる」もののみ。

### Phase 5 — guide を直す + library bug は issue 化

- WRONG / MISSING を、TDD ではなく**実証ベース**で直す: 直した記述・コード例を、隔離 repo で実際に通して(node 検証)「嘘でない」を確かめてから commit。`canonical-integrity` の精神で、SSoT(`skills/unworklet/`)本体を直す(コピーを直さない)。
- guide を直したら、それが**配布物**であることを忘れない: `skills/unworklet/*` は plugin が配る source。触った file は `vp fmt` + commit まで完結させる(`feedback_repo-tracked-edits-format-and-commit`)。
- `library-bug` は GitHub issue を立てる(**英語**、`feedback_user-facing-english`)。修正自体は `adversarial-review-loop` / 通常の実装フローに渡す(この skill の範囲はガイド精度)。
- commit は 1 対応 1、`git add` は触った path 明示(`-A` / `.` / `-a` 禁止)。

### Phase 6 — 再 dogfood

guide を直したら、**新しい subagent**(前回の文脈を持たない)に Phase 2 を再度やらせる。前回詰まった所が解け、かつ新しい gap が出ないかを見る。WRONG / MISSING がゼロ = 収束。残れば Phase 3 へ。

### Phase 7 — 余湖さんに実機確認を提案

収束したら、dogfood で作ったプロジェクトを **余湖さんが実機(ブラウザ + 音)で確かめるのを提案する**。node green でも音は別物。dev server の起動と play は余湖さんがやる(こちらは立てない・鳴らさない)。「これ、ブラウザで開いて音を確認する?」と振って終わり。

---

## 横断規律

- **八百長禁止**: dogfood subagent に unworklet の source を読ませない。読めると gap が埋もれて検証が死ぬ。
- **隔離 repo でしか dogfood しない**、公開 pkg / tgz を install、monorepo 内 workspace 参照はチート。
- **2 領域を混同しない**: monorepo = `vp`、consumer = `npm`。
- **音を鳴らさない・dev server を立てない**、node 検証のみ、実機は余湖さん。
- **verdict 鵜呑み禁止**、triage は agent 自身がコードを当てる。
- **drift を「ガイドが bug」と機械判断しない**、方向性で library-bug / by-design を分ける。
- **subagent にバイアスを注入しない**(事実 context のみ)。
- **重さを理由に library-bug を defer しない**。
- ハング可能コマンドは timeout で囲む、commit は 1 対応 1 path 明示、報告は短く 1 行ずつ。
- 触った配布物(`skills/unworklet/*` / `README.md`)は `vp fmt` + commit まで。

## メンテナンス

- 判断基準の哲学 base は `../_shared/core-principles.md`(`adversarial-review-loop` と共有)。
- guide 一式の構成(file の増減)が変わったら、`references/drift-audit-workflow.js` の file→実装マップと `references/dogfood-brief.md` の「渡すもの」を合わせる。
- dogfood が毎回素通りする穴(ある機能を試させ忘れる等)に気づいたら、`dogfood-brief.md` の全機能チェックリストに足す。
