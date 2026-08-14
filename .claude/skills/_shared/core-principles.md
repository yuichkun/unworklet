# unworklet core principles

unworklet が目指す姿 + 守るべき性質 + 醜いとみなすもの。`adversarial-review-loop` skill が triage の**判断の主基準**として参照する。

live document として上書きで更新する。

---

## 1. unworklet とは / 何を基準に判断するか

TypeScript-first な宣言的 DSL で書かれた DSP を Audio Worklet 上の WebAssembly に compile するライブラリ。ユーザーは graph を declare するだけで、framework が capture → static analysis → WASM emission → runtime guard を担う。web platform (Web Audio + Web MIDI + WebAssembly) 向けの普通の npm library。既に publish 済み。

**照合先は「動くもの」だけ。** 振る舞いの正本は実装そのもので、それを説明する唯一の面が `skills/unworklet/`(consumer の agent が読む guide、例は CI で compile され、guidance-dogfood で実装と突き合わせ済み)。かつて実装を駆動した spec 文書群は、実装が出荷され検証された時点で削除した — 検証されない二番目の説明は必ず腐るため。`docs/` に残っているのは歴史(`decisions-log.md` = なぜそう決めたか、RFC 群)だけで、**現在の振る舞いを記述していないので契約として扱わない**。

→ 判断の最終基準は**この core principles = プロダクトの方向性**。「どこかにこう書いてある」を根拠に機械判断せず、方向性に照らして**良心で**判断する。

---

## 2. 守るべき性質 (= 判断の主基準)

「unworklet であり続けるために」削れない性質。判断対象がこのいずれかと衝突したら、それが基準。

- **declarative**: user が書いた構造がそのまま WASM になる。framework が意味を変える自動書き換えは列挙限定。意味を変えない最適化 (dead code elimination、SIMD ベクトル化等) は OK だが、user 値を黙って別値に差し替える / 隠れた delay を入れる / sequence を rewrite する系は NG。
- **realtime-safe**: audio thread (worklet の process() と emit された WASM) は allocation-free / lock-free / GC-free / bounded-loop only。per-quantum の heap alloc・無制限ループ・lock は realtime 違反。SAB / postMessage どちらの transport でも守る。強制は `packages/core/src/dsl/enforcement.test.ts` と root `vite.config.ts` の worklet-realm lint。
- **型 ⟺ 動く**: TypeScript で型が通るコードは動くべき。型で表現した制約は実際に守られ、型をすり抜けて壊れた WASM が compile される穴は核の破れ。型で守れないものは capture / static analysis / runtime guard の層で fail-loud にする。
- **user free が default**: 制約を入れる方が例外。「mental」「美学」「対称性」で勝手に制約を入れない。制約には仕様 invariant か哲学派生の justify が要る。
- **AI agent paradigm**: 実装工数で scope を絞らない。取り返しがつかないのは後戻り不可領域 (snapshot blob の wire byte) と mental model に染み出す API surface だけ。工数だけを理由にした defer は NG。
- **mental model unification ≠ feature reduction**: 「simpler mental model」を口実に feature を削らない。opt-in / namespaced surface で「必要ない user には見えない、必要な user には第一級」を探す。
- **既知の必要を後回しにしない**: PoC で確認でき + AI agent で並列に厚くできるもの (MIDI message variants、SIMD instruction families 等) のみ defer 可。API surface / 型 / メンタルモデルに染み出す選択は今 decide。
- **ship 後凍結 wire は snapshot blob だけ**: `node.snapshot()` の Uint8Array blob 並びのみが user 観測 + persist される凍結領域 (= 新 ship で restore = migration mandatory)。main / worklet 間の内部 wire (SAB ringbuffer slot 並び / event slot / MIDI slot / sysex content 並び) は framework 同 ship 内ペアで deploy = 自由、user code に見えない = 実装期に決める領域。
- **TS form 細部 / 命名 / mechanism 自由度 = 実装期任せ**: TypeScript signature の form 細部 (type alias 名、generic constraint の切り方、callable+property hybrid 等)、識別子命名、internal mechanism の選択 (main 側 drain が MessageChannel ping か Atomics.notify か等) は仕様 invariant が動かない限り実装判断。issue として上げる価値なし。

---

## 3. 醜いとみなすもの

- **docs/canonical を神格化して機械判断する** (= 「docs にこう書いてある → 実装が bug」と方向性を見ずに断ずる)。docs は参考、基準は §2。
- framework が user 値を「意味が変わる」形で暗黙に書き換える (列挙したものは OK、列挙漏れ NG)。
- audio thread の realtime-safety を破る (per-quantum alloc / 無制限ループ / lock / GC)。
- 型が通るのに動かない (型 ⟺ 動く の破れ)。
- 工数見積で scope を絞る (「人間 N 週間」式の判断)。
- 「mental 簡素」を口実にした feature 削減。
- 過去決定の撤回コストで設計を曲げる。
- 実装期任せの細部 (TS form / 命名 / mechanism / 内部 wire layout) を issue として余湖さんに上げる (過剰エスカレーション、attention 浪費)。

---

## 4. メンテナンス

このファイルは `adversarial-review-loop` skill の triage 判断基準。更新時はその skill の `references/triage-discipline.md` の哲学 filter 記述との整合を意識する。
