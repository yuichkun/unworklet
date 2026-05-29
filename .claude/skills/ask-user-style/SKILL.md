---
name: ask-user-style
description: 余湖さんに 何かを 選んで もらう / 方向性 を 確認する 時の form 規範。 TUI 出力は 1 行の intro だけにして、 選択肢は AskUserQuestion tool で 並べる。 各 option label は 5-15 字の 平易 日本語、 description は 1 文 で 判断材料 だけ。 jargon は 文脈 で 余湖さん が 既知の 用語 のみ、 説明 なしの 用語 散布 ナシ。 TUI 内で の 長い 前置き 段落 / 複数案 list 化 / 多階層 list は 全部 NG (= AskUserQuestion に 寄せる)。 起動 = 余湖さん に 選択 を 求める 任意の 場面 で 自動 適用。
---

# ask-user-style

余湖さん に 質問する 時の form 規範。 1 行 intro + AskUserQuestion 寄せ + 短い label / description で 判断 を 即できる 形 に する。

## 規範 form

1. TUI 出力 = 「次の選択肢、 どれ?」 等の **1 行 intro だけ**
2. 選択肢 は AskUserQuestion tool で 並べる
3. 各 option:
   - **label = 5-15 字、 平易な 短い 日本語**
   - **description = 1 文、 判断材料 だけ**
4. recommend は label 末尾 `(Recommended)` か 最初の option に置く
5. **TUI で list / 段落 / 表 / 長文 全部 NG** (= AskUserQuestion に 寄せる)

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
- design grill (= 設計 question) は `grill-md-canonical-form` 規範 form (= md 別 出し) を 優先、 本 skill は 軽量 判断 場面 に 限定
- 累犯 entry: `feedback_no-tui-bulk-send.md` / `feedback_no-jargon-sprinkling.md` / `feedback_concise-communication-style.md` と zip
