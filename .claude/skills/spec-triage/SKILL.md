---
name: spec-triage
description: docs/open-questions.md の 個別 entry を `references/decision-axes.md` の 軸 a-i に 照らして 「自律 で docs 修正 commit (a/b/c/d)」 「自律 で entry close (e)」 「余湖さん 相談 (f/g/h/i)」 に 振り分ける skill。 自律 hit は 即 commit、 相談 hit は `$TMPDIR` 下 に 1 件 ずつ md で 出す。 「triage 回して」 「open-questions さばいて」 「open-questions 1 周して」 「spec triage」 等 で 起動。 spec-integrity-sweep が open-questions.md を 整理 した 後 の sweep 1 周 path 想定。 軸 で hit し ない entry が 出たら そこ で 即 停止 し 余湖さん に 報告 (= 軸 file メンテナンス trigger)。 1-2 entry の 単発 修正 や、 decision-axes.md / core-principles.md 軸 自体 を 直す grill では 起動 し ない。
---

# spec-triage

unworklet `docs/open-questions.md` の 個別 entry を 1 件 ずつ 軸 で 判別 し、 自律 commit / 相談 md に 振り分ける。 `spec-integrity-sweep` が 出した open-questions.md を 1 周 する 後段 skill。

## 1. 対象 + 起動 タイミング

**対象**: `docs/open-questions.md` の P1 / P2 / P3 entry 全て。

**入力**: `references/decision-axes.md` (= 軸 a-i + commit / 相談 規律)、 `../_shared/core-principles.md` (= 哲学 base、 両 skill 共通 ref)。 この skill の 全 動作 は この 2 file を ベース に する。

**起動 タイミング**:

- `spec-integrity-sweep` が open-questions.md を 整理 し終わった 後 の 1 周 起動
- 余湖さん が 「triage 回して」 「entry さばいて」 等 で 起動
- 残 件 が 残った 状態 で 軸 file が 更新 された 後 の 再 起動

**起動 し ない**:

- 1-2 entry の 単発 修正 (= 通常 の Read / Edit で 済む)
- `decision-axes.md` 軸 自体 を 直す grill (= 余湖さん と 直接 grill md で やる、 skill 外)

## 2. 実行 process

各 entry の 処理 は **serial** (= 1 件 ずつ 順 に)。 並列 NG = open-questions.md / decisions-log.md write 衝突 リスク。

### Phase 1: 状態 把握

1. `docs/open-questions.md` 全文 read
2. `references/decision-axes.md` 全文 read
3. `../_shared/core-principles.md` 全文 read (= 哲学 base、 両 skill 共通)
4. open entry 件数 を 余湖さん に 1 行 報告 (= 「N 件 から sweep 開始」)

### Phase 2: 1 entry ずつ a-i 判別

各 entry に 対し:

1. entry の 「場所」 「何 が 起きて いる か」 「impl AI 影響」 「判断 軸」 を 文脈 込み で read。 grep 拾い 読み NG (= 累犯 規律)。
2. 軸 a → b → c → d → e → f → g → h → i の 順 で 適用、 hit した 軸 で 確定。
3. 各 軸 の check 場所 を `decision-axes.md` §2 通り に 1 つ 1 つ 当たる (= 雰囲気 で 軸 を 当て ない)。

### Phase 3a: 自律 docs 修正 commit (= a / b / c / d hit)

1. 該当 docs ファイル (= `00-foundations.md` 等) を Edit
2. `docs/open-questions.md` から 該当 entry を 削除、 統計 行 + section 件数 を 更新
3. 仕様 invariant が 動いた 場合 は `docs/decisions-log.md` に 新 Q を 追記
4. canonical を 触った 場合 は AGENTS.md HARD CONTRACT で `12-canonical-examples.md` の 整合 を 同 commit で 守る (= Coverage table 更新、 Ex の build 可能 性、 prose と code の zip)
5. commit message:

   ```text
   docs(<scope>): <変更>

   decision-axes: <a | b | c | d>
   基づく: <引用 / Q番号 / core-principles §2 項目 名 / 外部 標準 link>
   理由: <1 行>
   ```

### Phase 3b: 自律 entry close (= e hit)

