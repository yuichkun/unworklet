# 12 axes default

各軸の 「対象 file」 「重点 prose」 「典型 issue 形」 を列挙。 Phase 1 で sub-agent に dispatch する時の prompt 設計の base。

## 軸 1: 型 system 整合

**対象**: `docs/00-foundations.md` §4 (= Type system)、 `docs/01-dsl.md` §1〜§5 (= declarations / primitives)、 `docs/12-canonical-examples.md` 全例

**重点 prose**:
- `Node<T>` の T 集合 (= ScalarType の境界)
- `Buffer<T>` / `State<T>` / `Param` 公開 type 形
- literal lift rule の適用範囲 (= primitive / method / L1 helper / SIMD)
- generic 並び (= `<Old, New>` vs `<New>`)

**典型 issue 形**:
- `'u8'` 等の 「ScalarType に入れない」 element type が `Buffer<T>` や SIMD method の generic と 1 path で揃わない
- canonical で literal lift が暗黙前提だが prose に書かれていない
- 公開 type body の method set が prose 列挙ナシで use site から推測必要

## 軸 2: 越境表現整合

**対象**: `docs/00-foundations.md` §3 (= vocabulary) / §5 (= invariants)、 `docs/01-dsl.md` §4 (= handler) / §10 (= forSample)、 `docs/04-worklet-runtime.md`

**重点 prose**:
- build-time / audio-thread / main-thread 境界
- per-block / per-sample / handler-body の lexical scope
- emission boundary vs runtime boundary
- block-atomic / next-block / current-block の表現

**典型 issue 形**:
- 同一 boundary を別 wording で表現 (= 「block-atomic」 vs 「next quantum」 vs 「after process completes」)
- handler が 「sample-accurate 発火」 と 「block 開始時一括 drain」 で章ごとに揺れる
- sample-offset (`i`) の値域定義が章ごとに違う

## 軸 3: realtime-safety invariant matrix

**対象**: `docs/00-foundations.md` §5 (= invariants + enforcement layer matrix)、 `docs/03-compiler.md` §2.4 (= static analysis) / §2.6 (= stable error ID)

**重点 prose**:
- 5 invariant: heap alloc / unbounded loops / throw / blocking I/O / GC
- 4 enforcement layer: L1 TS / L2 graph-capture / L3 static-analysis / Emission / Runtime guard
- 各 invariant × layer マトリクス + stable error ID

**典型 issue 形**:
- matrix セルが open (= 該当 invariant に layer 列挙ナシ)
- 静的 check ID が invariant cover していない (= No I/O / No GC の検出 path 不在)
- layer 名称衝突 (= 「L1」 が enforcement layer と integration layer の 2 概念で混在)

## 軸 4: canonical-examples integrity

**対象**: `docs/12-canonical-examples.md` 全 example、 Coverage table、 冒頭 rule

**重点 prose**:
- Coverage table の Ex 列挙が実 code と zip
- 「self-contained, no `// ...` elisions」 冒頭 rule
- 各 example が exercise する surface 完結度

**典型 issue 形**:
- canonical 自身が type system rule (= No implicit widening、 lift rule) を違反
- declared-but-unused slot がある (= silent OK か reject か仕様 prose ナシ)
- 冒頭 rule 「no elisions」 を canonical 自身が違反

## 軸 5: messaging wire format

**対象**: `docs/02-messaging.md` 全章 (= 5 surface + ringbuffer)、 `docs/11-midi.md` §4 (= wire layer)

**重点 prose**:
- ringbuffer header layout (= `[head][tail][overflowCount]`)
- slot layout (= event / message / MIDI / sysex で zip するか)
- variable-length payload の content buffer
- SAB available / unavailable で transport zip
- Atomics protocol (= 5 surface 共通)

**典型 issue 形**:
- atSample 位置が event / MIDI で別
- sysex variant の slot に atSample 不在で 「sample-accurate」 主張と衝突
- SAB unavailable 時 postMessage が 「pre-allocated buffer transfer」 と 「structured-clone」 で別 wording

## 軸 6: snapshot/restore/migrations

**対象**: `docs/01-dsl.md` §8 (= snapshot)、 `docs/05-client.md` §2.6 / §8 (= snapshot / restore / replaceProcessor)

**重点 prose**:
- snapshot blob format (= profile-aware、 Q5 format)
- `RestoreResult` / `ReplaceResult` discriminated union
- migration chain (= fromHash → toHash + migrate function)
- `replaceProcessor` primitive
- `inspect` free function

**典型 issue 形**:
- `snapshot()` が trigger される条件が prose ナシ (= name 必須性 / persistent flag / migrations 引数)
- restore 時 migrate thread (= main vs audio) が章ごとに別
- `RestoreResult` と `ReplaceResult` の field set drift

