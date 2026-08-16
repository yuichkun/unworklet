---
name: ask-user-style
description: 余湖さんに 何かを 選んで もらう / 方向性 を 確認する 時の form 規範。 大前提は きちんとした 平易な 日本語 と 読む人への 愛 — 未説明の jargon・略語・内部記号・参照番号を option に置かず、 各 option は 「何をする案か」 と メリット/デメリット を 平易に 説明し、 違いが コードで 出るなら 可能な限り before/after の example code を 添える(option の `preview` 等)。 TUI 出力は 1 行の intro だけ、 選択肢は AskUserQuestion tool に 寄せる。 重い 設計 / 仕様 判断 は md を 別 file に 出す(1 行 intro / 問題 を 最小 code 例 / なぜ を 1-2 文 / どう直すか を 各案 中身+メリデメ+コードで)、 図・弱点 長文・Q番号 羅列・内部 実装 詳細 は 書かない。 起動 = 余湖さん に 選択 を 求める 任意の 場面 で 自動 適用。
---

# ask-user-style

余湖さん に 質問する 時の form 規範。 1 行 intro + AskUserQuestion 寄せ + 短い label / description で 判断 を 即できる 形 に する。 重い 設計 判断 は 別 file の md を 添える が、 その md も 最小 4 ブロック に 畳む。

## 大前提 — 言葉遣い と 愛(これを欠いたら、形が 4 ブロック揃っていても失格)

質問の「形」より前に、まず **読む人(余湖さん)への配慮** がある。これが無い伝え方は、他がどれだけ正しくても規範違反。

- **きちんとした、平易で丁寧な日本語で書く。** 即興の略語・内部記号・未説明の参照番号(`#4` `Q46` 等)・英語の実装用語(`witness` `lowerToProcessor` 等)を、説明なしで option に置くな。初めてその文だけを読む人が「何の話か」「これを選ぶと何がどうなるか」を分かる言葉にする。本物の技術用語は使ってよいが、意味不明な造語・社内コード・噛み砕いていない jargon は禁止。
- **option は必ず「中身」を説明する。** label + 一行 jargon で済ますな。各 option は「これを選ぶと具体的に何がどう変わるか」と「メリット / デメリット」を、平易な日本語で書く。「どう直すか」と問うなら、各案が **どう直すのか** を必ず説明しろ。説明のない選択肢を投げるのは、判断を相手に丸投げするのと同じ。
- **可能な限り example code を出す(これは毎回 言われている)。** 問題も、各案がどう直るかも、言葉だけで説明せず **最小の before / after コード** で見せる。コードで示せるものを散文で済ますな。問題は「今こうなる」を 1 ブロック、各案は「この案だとこう書ける / こう変わる」を 1 ブロックずつ。選択肢ごとにコードが違うなら、AskUserQuestion の option の `preview` フィールド(コード比較用)に各案のコードを載せて並べて見せる。
- **メリデメを整理して並べる。** 良い点・悪い点・コストを、相手が一目で比べられる形にする。trade-off を 1 文に畳むのは、その 1 文が平易で意味が通る時だけ。通らないなら畳まず、ちゃんと説明しろ。
- **「愛」と「優しさ」を持って書く。** コミュニケーションの目的は、相手が **迷わず・負担なく・気持ちよく** 判断できること。自分の頭の中の文脈や略語を相手に押し付けない。相手が一瞬でも「これ何?」「どういう意味?」となる言葉・構造は、書いた時点で失敗。読む人を思いやらない伝え方は、形が整っていても NG。

**送信前の self-check(毎回必ず):** この option を、この件を今はじめて聞く人が読んで、各案が何をするか・どっちが自分に合うか、迷わず分かるか? 分からないなら、jargon を平易語に直し、中身とメリデメを足してから送る。

### 悪い option / 良い option(同じ判断)

❌ 悪い(jargon・中身ナシ・コードも無し。読む人は何を選ぶのか分からない):

- `#4 も直す(推奨)`
- `footgun 全部 library`

✅ 良い(まず問題を最小コードで見せ、各案がコードでどう変わるかを示す):

問題(まずコードで):

```ts
// main から小数を送ると、worklet では整数に丸められてしまう
node.events.ctl.emit({ gain: 0.8 }); // worklet 側: e.gain === 0  ← 0.8 が消える
```

選択肢(label は平易に、各案のコードは AskUserQuestion の `preview` に載せて並べる):

- label `小数がそのまま届くよう直す` — preview:
  ```ts
  node.events.ctl.emit({ gain: 0.8 }); // 直すと: worklet 側 e.gain === 0.8
  ```
  良い点: 宣言どおり 0.8 が届く。悪い点: 送受信の仕組みに手を入れるので作業は大きめ。