docs/*.md は 触らない。 仕様 invariant が 動いて いない こと を 前提 と し、 form 細部 を 実装 期 任せ と して entry を 閉じる。

1. `docs/open-questions.md` から 該当 entry を 削除、 統計 行 + section 件数 を 更新
2. `docs/decisions-log.md` に 新 Q を 1 行 追記 (= 「実装 AI 領域 と して close、 仕様 invariant 動か ず」)
3. commit message:

   ```text
   docs(open-questions): <短 タイトル> を 実装 AI 領域 と して close (Q<新番号>)

   decision-axes: e
   基づく: core-principles §2 「TS form 細部 / 命名 / mechanism 自由 度 = 実装 期 任せ」
   理由: <1 行 = 仕様 invariant が 動か ない 根拠>
   ```

### Phase 3c: 相談 md 出力 (= f / g / h / i hit)

1. `$TMPDIR/spec-triage-<短い 識別子>.md` に 出力
2. 形 = `decision-axes.md` §4 規範 通り:
   - 【何 の 話 か】 平易 日本語 で 1-3 段、 余湖さん 視点 で 説明 (= 変数 名 / Q番号 / 内部 用語 排除)
   - 【選択肢】 案 A / B / (C / D) + code 例 / 図 込み + 「余湖さん が 書く と こう なる」
   - 【僕 の 推奨 と 弱点】 推奨 + 自己 列挙 1-2 個
   - 【判断 待ち】
   - 末尾 = 軸 (= f / g / h / i) を 1 行
3. open-questions.md から entry を 削除 し ない (= 余湖さん 答え 後 に 削除)
4. 同 trade-off の 数 entry が あれば 1 相談 md に 束ねる (= 余湖さん が 1 度 に 判断 しやすい)

### Phase 4: 軸 ずれ 検出 = 即 停止

軸 a-i で hit し ない entry が 出たら そこ で 即 停止:

- その entry を 「unclassified」 と マーク (= open-questions.md は 触らず そのまま 残す)
- 余湖さん に 「軸 不足 signal: <entry title>」 を 即 報告
- `decision-axes.md` §5 メンテナンス trigger と して 余湖さん と 直接 grill (= skill 外)
- grill で 軸 file 更新 後、 余湖さん が skill を 再 起動

「適当 に a に 寄せる」 「適当 に e で close」 「適当 に h で 相談 出す」 = NG (= 累犯 規律 「artificial 制約 を 勝手 に 入れる な」 と 同 根)。

### Phase 5: 完了 報告

1 周 終了 時 に 1 message で 報告:

- 自律 docs 修正 commit n 件 (= 軸 内訳 a/b/c/d)
- 自律 entry close commit m 件 (= 軸 e)
- 相談 md k 件 (= 軸 内訳 f/g/h/i、 path 一覧)
- unclassified j 件 (= 軸 不足 signal、 残置 entry title)
- 残 open-questions 件数

「相談 md どれ から 開ける?」 で 余湖さん 起動 待ち。

## 3. 行動 規律

### 軸 判別 を 雰囲気 で し ない

`decision-axes.md` §2 の 各 軸 「check 場所」 を 1 つ 1 つ 当たる。 commit message の 「基づく」 行 で 引用 できる source を 必ず 出す (= docs 行 / Q番号 / §1.2 項目 名 / 外部 標準 link)。

### 1 entry = 1 commit、 batch NG

entry を まとめて edit → 1 commit、 は NG。 各 commit が atomic = 余湖さん が 1 件 単位 で revert できる。

### serial、 並列 NG

sub-agent 並列 で 各 entry を 処理 する と open-questions.md / decisions-log.md write 衝突。 `spec-integrity-sweep` Phase 3 と 同 根 = serial 必須。

### canonical を 触る commit は HARD CONTRACT

`12-canonical-examples.md` の 整合 を 同 commit で 守る。 Coverage table 更新、 Ex の build 可能 性、 prose と code の zip。 「mechanical batch で 後 で」 NG (= AGENTS.md 明言)。

### 完全 自律 NG = 軸 不足 で 即 停止

軸 で hit し ない entry が 出たら Phase 4 で 即 停止 → 余湖さん 起動。 skill が 全件 を 終わらせる こと より、 軸 file が 育つ こと を 優先 (= 軸 file が 育てば 次 回 sweep で hit 率 が 上がる)。

### 相談 md は path 一覧 で 渡す

m が 大きい 場合 でも 1 message で path 一覧 を 出し、 余湖さん が 1 件 ずつ 開ける 形。 相談 md 全部 を 1 message に inline ペースト NG (= TUI bulk-send 累犯 規律)。

### pause-before-commit は skill 内 で 不適用

通常 の Edit + commit batch NG 規律 は skill 起動 時 (= 余湖さん が 自律 sweep を 明示 指示) に は 不適用。 余湖さん は 後 で `git log --oneline` + commit body で batch audit する 設計 = `decision-axes.md` §3 通り。

## 4. references/

- `references/decision-axes.md` — 軸 file。 §1 共通 base ref (= core-principles) + §2 軸 a-i + §3 自律 commit 規律 (= a-d docs 修 正 + e entry close) + §4 相 談 md 規 範 form + §5 メ ン テ ナ ン ス。 この skill の 振 り 分 け 動 作 が こ の file を 参 照。
- `../_shared/core-principles.md` — 哲学 base = unworklet の 目 指 す 姿 + 守 る べ き 性 質 + 醜 い と み な す も の。 spec-integrity-sweep と 共 通 ref、 二 重 管 理 排 除。 軸 file の §2c (= 哲 学 派 生) と §2e (= 実 装 AI 領 域) が こ の file の 哲 学 に 依 拠。
