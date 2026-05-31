# DevTools 統合 — 引き継ぎ資料

> **対象読者**: DSL 4 概念再編([issue #10](https://github.com/yuichkun/unworklet/issues/10))が**完了した後の repo** で、
> vite-plugin DevTools を mock → 本物データに繋ぎ込むタスクに着手する、未来の AI エージェント(= あなた)。
>
> **使い方**: 余湖さんが「このファイル見てやっていこう」と声をかけたら、ここから着手意識を完全復元する。
> §1(ゴール意識)を最初に装填し、§2(再確認すべき情報)を現物で裏取りしてから、§3 以降を fact として使う。
>
> このファイルは、devtools 統合の**直前に丸 1 セッション費やして徹底調査した結果**を自己完結で転記したもの。
> 当時の調査ログ(workflow 出力 / plan file)は揮発する前提で、要点は全てここに写してある。`file:line` は
> #10 前のものなので**シンボル名でも探せるように**書いてある(#10 で行はズレる)。

---

## §1. ゴール意識（超重要 — まずこれを装填しろ）

このタスクの**超最優先は、信頼できる・精度の高い devtools を作ること**。これは余湖さんが何度も明言した。

- **間違った値を一瞬でも出したら終わり。** devtools なのに値が違うのはシャレにならない。WASM linear memory を
  読む以上、**読み間違いは絶対に許されない。** 死ぬほどしっかりテストを書く。
- **mock を 1 つも残すな。** 「うまくいったふうに見せるために適当に繋ぐ」のは一切禁止。本物に無いものは
  偽の値を出さず「未実装」と正直に表示する。
- **2 つの hard 制約:**
  1. **zero-config** — vite に unworklet devtools を入れたら、**他に何もしなくても勝手に全部 devtools に
     反映される**のが理想。main thread のアプリコードから面妖な API を叩く形は禁止。
     → 正しさの test: **devtools plugin を外しても、アプリは一切変わらず動く。**
  2. **zero-misread** — WASM memory の読み間違いゼロ。最後に Chrome 操作権限をもらって、**実メモリの真値と
     UI 表示値が一致するか自分で突き合わせる**(§6)。
- **RC-20 風アプリを作ることは瑣末。** あれは devtools に本物データを供給する土台に過ぎない。**本丸は繋ぎ込み。**
- これは production-ready な audio devtools を作る仕事。**audio developer 界隈、ひいては音楽業界全体の発展に
  繋がる。** だからこそ前例のない testing package も作った。心して作れ。
- **進め方**: 余湖さんと「あなたが作業 → 余湖さんが確認 → commit」を **1 箇所ずつ**。一気に更新しない。

---

## §2. 着手時に必ず再確認すべき情報（#10 で変わったはず = fact 扱い禁止、現物を読め）

issue #10 は「保存・伝達プリミティブを 4 概念(state / param / event / audio)に再編」。**単なる rename ではなく
宣言モデルの構造変更**を含む。devtools は宣言モデルと linear memory layout を読むので、以下は **#10 のコミットで
変わっている。着手時に現物(`compile/ast.ts` / `compile/layout.ts` / `worklet.ts` / `client.ts` / `snapshot.ts` /
`types.ts` / `devtools-ui/src/`)を読み直してから §3 の fact を更新せよ。**

| #10 の変更                                                                                                      | 影響する devtools 箇所                                                               | 着手時に確認すること                                                                                                                |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **`message` + `event` + `midiInput/Output` → 1 つの `event` family**(direction-aware、`from`/`to`/`event.midi`) | declared-shape の `kind` enum、MIDI port 一覧、events/messages 読み(Wire 1 / Wire 5) | `graph.declarations` の kind 構成、`ast.ts` の `Declaration` union がどう変わったか。旧 3 分割前提のフィルタは全部書き直し          |
| **`buffer.f32` → `state.buffer.f32`**                                                                           | X-ray の buffer 読み                                                                 | **内部 layout の `buffers` region が残ったか / state に merge されたか**を `layout.ts` で確認。これが X-ray の buffer offset に直結 |
| **`load`/`store` → `read`/`write`**                                                                             | なし(authoring rename)                                                               | 内部 AST(`stateLoad`/`stateStore`)と layout が不変か念のため確認                                                                    |
| **`publish` → 「state に reader を足す」**                                                                      | publish badge 表示のみ(X-ray は publish path を使わない設計、§4)                     | core の X-ray は無傷のはず。badge 用 metadata の取り方だけ確認                                                                      |
| **B1: postMessage transport を zero-alloc 化**                                                                  | events/MIDI 配信(Wire 5)                                                             | `worklet.ts`/`client.ts` の transport を読み直す。X-ray(snapshot port 経路)は別系統                                                 |
| **B5: `node.state/events/midi/params` の per-name 型 narrowing**                                                | page bridge が消費する public surface の**型**                                       | mapped types でどう narrow されたか                                                                                                 |
| **B7: event `atSample` を online/offline で揃える**(block-local in payload)                                     | events 表示                                                                          | payload の atSample 形                                                                                                              |

**#10 が据え置くべきもの(X-ray を無傷に保つ guardrail、#10 担当に申し送り済):** 内部 layout の `states`/`buffers`
region 分割と snapshot scalar codec は authoring API だけ rename し、**byte offset / decode は据え置く**。これが
守られていれば §3b/§4 の X-ray は offset 直読みのまま無傷。守られていなければ X-ray の read 側を retarget する。

---

## §3. fact として信頼してよい情報（#10 非依存・モデルを跨いで安定）

ここは実コードで裏取り済みの精度の土台。**着手時に 1 度は現物で再確認**してよいが、構造は #10 を跨いで安定。

### §3a. realm 構成と transport（devframe / devtools-kit）

- **3 realm**:
  - **AudioWorklet thread** — WASM linear memory(全 state/buffer の**真値**)。
  - **page main thread** — `createNode` / `UnworkletNode` / SAB mirror / `AudioContext` / 全 `AudioNode`。
    `@vitejs/devtools` が `inject.js` を transformIndexHtml で注入し `window.__VITE_DEVTOOLS_CLIENT_CONTEXT__`
    をセット(**top page = `window.parent===window` の時だけ**)。page script は `getDevToolsClientContext()`
    で devframe **client** を取れる(`@vitejs/devtools-kit/dist/client.d.ts:147,151`)。
  - **Node dev server** — vite-plugin の `setupDevtools(ctx)`。RPC / sharedState / streaming を**全て server 側で**
    登録。**唯一の hub。**
  - **iframe panel** — Vue SPA(`/__unworklet/`)。これも devframe client(page とは別 WS)。
- **決定的事実**: cross-realm 通信は**全て birpc 経由で Node server を必ず通る。直接 page↔iframe は無い。**
  **client は shared state を mutate 不可(server だけ)。** client→server は `streaming.upload` か action RPC。
- **runtime データ経路(必然)**:
  ```
  AudioWorklet ──(port.onmessage block-atomic dump / SAB)──▶ page main
  page main    ──(devframe streaming.upload or action RPC)──▶ Node server
  Node server  ──(sharedState.mutate or streaming)─────────▶ iframe panel
  ```
  compile-time データ(§3d)は page を経由せず Node→iframe だけで済む(一番簡単)。
- **devframe API（server）**: `ctx.rpc.register(defineRpcFunction({name,type:'query'|'action'|'static',setup}))` /
  `ctx.rpc.sharedState.get(key,{initialValue})` → `.value()`/`.mutate(draft=>…)` / `ctx.rpc.streaming.create(name,{replayWindow})` /
  `ctx.rpc.broadcast({method,args,optional})`。
- **devframe API（client = page も iframe も）**: `getDevToolsRpcClient()` / `getDevToolsClientContext()` →
  `client.rpc.call(name,...args)` / `sharedState.get(name)` → `.value()`/`.on('updated', cb)` /
  `streaming.subscribe(name,id)` / `streaming.upload(name,id)` / `client.rpc.client.register({name,type,handler})`。
- **一次情報**: `@vitejs/devtools-kit` 同梱の `skills/vite-devtools-kit/SKILL.md` + `references/*.md`
  (rpc / shared-state / streaming / remote-client / dock-entry / project-structure)。これが公式の使い方 doc。
  パスは `node_modules/.pnpm/@vitejs+devtools-kit@*/node_modules/@vitejs/devtools-kit/skills/`。

### §3b. WASM memory 読みの精度基盤（snapshot codec / layout / block-atomic）— ここが命

- **layout が全 slot の byte offset を持つ**(`compile/layout.ts`、`layout()` 関数):
  - `layout.regions.states.slots[name]` / `layout.regions.buffers.slots[name]` は **named/匿名(`__state_N`/`__buffer_N`)
    問わず全 slot** の byte offset。**declaration 順で決定論的**、schema 安定。
  - state byte size: f32/i32/bool=4、f64/i64=8(`STATE_SLOT_BYTES`)。buffer は `size × elementBytes`、u8=1。
  - DataView を明示 byteOffset で使えば alignment 不問(midiRings 前だけ `align4`)。
- **codec は単一 source**(`packages/core/src/snapshot.ts`、**全 little-endian**):

  | type       | bytes | decode                                                                 |
  | ---------- | ----- | ---------------------------------------------------------------------- |
  | f32        | 4     | `getFloat32(off, true)`                                                |
  | f64        | 8     | `getFloat64(off, true)`                                                |
  | i32        | 4     | `getInt32(off, true)`                                                  |
  | i64        | 8     | `getBigInt64(off, true)`（**BigInt**）                                 |
  | bool       | 4     | `getInt32(off, true) !== 0`（**4-byte word を読む**、1-byte 読み禁止） |
  | u8(buffer) | 1     | `Uint8Array`                                                           |

  byte size 表 = `SNAPSHOT_ELEMENT_BYTES`(snapshot.ts:17)。`decodeScalar`/`decodeTypedArray`/`encodeScalar` がそれ。

- **worklet は既に正しく読んでいる**: `worklet.ts` の `captureSnapshotSlots`(着手時点では `:865` 付近)が
  `lay.regions.states.slots[name]` / `buffers.slots[name]` から layout offset で全型を読んでいる。
  **`port.onmessage` は render quantum の境界で走る = 構造的に block-atomic(torn read が原理的に起きない)**
  (worklet.ts 内に「render quantum の境界で走る…構造的に block-atomic」と明記)。**snapshot は SAB 不要 =
  postMessage request/response。**
- WASM instance / memory は **worklet 内に閉じている**(`new WebAssembly.Instance`、`memory = exports["memory"]`)。
  **main / iframe は WASM memory に直接触れない。** main に渡るのは別途確保した mirror SAB(publish / ring)だけ。

### §3c. ⚠ #1 catastrophe vector（絶対に忘れるな — これで全 f32 を静かに誤読しうる）

live state には decode path が **2 つ**ある:

- **publish/SAB path**: `node.state[name].value` → `Atomics.load(Int32Array, i*3)` →
  **Int32Array→Float32Array で bit-reinterpret**(`convertStateValue`、`client.ts:489-492`)。
  これは **throttled な publishShared mirror**。`DataView.getFloat32` ではない。
- **states-region path**: `layout.regions.states.slots[name]` を WASM memory から `decodeScalar`(DataView, LE)。
  これは **WASM-private な作業 slot**、block-atomic。

**この 2 つは別の memory location。混同すると静かに誤読する。**
**鉄則: decode path はデータの出自で選ぶ。型では選ばない。**

### §3d. compile-time metadata（page bridge 不要・Node-side で即 real）

- `compile(processor)` → `CompileResult{ wasm, graph:GraphJson, memory:MemoryJson, diagnostics:DiagnosticsJson,
schemaHash, driver }`(`compile/index.ts` / `types.ts:668-676`)。`graph` は `CapturedGraph{declarations,statements}`、
  `memory` は `Layout`、`diagnostics` は `DiagnosticEntry[]`。
- **`DiagnosticEntry = { id:string, severity:'error'|'warning', message:string }` だけ**(`analyze.ts:20-24`)。
  UI の `BuildIssue{code,level,nodeId,src,message,why,fix,snippet}` より**痩せている**。
  → `id` をそのまま `code` に使う(UWK000x 体系に無理に合わせない = diagnostics ID↔code blocker 解消)。
  `why/fix` は静的 `id→{why,fix}` 表、`src`/`snippet` は source 位置が無ければ degrade。
- plugin は `?worklet` ごとに `compile` 済 + `extractWorkletMeta`、`allowedSources:Set`(着手時点 `index.ts:470`)と
  `snapshotsBySource:Map`(`:490`、直近 2 revision)に cache。**setupDevtools は init 時に走る(compile は async な
  load hook)** ので、diagnostics は load ごとに incremental に積むか、iframe が pull する RPC で読む。
- **最初の wiring** = server RPC `unworklet:get-processors` を `setupDevtools` に登録し、real graph/memory/diagnostics/
  schemaHash を返すだけ(page bridge 不要)。今の **mock diagnostics(`setupDevtools` の `ctx.diagnostics.logger.UWK000x`
  ハードコード、`index.ts:372-426`)を削除**。
- `node` 同定 = `(processorName, moduleUrl, schemaHash)` triple(`types.ts:574-591`、全 readonly = lifetime 不変)。

---

## §4. 設計の核心判断（調査で確定済み・これを守れ）

- **Live state panel = 「states/buffers region の block-atomic dump 一本」+ 単一 codec。** publish SAB path は
  **devtools では一切使わない。** 理由:
  1. 余湖さんの決定「全 slot を見せる(publish していない内部 state/buffer も dev で自動 X-ray)」を満たす唯一の道。
     非 publish slot は SAB mirror が無く、main は WASM memory に触れない → **worklet が自分の memory を読んで
     post する**しか道が無い。
  2. decode path が **1 本だけ**になり、§3c の #1 catastrophe が**構造的に起き得ない。**
  3. **block-atomic(quantum 境界)= torn read 無し。**
  4. **読み側(worklet dump)と test oracle が同一 layout + 同一 codec を共有 = 値がズレる余地が構造的に無い。**
     これが「読み間違いゼロ」の根拠。
- **実装** = worklet の snapshot 機構の **filter(`userNamed && persistent`)を外した dev-only「全 slot dump」message**。
  既存の block-atomic / dispose・processorerror・hang guard をそのまま再利用する。
- `publish` flag は metadata から **badge("app-visible")表示のみ**。読み経路ではない。
- **i64 を realm 越えで運ぶ時は structuredClone transport を使う**(`jsonSerializable:true` にしない = BigInt 保持)。
  JSON 化は禁止(2^53 超で破綻)。
- **page bridge は未実装の lynchpin(これを作るのが本丸)。zero-config を満たすため全て dev 限定・prod no-op:**
  1. **core: 自動 dev node registry** — `createNode` が live node を**無条件に**登録(user API 呼び出しゼロ)、
     `dispose` で解除。prod では tree-shake / no-op(`@unworklet/core/dev` subpath か `import.meta.env.DEV` gating)。
     **着手時点で core に registry は存在しない**(grep 空)= 新規。
  2. **plugin: dev page script の注入** — `transformIndexHtml`(dev のみ、`enforce:'post'` で devtools global を先に
     確定)。この script が ① `AudioNode.prototype.connect/disconnect` monkey-patch(graph topology)② registry から
     live node 発見 ③ block-atomic dump で live state 取得 ④ `getDevToolsClientContext()` で devframe server に push。
     **アプリコードは一切書かない。着手時点で plugin は page に script を注入していない**(`setupDevtools` は dock
     登録 + static host + mock のみ)= 新規。

---

## §5. wiring 順（簡単・安全 → 難。各 step = 作業→確認→commit、各 step 末で該当 mock を削除）

1. **Wire 1 — compile metadata panels(bridge 不要・即 real)**: declared shape / diagnostics / memory / MIDI port 一覧。
   server RPC `unworklet:get-processors`。plugin の mock diagnostics と `useMockGraph` の静的部分を削除。
   (#10 後は kind マッピングを最終 event family に retarget)
2. **Wire 2 — page bridge + live state 1 slot を端から端まで(精度の本丸の最初の縦切り)**: core 自動 registry +
   plugin page-script 注入 + worklet dev「全 slot dump」を実装し、**まず 1 個の f32 state slot**を表示。
   **4-way 突き合わせを gate**: ① `renderOffline` の oracle 値、② `node.snapshot()`→`decodeSnapshot`、
   ③ block-atomic dump 値、④ iframe 表示値 を **bit 一致**(生バイト比較、float `===` 禁止)で assert。
3. **Wire 3 — live state を全 slot / 全型 / buffer に拡大**: f32/f64/i32/i64/bool/u8 + 匿名 slot +
   edge 値(NaN/±Inf/i64>2^53/負)を死ぬほどテスト。大 buffer は decimate。representation(waveform/bar/grid/
   hex/list)を type 駆動に。`useLiveStateMock` 完全削除。
4. **Wire 4 — graph topology**: `AudioNode.prototype.connect/disconnect` monkey-patch + registry → sharedState。
   **#10 非依存**(authoring DSL ではなく Web Audio 層)。`useMockGraph` 完全削除。
5. **Wire 5 — events / MIDI activity / inject**: public surface(`node.events`/`node.midi`)→ streaming + inject RPC。
   **#10 の event family 統合の直撃**なので必ず #10 後の最終モデルで。`useMockMidi` 完全削除。
6. **Wire 6 — signals / latency(新 infra、最後・正直に)**: AnalyserNode auto-splice(signals)+ worklet process()
   計測 instrumentation(latency = 着手時点で本物 source 無し)。作るまで panel は「未実装」表示(mock は消す)。
   `useMockSignals` 完全削除。

**終了条件: `devtools-ui/src/composables/` の 4 mock(useMockGraph/useMockSignals/useMockMidi/useLiveStateMock)が
全削除され、全 panel が本物 or 正直な「未実装」。**

---

## §6. テスト（zero-misread の守り）+ 最終 Chrome 突き合わせ

- **offline oracle**(`renderOffline`、決定論): 既知 DSP の processor を N quantum render 後、全 slot 値を独立計算し、
  dump が**型ごとに byte 一致**で返すことを assert。`@unworklet/test`(40+ matcher、`expectStateMatches` の
  byte-exact 比較等、`packages/test/src/index.ts`)を使う。
- **block-atomic dump の単体テスト**: 既知 state を仕込み、全型 + buffer + 匿名 slot + edge 値で exact byte。
- **browser e2e**: `@vitest/browser-playwright`、COOP/COEP、real chromium SAB(`packages/core/vite.browser.config.ts`)。
  既存 `packages/core/src/__tests__/browser/stereo-gain.test.ts` の harness/fixture が使える。
  devtools-read 値 == WASM 値 == offline oracle を **bit 一致**で。
  (注: ハング厳禁。`vp test … run` + tool timeout で囲む。)
- **最終 Chrome 突き合わせ(余湖さんが chrome-devtools 操作権限を付与、自分で実行)**: 可能と確認済み。
  devtools-proto 起動 → panel に live state 表示 → chrome-devtools MCP `evaluate_script` で**独立に真値**を取得
  (`node.snapshot()`→`decodeSnapshot`、および同入力の `renderOffline`)→ **iframe 表示値と bit 一致**を検証。
  panel 値は同じ worklet dump 由来なので、正しければ必ず一致、ズレれば本物の bug を捕捉。
  **iframe/page console から worklet thread の WASM memory は直読み不可** → 真値は `node.snapshot()`/`renderOffline`
  という公開・block-atomic 経路で取る(これが信頼できる ground truth)。

---

## §7. 正直な gap（偽装するな・mock を残すな）

- **latency**: core に `process()` 計測器が無い。worklet-thread instrumentation の新規実装が要る(Wire 6)。
- **audio scope / spectrum**: AnalyserNode auto-splice が未実装。新規(Wire 6)。
- **diagnostics の richness**: real は `{id,severity,message}` だけ。`why/fix` は静的表、`src/snippet` は source 位置が
  無ければ degrade。
- **UI 構築物**(本物 source が無い / UI が合成しているだけ): `rateFps` per slot、480k ring、latency 統計、
  MIDI log の wall-clock `ts` + `inject` direction。本物に無いものは mock を消して「未実装」を明示。

---

## §8. 供給源アプリ（RC-20 風ラック + MIDI シンセ）— devtools コードはゼロ

繋ぎ込みに本物データを供給する、**実際に鳴る複数 unworklet node のアプリ**を `experiments/devtools-proto/` に作る
(余湖さん決定)。**「リアルなユーザーのシミュレーション」= devtools plugin を入れ、`@unworklet/test` でテストも
書く、普通の unworklet アプリ。devtools 固有のコードは一行も書かない**(これが zero-config の検証になる)。

- **RC-20 風ラック**: 6 unworklet node 直列(Noise→Wobble→Distort→Digital→Space→Magnetic)、**file-picker で
  任意音声を loop 再生**して通す。各モジュールは内部 state/buffer を持つ(X-ray が全部読む。数個だけ reader/publish を
  付けて "app-visible" badge を実演)。
- **MIDI シンセ node**: シンセ風の見た目、**Web MIDI 入力**を受けて音を作る別 node。audio graph に載る。
  MIDI panel に real port + events を供給し、graph node も増やす。
- 全モジュールは `renderOffline` + `@unworklet/test` でオフライン検証(DSP の数値的正しさ)。

---

## §9. 一次情報の場所（実コード根拠）

- **精度の土台**: `packages/core/src/compile/layout.ts`(全 offset)、`packages/core/src/snapshot.ts`(codec)、
  `packages/core/src/worklet.ts`(block-atomic 読み、`captureSnapshotSlots` 付近)、
  `packages/core/src/client.ts`(公開 surface + publish decode)。
- **compile 成果物**: `packages/core/src/compile/index.ts`、`packages/core/src/compile/analyze.ts`(DiagnosticEntry)、
  `packages/core/src/types.ts`(CompileResult / UnworkletNode / WorkletNamespace)。
- **plugin**: `packages/vite-plugin/src/index.ts`(`setupDevtools` の mock、4 JSON artifact emission、allowedSources /
  snapshotsBySource cache、`transformIndexHtml` を足す場所)。
- **UI 契約 + 削除対象 mock**: `packages/vite-plugin/devtools-ui/src/composables/{useMockGraph,useMockSignals,
useMockMidi,useLiveStateMock}.ts` + `views/{AudioGraphView,LiveStateView,SignalsView,MidiView}.vue`。
- **テスト基盤**: `packages/test/src/index.ts`、`packages/offline/src/index.ts`、
  `packages/core/vite.browser.config.ts`、`packages/core/src/__tests__/browser/stereo-gain.test.ts`。
- **devframe transport**: `@vitejs/devtools-kit` の `dist/{client.d.ts,node/index.d.ts}` + 同梱
  `skills/vite-devtools-kit/{SKILL.md,references/*.md}`。
- **issue #10**: <https://github.com/yuichkun/unworklet/issues/10>(この devtools タスクの**前提**。完了確認してから着手)。

> **最後に**: 迷ったら §1 に戻れ。基準は docs ではなく**プロダクトの方向性**(declarative / 型⟺動く / realtime-safe /
> user free / **信頼できる高精度 devtools**)。実装の真偽は **1 次情報(source + 自分のテスト実行)**で確認し、
> このファイルや memory の claim も着手時に裏取りする。本気で作れ。