- label `直さず、整数で送る書き方を案内` — preview:
  ```ts
  node.events.ctl.emit({ gainPct: 80 }); // worklet 側で /100 して 0.8 を得る
  ```
  良い点: すぐ出せる。悪い点: 使う人が「小数は整数にして送る」回避を覚える必要。

## 規範 form

1. TUI 出力 = 「次の選択肢、 どれ?」 等の **1 行 intro だけ**
2. 選択肢 は AskUserQuestion tool で 並べる
3. 各 option:
   - **label = 5-15 字、 平易な 短い 日本語**(略語・記号・参照番号・英語の実装用語を入れない)
   - **description = その案の中身 + メリデメを平易に。** 「何をする案か」「選ぶと何が良くて何が悪いか」が、その文だけで誰でも分かること。terse に削って jargon だけ残すのは禁止
   - **コードで違いが出る案は、option の `preview` に before/after の最小コードを載せて並べる**(`大前提` の例の形)
4. recommend は label 末尾 `(Recommended)` か 最初の option に置く
5. **TUI で list / 段落 / 表 / 長文 全部 NG** (= AskUserQuestion に 寄せる)

## 設計 grill の md form (= 重い 判断 = md 別 file)

### 鉄則 (= 累犯 防止、 AskUserQuestion を 叩く 前 に 毎回 self-check)

- **質問 1 つ に つき 専用 md を 新規 に 書く。** 既存 の dense な 集約 md (調査 メモ / triage / open-questions 等) を **指して 済ます の は NG**。 集約 md は 自分 用、 質問 用 に は 必ず その 質問 だけ の 4 ブロック md を 起こす。
- **md に は 必ず 具体 的 な code 例 を 可能な限り 入れる。** 「問題」 ブロック が 散文 だけ = NG (最小 case を 数行、 期待 と 実際 を 1 行 コメント)。 「どう直すか」 の 各案 も、 コードで 違いが 出るなら before / after の 最小コード を 添える。 例 ナシ の 質問 は 投げない。
- **順序 を 飛ばさない**: ① 専用 md (4 ブロック + code 例) を 書く → ② TUI に 「1 行 intro + md path」 → ③ AskUserQuestion。 この 3 手 を 毎回。 md を 書かず に いきなり AskUserQuestion = 規範 違反。
- **一 度 に 1 問**。 次 の 質問 は 前 の 回答 を 記録 し て から。

TUI は 「1 行 intro + md path + AskUserQuestion」。 md は 次 の **4 ブロック だけ**、 各 ブロック 最小:

1. **1 行 intro** — 何の 判断 か (例:「codex P1 ×2、 両方 本物」)
2. **問題** — 壊れて いる 構文 を **最小 code 例** で。 1 case = 数行、 期待 と 実際 を 1 行 コメント
3. **なぜ** — 根本 原因 を **1-2 文**、 jargon ナシ
4. **どう直すか** — 案 を 1 つ ずつ。 各案 = 「具体的に 何をする案か」を平易に + 「メリット / デメリット」。 コードで違いが出るなら **before / after の最小コード** を必ず添える。 jargon を使わない。 末尾 に 推奨 と「なぜそれを推すか」を 1 文

### md は explain-with-diagrams 風に、視覚的に内容説明を組み立てる (= 累犯 防止)

判断が「1 バグ + 2-3 案」で完結する軽い話なら 4 ブロック + code 例で十分。だが判断の内容自体が複雑 (複数系統・現在地の把握が要る・分岐先で到達点が違う・時系列・依存関係) な場合は、**言葉だけで済まさず、`explain-with-diagrams` skill の Mermaid 図で視覚的に見せる**。

- **全体像 / 分岐 → `flowchart`**: 現在地から各案の到達点までを 1 枚で。「今どこにいて、選ぶとどこに行くか」を 1 スクロールで掴ませる。
- **時系列 / 状態遷移 → `sequenceDiagram` / `stateDiagram-v2`**: main ⇄ worklet の交換、build → tsc → dev の順序、cold → warm の遷移など。
- **概念マップ → `mindmap`**: 案が複数の観点で違うとき、観点ごとの branch。
- **before / after のコード比較**: これはコードで見せる (`preview` に載せる)。図と併用可。

判断に効くなら図で表現する。判断に効かない装飾図 (実装内部の module 依存図など) は書かない。図 vs 散文の選択基準は「相手が読む時間を短縮するか」。

Mermaid 使う時は `explain-with-diagrams` skill の落とし穴を守る:

