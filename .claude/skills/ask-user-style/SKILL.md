---
name: ask-user-style
description: 余湖さんに 何かを 選んで もらう / 方向性 を 確認する 時の form 規範。 TUI 出力は 1 行の intro だけにして、 選択肢は AskUserQuestion tool で 並べる。 各 option label は 5-15 字の 平易 日本語、 description は 1 文 で 判断材料 だけ。 重い 設計 / 仕様 判断 は md を 別 file に 出す が、 その md も 4 ブロック (1 行 intro / 問題 を 最小 code 例 / なぜ を 1-2 文 / どう直すか を 1 行 ずつ) だけ で、 図・案ごとの 実装 段落・弱点 長文・Q番号 羅列・内部 実装 詳細 は 書かない。 jargon は 文脈 で 余湖さん が 既知の 用語 のみ。 起動 = 余湖さん に 選択 を 求める 任意の 場面 で 自動 適用。
---

# ask-user-style

余湖さん に 質問する 時の form 規範。 1 行 intro + AskUserQuestion 寄せ + 短い label / description で 判断 を 即できる 形 に する。 重い 設計 判断 は 別 file の md を 添える が、 その md も 最小 4 ブロック に 畳む。

## 規範 form

1. TUI 出力 = 「次の選択肢、 どれ?」 等の **1 行 intro だけ**
2. 選択肢 は AskUserQuestion tool で 並べる
3. 各 option:
   - **label = 5-15 字、 平易な 短い 日本語**
   - **description = 1 文、 判断材料 だけ**
4. recommend は label 末尾 `(Recommended)` か 最初の option に置く
5. **TUI で list / 段落 / 表 / 長文 全部 NG** (= AskUserQuestion に 寄せる)

## 設計 grill の md form (= 重い 判断 = md 別 file)

### 鉄則 (= 累犯 防止、 AskUserQuestion を 叩く 前 に 毎回 self-check)

- **質問 1 つ に つき 専用 md を 新規 に 書く。** 既存 の dense な 集約 md (調査 メモ / triage / open-questions 等) を **指して 済ます の は NG**。 集約 md は 自分 用、 質問 用 に は 必ず その 質問 だけ の 4 ブロック md を 起こす。
- **md に は 必ず 具体 的 な code 例 を 入れる。** 「問題」 ブロック が 散文 だけ = NG。 最小 case を 数行、 期待 と 実際 を 1 行 コメント で。 例 ナシ の 質問 は 投げない。
- **順序 を 飛ばさない**: ① 専用 md (4 ブロック + code 例) を 書く → ② TUI に 「1 行 intro + md path」 → ③ AskUserQuestion。 この 3 手 を 毎回。 md を 書かず に いきなり AskUserQuestion = 規範 違反。
- **一 度 に 1 問**。 次 の 質問 は 前 の 回答 を 記録 し て から。

TUI は 「1 行 intro + md path + AskUserQuestion」。 md は 次 の **4 ブロック だけ**、 各 ブロック 最小:

1. **1 行 intro** — 何の 判断 か (例:「codex P1 ×2、 両方 本物」)
2. **問題** — 壊れて いる 構文 を **最小 code 例** で。 1 case = 数行、 期待 と 実際 を 1 行 コメント
3. **なぜ** — 根本 原因 を **1-2 文**、 jargon ナシ
4. **どう直すか** — 案 を **1 行 ずつ** の list。 各案 = 「やること + trade-off」 を 1 文。 末尾 に 推奨 を 1 行

### md に 書かない こと (= 累犯 = 毎回 削る)

- 図 (mermaid 等) — 判断 に 不要
- 案 ごと の 「実装 AI が こう する」 段落 — 決定 後 の 領域
- 弱点 / 自己 申告 の 長文 — trade-off は 1 文 に 畳む
- Q番号 / spec 引用 の 羅列 — 「spec で OK と 書いて ある」 で 足りる
- 内部 実装 詳細 (local 衝突・emit 機構 等) — 決定 後 の 実装 領域

### OK 例 (= 形 そのもの)

```md
# typed-array の element 型 (f32 / u8) 問題

codex が P1 を 2 件。 両方 「型は通るのに動かない」 本物。

## バグ

F1 — `message<{ bytes: Uint8Array }>` の `bytes.at(0)` が byte じゃなく f32 を読む
F2 — もらった配列を `out.emitIf(true, { data, length })` で送る形が動かない

## なぜ

field が f32 か u8 かは TS の型にしか無く、 実行時に消える。 だから f32 で決め打ちしてた。

## どう直すか

- A. 型を実装に合わせる — 直接 .at() は f32 専用、 byte は buffer.u8 経由。 型と動作が一致。
- B. 宣言で型も書かせる — u8 も直接読める。 型と二重指定になる。
- C. copyFrom 頼り — 併用時だけ u8 を直す。 単独 u8 は issue 化。
  推奨は A。 型と動作が一致するのが一番きれい。
```

## NG form

- 長い 前置き 段落 を TUI に 書く
- 複数案 を TUI 内 で list 化 し て から 同 内容 を AskUserQuestion で 再 list
- jargon 連呼 (= 説明 なし の 用語 散布)
- option description が 2 文 以上 / 段落
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