## 軸 7: scope rule + 命名 + import path

**対象**: `docs/00-foundations.md` §3 (= scope vocabulary)、 `docs/01-dsl.md` §5 (= declarations) / §10 (= forSample)、 `docs/03-compiler.md` §2.4 / §2.6

**重点 prose**:
- declaration scope vs expression scope の境界
- handler context (= `onReceive` / `onEvent`) の expression scope 受容
- export 命名 (= `@unworklet/core` 全 named export)
- subpath import (= `/simd` / `/precise` / `/test`)

**典型 issue 形**:
- declaration scope helper の列挙が doc 間で違う
- expression scope の構成員が章ごとに揃わない
- 公開 package の named export 全集が 1 か所列挙ナシ

## 軸 8: Q-ref 引用整合

**対象**: `docs/decisions-log.md` (= 全 Q entry + summary table + Status 文)、 全 docs 内 `Qxx` 引用

**重点 prose**:
- decisions-log Status 文 (= ratify 完了範囲)
- summary table の status 列と entry body の zip
- 全 docs 内 `Qxx` 引用 → 該当 Q entry が現存
- Q番号が別内容で引用されていないか

**典型 issue 形**:
- Status 文が古い範囲で止まっており後半 ratify を包摂していない
- `Q14` が別内容 (= 「math intrinsics」) で引用されているが Q14 entry は別 (= 「acceptance criteria」)
- 「`Qxx` land 待ち」 prose が land 後も残る

## 軸 9: placeholder 整合

**対象**: 全 docs 内 `<!-- placeholder -->` HTML comment / `// TODO` / Status banner の `partial` / `skeleton`

**重点 prose**:
- placeholder の中身が別 sub-section の既 written prose と二重化していないか
- placeholder で未 ratify 概念 (= 別 Q-entry に存在しないもの) が混入していないか
- README Status 行と各 doc Status banner の zip

**典型 issue 形**:
- placeholder の fill 内容が既 written prose を短縮 / 二重化
- placeholder の `<!-- ... -->` 内で 「parameter reachability」 等未 ratify 概念が混入
- README Status が `skeleton` だが該当 doc は §1〜§2 既 written

## 軸 10: SIMD surface

**対象**: `docs/01-dsl.md` §6 (= SIMD)、 `docs/12-canonical-examples.md` SIMD exercise Ex

**重点 prose**:
- SIMD primitive 一覧 (= `vec4` / `splat` / `addVec` / `subVec` / `mulVec` / `divVec` / `sumLanes` / `vec.lane`)
- canonical exercise (= 全 primitive が 1 度ずつ動く)
- stride check (= `forSample.byN` の constant / divisor)
- generic `Buffer<T>` 上の SIMD method (= `loadVec` / `storeVec`)

**典型 issue 形**:
- SIMD primitive 一部が declare されているが canonical で 1 度も exercise されていない (= AGENTS.md HARD CONTRACT 違反)
- stride check の検出段階 (= graph-capture vs static-analysis) が章ごとに違う

## 軸 11: main-thread typed surface

**対象**: `docs/05-client.md` 全章 (= `UnworkletNode<C>` 全 surface)

**重点 prose**:
- `UnworkletNode<C>` の全 member (= `.params` / `.state` / `.events` / `.messages` / `.midi` / `.outputs` / `.inputs` / `.onError` / `.dispose` / `.snapshot` / `.restore`)
- 各 surface の識別子 narrow (= declared name の literal-union)
- error handler 引数型 (= discriminated union)
- wrapper vs raw `.node` access

**典型 issue 形**:
- bullet 列挙に snapshot/restore 抜け
- onError handler 引数型が prose / 型 declaration のどこにも書かれていない
- wrapper の connect/disconnect overload set が prose ナシ

## 軸 12: test / offline determinism

**対象**: `docs/06-testing.md` 全章、 `docs/13-offline-render.md` 全章、 `docs/10-roadmap.md` §1 (= acceptance criteria)

**重点 prose**:
- `@unworklet/offline` config 形 (= `duration` / `inputs` / `params` / `messages` / `events` / `backend`)
- `@unworklet/test` matcher (= `expectAudioMatches` / `expectStateMatches`)
- acceptance criteria (= A1〜A3 / B1〜B2 / C1 / D1 / E1〜E2 / F1)
- pure-JS と WASM の bit-exact 約束

**典型 issue 形**:
- offline 入力音声形が multi-channel processor で表現不能
- backend 選択 flag の具体 key 名が仕様不在
- acceptance criteria の数え上げが Q ratify 文言と揃わない
