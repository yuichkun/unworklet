# dogfood-brief — blind builder subagent への指示テンプレ

これを **まっさらな subagent**(前回までの文脈・このリポジトリの知識を持たない general-purpose agent)に、ほぼそのまま渡す。狙いは「ガイド**だけ**で現実のプロジェクトが作れるか」を八百長なしで試し、gap を炙り出すこと。

---

## 渡す前にこちら(orchestrator)が用意するもの

1. 隔離 dir を 1 つ決める。**monorepo の外**(例 `~/Desktop/uwk-dogfood/`)。user の workspace 直下に作らない。場所に迷ったら余湖さんに一言確認する。
2. ガイド一式を隔離 dir の `_guidance/` に**コピー**する: `skills/unworklet/{SKILL,dsl,setup,ide-and-typecheck,testing,devtools}.md`。
3. 使う版を決める(`SKILL.md` Phase 0)。公開精度を測る = npm の現公開版。未 release を測る = `vp pm pack` の tgz 群。

unworklet の **source(`packages/*/src`)は渡さない**。

---

## subagent に渡す brief(ここから下をそのまま)

あなたは unworklet を**初めて使う web 開発者**。手元の資料は `<隔離 dir>/_guidance/` の Markdown だけ。

### 絶対ルール(八百長禁止)

- unworklet の**ソースコードを読むの禁止**。`packages/*/src` を覗かない。`node_modules/@unworklet/**` の実装(`.js` / `.ts`)も読まない(型の `.d.ts` を IDE 補完経由で使うのは可、実装を読んで回避を編み出すのは不可)。
- 詰まったら **workaround をソースから編み出さない**。代わりに gap として記録する: 「`_guidance/` のどの file の何行あたりを読んで」「何を期待して」「実際に何が起きたか(エラー全文)」「どれくらい詰まったか(軽い気づき / 手が止まる / 進めない)」。
- 資料に書いていない API 名・コマンドを**推測で当てて進めない**。書いてなくて要るなら、それ自体が gap。

### お題

- README やガイドに載っていない**クリエイティブな実機プロジェクト**を自分で考える。単純な gain コピーや、ガイドのサンプルそのままは**禁止**。例: リズムに同期した MIDI 制御のディレイ、ステップシーケンサ、エンベロープフォロワ、グラニュラ風など。
- 1 つの processor に閉じず、**全機能を 1 プロジェクトで使い切る**こと。

### 全機能チェックリスト(全部踏む)

- [ ] `.uwk.ts` で authoring(primary form。operator / index / `$prev` / subgraph 等の sugar も使う)
- [ ] `?worklet` import + `createNode` で wire、typed node を触る
- [ ] `param`(automation)/ `state` / `state.buffer`
- [ ] `event`(`from:"main"` と `to:"main"` 両方向)
- [ ] MIDI **in と out 両方**(`event.midi`、noteOn/Off・CC 等)
- [ ] `renderOffline`(`@unworklet/offline`)で headless render
- [ ] `@unworklet/test` の matcher で assert(自前で書かず**用意された matcher を使う**)
- [ ] `unworklet-tsc --noEmit` で typecheck(build / CI に組み込む)
- [ ] devtools panel が出る setup(`@unworklet/unplugin` + `@vitejs/devtools` 一式)
- [ ] `node.snapshot()` / restore

### 環境ルール

- 隔離 dir で作る。**公開パッケージを install** する(ガイドの install 手順どおり)。この consumer プロジェクトは **vite-plus repo ではない** ので、`npm` / `npx` を普通に使う(`vp` は使わない)。
- 検証は **node だけ**: `unworklet-tsc --noEmit` / `vite build`(または `npx vite build`)/ `vitest run`。**全部 timeout を付ける**(例 `timeout 180 ...`)。
- **dev server を立てない**(`vite` / `npm run dev` は起動しっぱなしになる)。**音を鳴らさない**。ブラウザでの実機確認はやらない — それは別途人間がやる。
- node の検証が green でも「動いた」と過剰申告しない。thread / 実 audio は node では出ないと添える。

### 返すもの

最後に **gap report** を返す:

- 完成したプロジェクトの概要(何を作ったか、どの機能を使ったか)。
- 踏めたチェックリスト / 踏めなかった項目。
- gap 一覧。各 gap = `{ どのガイド file・該当箇所 / 期待 / 実際(エラー全文) / 詰まり度 / これはガイドの抜けか・記述ミスか・library が変なのか の自己所見 }`。
- workaround で隠した所があれば正直に申告する(隠した = 検証が弱まる)。
