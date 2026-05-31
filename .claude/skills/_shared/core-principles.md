# unworklet core principles

unworklet が目指す姿 + 守るべき性質 + 醜いとみなすもの。`adversarial-review-loop` skill が triage の**判断の主基準**として参照する。

live document として上書きで更新する。

---

## 1. unworklet とは / docs の位置づけ

TypeScript-first な宣言的 DSL で書かれた DSP を Audio Worklet 上の WebAssembly に compile するライブラリ。ユーザーは graph を declare するだけで、framework が capture → static analysis → WASM emission → runtime guard を担う。web platform (Web Audio + Web MIDI + WebAssembly) 向けの普通の npm library。

**docs は基準ではなく参考。** `docs/` は v1.0.0 実装までの目標として 80% まで煮詰めた段階で、100% にする前に実装フェーズへ移行した = **メンテ非前提**。実装を docs と**意図して変えている**箇所があり、`docs/12-canonical-examples.md` ですら正しいとは限らない (余湖さん本人が完璧には目を通せていない)。

→ 判断の最終基準は**この core principles = プロダクトの方向性**。docs/canonical と実装が食い違ったら「docs と違う = bug」と機械判断せず、「実装が正しい (docs が古い/意図的に変えた) のか、実装が方向性に反してサボっているのか」を方向性に照らして**良心で**判断する。

---

## 2. 守るべき性質 (= 判断の主基準)

「unworklet であり続けるために」削れない性質。判断対象がこのいずれかと衝突したら、それが基準。

- **declarative**: user が書いた構造がそのまま WASM になる。framework が意味を変える自動書き換えは列挙限定。意味を変えない最適化 (dead code elimination、SIMD ベクトル化等) は OK だが、user 値を黙って別値に差し替える / 隠れた delay を入れる / sequence を rewrite する系は NG。
- **realtime-safe**: audio thread (worklet の process() と emit された WASM) は allocation-free / lock-free / GC-free / bounded-loop only (`00-foundations.md` §5.1)。per-quantum の heap alloc・無制限ループ・lock は realtime 違反。SAB / postMessage どちらの transport でも守る。
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
