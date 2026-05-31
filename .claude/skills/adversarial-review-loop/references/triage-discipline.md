# triage-discipline

Phase 2 で confirmed findings をさばく時の判断軸。哲学 base は `../../_shared/core-principles.md`。

## 大原則: verdict は二次情報

skeptic verify を通った finding も、subagent の判断 = 二次情報。**重要なものは自分でコードを当てて real/false を再確認する。** 特に:

- crash / memory corruption / data race を主張するもの
- 自分 (このセッション) が書いたコードに触れるもの — 自分のコードは「正しいはず」のバイアスがかかるので、必ず自分で読む
- severity が high 以上のもの

read して確証が取れたものだけ「real」として扱う。reviewer の why_bug と verdict reasoning が具体的な失敗経路 (どの入力で何が壊れるか) を示せていないものは疑う。

## 4 バケツに振り分ける

| バケツ                | 中身                                            | 行き先                                |
| --------------------- | ----------------------------------------------- | ------------------------------------- |
| **A 自律 fix**        | 明確なバグ / 仕様違反。直し方に判断の余地がない | Phase 4 で黙々と直す。聞かない        |
| **B 判断フォーク**    | 設計・scope 判断。余湖さんにしか決められない    | Phase 3 で ask-user-style             |
| **C nit**             | docs typo、再 export 漏れ、低 severity の改善   | まとめて後で。聞かない                |
| **D refuted / false** | verify が落とした / 自分の読みで false と確認   | 報告に残すだけ (hallucination も含む) |

## A か B かの境界

**B (聞く)** = これ:

- 機能を「実装する」か「そもそも禁止する」か (例: 宣言できるが未実装の surface — 実装 or finalize で reject か)
- リファクタの**範囲**を今やるか次版か (例: 中規模の transport 書き換え)
- 相反する 2 実装の**どちらが正**か (例: online と offline で挙動が違う、どちらに揃えるか)
- 仕様の解釈が割れていて docs だけでは決まらないもの

**A (聞かない)** = これ:

- クラッシュ / corruption / hang / data race で、直す方向が一意
- 型は通るが WASM が壊れる系 (= 「型 ⟺ 動く」の核に反する、直すべきは自明)
- 方向性 (core-principles) に明確に反する実装で、直し方が一意

迷ったら: 「直し方そのものに余湖さんの好みが要るか?」で判定。要るなら B、一意なら A。

### docs-divergence finding の扱い (神格化しない)

「code が docs/canonical と違う」という finding は、**docs を基準に機械判断しない** (`../../_shared/core-principles.md` §1)。docs はメンテ非前提の参考で、実装を意図的に変えた箇所がある。方向性に照らして振り分ける:

- code が**方向性に反している** → A (docs に関係なく直す)
- **docs の方が古い/間違い**で code が方向性に沿っている → D (finding を落とす)。docs を直す/消すのは C の nit 扱い、もしくは余湖さんに「docs こうなってるけど消す?」と軽く振る程度
- **どちらが正か方向性だけでは決まらない** (解釈が割れる) → B で聞く

「docs にこう書いてある → 実装が bug」は禁止。docs に寄せるのが正とは限らない。

## severity の付け直し

reviewer の severity を鵜呑みにせず補正する。目安:

- **critical**: メモリ安全性破壊 / 全 processor が確実にクラッシュ / silent data corruption が常用経路で出る
- **high**: 特定条件でクラッシュ・corruption・hang / realtime-safety 違反が fallback 常用経路で出る / 「型通って壊れる」
- **medium**: 異常系・境界でのみ顕在化 / robustness 欠如 / spec 乖離だが実害限定
- **low**: docs/型 nit、再 export 漏れ、稀な edge

## 哲学 filter (`../../_shared/core-principles.md`)

core-principles の「守るべき性質 / 醜いもの」に照らす。code review 固有の補足:

- **実装期任せを「bug」として上げているものは落とす or 格下げ**: TS signature の form 細部、識別子命名、main/worklet 間の内部 wire layout (snapshot blob 以外)、mechanism の自由度 (MessageChannel か Atomics.notify か等)。これらは仕様 invariant が動かない限り実装判断。
- **重く見る (核に反する)**: ① framework が user 値を意味を変えて暗黙に書き換える ② audio thread の realtime-safety 違反 (alloc / unbounded loop / lock / GC) ③ 「型は通るが動かない」(型 ⟺ 動く の破れ) ④ snapshot blob の wire byte 互換性破壊 (ship 後凍結領域)。
- **pre-existing も拾う**: branch 差分外でも real なら A/B に入れる。全体レビューの狙いはそこ。ただし mine と区別して報告する (責任範囲が違う)。

## 報告

triage 一覧は md に書く (TUI に多階層表を流さない)。各 finding: severity / mine か pre-existing / 自分でコード確認したか / バケツ / 推奨。TUI には「N 件中 A=x, B=y, C=z, D=w、推奨順は md」の要約 + path + 次の一手だけ。