- label 内の半角 `(` `)` は全角 `（` `）` に置換 (node-shape syntax と衝突して blank になる)
- reserved keyword (`graph` `end` `class` `subgraph` 等) を node id に使わない
- `stateDiagram-v2` は 1 行 1 遷移、`A --> B --> C` の chain は禁止

### md に 書かない こと (= 累犯 = 毎回 削る)

- 案 ごと の 「実装 AI が こう する」 段落 — 決定 後 の 領域
- 自己 弁護 の 長文 — メリット/デメリット は 各案に 簡潔に 付ける が、 長い 言い訳 は 畳む
- Q番号 / spec 引用 の 羅列 — 「spec で OK と 書いて ある」 で 足りる
- 内部 実装 詳細 (local 衝突・emit 機構 等) — 決定 後 の 実装 領域
- 判断 に 効かない 装飾 図 (「これも 図に できる」 で 貼るのは NG、 「読む時間 が 短縮 する か」 で 判定)

### OK 例 (= 形 そのもの。 問題も各案もコードで見せ、 各案にメリデメ)

````md
# 受け取ったバイト列の先頭が、別の値として読めてしまう問題

codex が P1。 「型は通るのに動かない」 本物。

## バグ

```ts
const m = message<{ bytes: Uint8Array }>({ from: "main", name: "buf" });
m.onReceive((e) => out.write(e.bytes.at(0))); // 期待: 先頭バイト / 実際: f32 として誤読 → 別の値
```

## なぜ

各フィールドが「バイト」か「小数」かは TypeScript の型にしか無く、実行時には消える。だから一律で小数(f32)として読んでいた。

## どう直すか

- 型と実装を一致させる — バイトは `.u8` 経由で読む形にする:

  ```ts
  m.onReceive((e) => out.write(e.bytes.u8.at(0))); // バイトとして正しく読む
  ```

  良い点: 宣言した型どおりに読める。悪い点: バイト読みだけ書き方が `.u8` に変わる。

- 宣言で読み方も書かせる — `.at()` のまま直接バイトを読めるようにする。良い点: 書き方が統一。悪い点: 型と実装で二重指定になり、ずれると分かりにくい。

  推奨は前者。型と動作が一致するのが一番きれいだから。
````

## NG form

- 長い 前置き 段落 を TUI に 書く
- 複数案 を TUI 内 で list 化 し て から 同 内容 を AskUserQuestion で 再 list
- jargon・略語・内部記号・参照番号 を option に 置く (= 説明 なし の 用語 散布 = 読む人が 意味を 取れない)
- option の 中身 や メリット/デメリット を 説明 しない (「どう直すか」 と 聞いて 選択肢 を 説明 しない は 最悪)
- コードで 違いが 出る 案 なのに コード を 見せず 散文 だけ で 済ます
- option の 説明 が 段落・長文 (= 必要な 中身+メリデメ は 入れる が、 平易 簡潔 に。 自己 弁護 の 長文 は 削る)
- 1 turn に 複数 質問 を 詰める (= 依存 question は 段階 提示)

## OK 例

```
次やる 候補 3 つ:

[AskUserQuestion]
- (A) examples で メーター動くか 確認
- (B) event<T> も 同じ 手順 で 直す
- (C) message<T> も 同じ 手順 で 直す
```

## NG 例

```
状況: 第 1 wave で state.f32 path の postMessage transport を ...
[長い 段落 が 続く]

なぜ 次の wave で 詰まっているか:
- 同じ structured clone bug が event<T> ring buffer ...
- state.i32 / state.bool の publish も多角化候補でしたが ...

次の wave で 取れる 候補:
1. (A) examples/01-stereo-gain で 真の repro 検証 ...
2. (B) event<T> postMessage path 同形 fix ...
3. (C) message<T> postMessage path 同形 fix ...

[AskUserQuestion]
- ...
```

## なぜ

- TUI 長文 = 読み 負担 大、 判断 に 不要 な 文脈 が 紛れる
- jargon 散布 = 各 用語 を 噛み砕く 段階 を 余湖さん に 押し付ける
- AskUserQuestion に 寄せる = label / description の 文字数 制約 で 自動 的 に 短文化 + 判断 軸 が 明確化

## 起動

- 余湖さん に 何か を 選んで もらう / 方向性 を 確認 する 任意の 場面
- 軽い 判断 = TUI 1 行 intro + AskUserQuestion だけ
- 重い 設計 / 仕様 判断 = 上 の 「設計 grill の md form」 (= 最小 4 ブロック の md 別 file) + TUI 1 行 + AskUserQuestion。 md を 盛らない の が 規範
- 累犯 entry: `feedback_no-tui-bulk-send.md` / `feedback_no-jargon-sprinkling.md` / `feedback_concise-communication-style.md` と zip
