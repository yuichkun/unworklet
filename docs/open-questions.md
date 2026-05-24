# Open questions

unworklet v1.0.0 spec が impl AI agent によって矛盾なく実装されるための残 grill 項目。 ratify されたら `decisions-log.md` に移してこの file から削る。

全 22 entry、 priority 軸 = 「impl AI agent がこの docs だけで手放し実装した時に矛盾 / 揺れが出るか」 重大度。

- **P1 = 6 件**: ship blocker (= wire byte が drift / canonical 自身が build 不能 / 同 source code で別 impl が reproducible でない)
- **P2 = 16 件**: 仕様 invariant + lifecycle (= public surface completeness / mental model / placeholder zip)

---

## P1 — ship blocker 系 (6 件)

### cluster (5) realtime safety invariant (3)

## handler body 内 で build-time for unroll し な が ら runtime Node を ref す る pattern が legal か

**場 所**: `docs/01-dsl.md:514-516`、 `docs/01-dsl.md:524-528`、 `docs/01-dsl.md:545`、 `docs/12-canonical-examples.md:583-587`

**何 が 起 き て い る か**: canonical Ex 5 で `upload.onReceive(samples => { const stride = max(i32(1), div(samples.length, WAVEFORM_FRAME)); for (let i = 0; i < WAVEFORM_FRAME; i++) { const srcIdx = mul(i, stride); waveformView.write(i, select(lt(srcIdx, samples.length), samples.at(srcIdx), 0)); } })` の 形 で 「build-time JS for unroll の 各 iteration で runtime Node (`samples.length`) を ref」 す る pattern を 使 う。 こ の pattern (= 各 iteration で 同 一 runtime read を share す る emission か / iteration ご と に 新 read か) が prose で declare さ れ て な い。 ま た `select` で bounds check し て 「out-of-range な ら 0」 を 返 す 処 理 と `samples.at(idx)` 自 体 が 既 に prose で 「`select`-based carrier-clamp で wrap」 と あ り、 重 複 bounds check の 関 係 (= clamp + select の zip) が prose 不 明。

**impl AI 影 響**: impl AI は (a) iteration ご と に 新 read emit、 (b) 1 read を share、 (c) clamp と user-side select の zip を そ の ま ま emit (= 二 重 check)、 で 判 断 が 割 れ、 emit さ れ る WASM が 別 物 に な る。

**判 断 軸**: 「build-time for unroll 中 の runtime Node ref」 を legal pattern と し て prose で 明 文 化 し、 shared read / per-iter read の ど ち ら か を 仕 様 で 倒 す。 clamp と user select の 重 複 は 「user 側 を 信 用 し て 二 重 で 入 れ る」 か 「同 一 範 囲 の clamp は 1 つ に 統 合」 か。

---

## buffer write の runtime index out-of-range 振 る 舞 い

**場 所**: `docs/01-dsl.md:351`、 `docs/01-dsl.md:545`、 `docs/12-canonical-examples.md:586`

**何 が 起 き て い る か**: prose は 「buffer の range 制 約 は graph-capture で 強 制」 と 言 う が、 canonical で `srcIdx = mul(i, stride)` (= runtime computed Node) を `samples.at()` に 渡 す pattern を 既 に 使 用 し て お り、 graph-capture で 静 的 範 囲 確 認 不 可。 別 prose で 「out-of-range `.at(idx)` reads は select-based carrier-clamp で wrap」 と あ る が、 こ れ は typed-array-field proxy `.at()` で あ り、 `Buffer<T>.read(idx)` / `Buffer<T>.write(idx, v)` で runtime index を 渡 し た 時 の 振 る 舞 い (= clamp / wrap / trap) が prose で declare ナ シ。

**impl AI 影 響**: impl AI は (a) runtime out-of-range write を graph-capture で reject (= 静 的 解 析 不 可 で 実 装 困 難)、 (b) select carrier-clamp で safe wrap、 (c) runtime trap で 音 切 れ、 で 判 断 が 割 れ、 user code が DSP loop 内 で 数 sample 飛 ば す か 0 fill す る か 全 く 別 物 に な る。

**判 断 軸**: `Buffer<T>.read` / `.write` の runtime index 振 る 舞 い を `samples.at` (= proxy) と zip さ せ て clamp path に 揃 え る か、 buffer 系 は trap (= UB) に 倒 す か。

---

## sysex content buffer の 容 量 設 定 path と overflow policy が surface に 不 在

**場 所**: `docs/11-midi.md:349`、 `docs/11-midi.md:356-373`、 `docs/00-foundations.md:212`

**何 が 起 き て い る か**: 11-midi §4.3 末 尾 で 「sysex content buffer は §4.5 と 一 致 し た 容 量 / overflow policy を 持 つ」 と declare。 し か し §4.5 は MIDI **slot ring buffer** の 容 量 / overflow しか 書 い て お らず、 sysex 用 の variable-length content buffer の 容 量 設 定 path (= `payloadCapacity` 相 当 の declaration option) が `midiInput({ name, capacity })` surface に な い。 overflow 時 の drop 単 位 (= sysex event 全 体 を drop か、 byte 単 位 で truncate か、 slot だ け drop し て content は 諦 め る か) も 規 定 ナ シ。

**impl AI 影 響**: impl AI が sysex content buffer の 容 量 を (a) 固 定 default、 (b) `capacity × MAX_SYSEX_LEN` 自 動 算 出、 (c) 別 option を declaration に 生 や す、 で 振 れ る。 overflow 時 動 作 も sysex 全 体 drop / byte truncate (= 破 損 デ ー タ で handler 発 火) / slot 単 体 drop で 全 く 別 物 に な り、 foundations §5.1 「ringbuffer overflow は drop-and-report」 invariant が cover す る path も 不 明 確。

**判 断 軸**: sysex content buffer 容 量 を declaration option (= `payloadCapacity` か `sysexCapacity` 等) と し て 11-midi surface に 立 て る か、 「slot capacity か ら 自 動 算 出 + 固 定 default」 で prose 規 範 化 す る か。 overflow policy は 「sysex event 全 体 drop」 一 本 化 推 奨 (= byte truncate は audio thread で 破 損 デ ー タ を handler に 渡 す こ と に な り invariant 違 反)。

---

### cluster (6) MIDI declaration + sysex inbound (1)

## MIDI declaration の name 必 須 性 + 同 名 input/output 衝 突 + sysex inbound shape

**場 所**: `docs/01-dsl.md:333-340`、 `docs/11-midi.md:33-39`、 `docs/11-midi.md:48`、 `docs/11-midi.md:100-109`、 `docs/11-midi.md:114`、 `docs/11-midi.md:254`、 `docs/11-midi.md:275-279`、 `docs/11-midi.md:312`、 `docs/12-canonical-examples.md:1197`

**何 が 起 き て い る か**: 3 つ の 矛 盾 が 1 surface (= MIDI declaration) に 同 居。 (1) `state` / `buffer` / `param` は name optional (= snapshot 時 だ け 必 須) だ が `midiInput` / `midiOutput` は 常 に required と prose に あ り、 declaration 種 ご と の name 必 須 性 一 覧 が prose で declare さ れ て な い。 (2) 同 一 processor で `midiInput({ name: 'shared' })` と `midiOutput({ name: 'shared' })` を 両 方 declare し た 時 の `node.midi.shared` method set (= input は send/connectFromWebMIDI、 output は onEvent) が prose で 規 定 さ れ て な い。 (3) sysex variant の `length: Node<'i32'>` field が emit-side で 必 須 と prose 明 言 だ が、 receive-side handler arg に も 同 じ field が あ る か は 11-midi §2.5 (= `({ data, atSample }) => ...`、 length destructure ナ シ) と canonical Ex 9 (= `({ data, length, atSample }) => ...`、 length destructure あ り) が 直 接 衝 突。

**impl AI 影 響**: name 必 須 性 で impl が (a) 全 declaration 一 律 必 須 化、 (b) MIDI だ け 別 ル ー ル、 で 分 か れ る。 同 名 衝 突 で (a) reject、 (b) 両 method 共 存、 (c) silent OK で 分 か れ る。 sysex inbound で (a) 同 一 variant 型 を inbound/outbound 共 有 し て length destructure 可、 (b) inbound は proxy `.length` 経 由 で variant 自 体 に length ナ シ、 で WASM emit / TS surface が 全 く 別 物 に な る。

**判 断 軸**: declaration 種 ご と の name 必 須 性 を 1 表 で prose 列 挙 す る か。 input/output 同 名 を reject す る か 共 存 さ せ る か。 sysex inbound 型 を outbound と zip さ せ る か 別 shape に 分 け る か (= canonical が 既 に length destructure し て いる の で 共 有 path 推 奨)。

---

### cluster (7) state/buffer publish 衝突 (1)

## state / buffer publish の main 側 surface と 衝 突 ル ー ル

**場 所**: `docs/01-dsl.md:333-340`、 `docs/01-dsl.md:336-337`、 `docs/01-dsl.md:379`、 `docs/05-client.md:42-43`

**何 が 起 き て い る か**: `state.publish` も `buffer.publish` も 同 一 main path `node.state.<name>` に zip し て expose す る と prose で あ り (= 「state / buffer 同 一 namespace」)、 同 名 で `state.f32(..., { name: 'meter' })` と `buffer.f32({ name: 'meter', publish: {...} })` を declare し た 時 の 振 る 舞 い (= graph-capture-time error か silent override か) が prose で 不 明。 ま た `publish` 設 定 が ナ シ の slot を main 側 で `node.state.<name>.value` / `.subscribe(handler)` 引 こ う と し た 時 (= type level で undefined か runtime no-op か) も prose で declare ナ シ。 `subscribe(handler)` の handler 引 数 型 (= scalar `T` か typed-array view か boolean か) が publish kind ご と に 何 を 渡 す か prose で 一 覧 declare ナ シ で、 特 に `state.bool` で publish 不 在 時 の main 側 surface が 不 確 定。

**impl AI 影 響**: impl AI は (a) state / buffer 同 名 を reject、 (b) `node.buffer.<name>` を 別 namespace に 分 け る、 (c) silent override、 で 判 断 が 割 れ、 ま た handler 型 で (a) `T` 統 一、 (b) buffer 専 用 別 signature、 で 分 か れ る。 publish 不 在 slot を main で 引 け る か も impl ご と に drift。

**判 断 軸**: state と buffer を 同 一 namespace に 揃 え る か 別 namespace に 分 け る か。 publish 不 在 slot を main side か ら 完 全 不 可 視 (= type level undefined) に す る か runtime ナ シ で expose は す る か。 handler signature を declaration kind ご と に narrow す る path に 倒 す。

---

### cluster (8) snapshot / restore lifecycle (1)

## `snapshot()` の 「graph-capture-time error」 が 何 を trigger に 検 出 さ れ る か

**場 所**: `docs/00-foundations.md:212`、 `docs/01-dsl.md:331`、 `docs/01-dsl.md:1055`、 `docs/01-dsl.md:1172`、 `docs/05-client.md:88`、 `docs/05-client.md:112`、 `docs/05-client.md` (§6.1 / §6.5)

**何 が 起 き て い る か**: prose で 「`snapshot()` を 呼 ぶ processor body は 全 slot に `name` 必 須」 と あ る が、 `snapshot()` 自 体 は main thread 側 の `node.snapshot()` で、 worklet 側 declare-time に は 評 価 さ れ な い。 「graph-capture-time error」 の 起 動 trigger が prose で 不 明 確 (= `snapshot: 'persistent'` flag を 持 つ slot が 1 つ で も あ れ ば trigger な の か、 `migrations` 引 数 の 有 無 で trigger な の か、 全 slot に 一 律 強 制 な の か)。 加 え て migrate 実 行 の thread (= main か audio か) が prose 中 で 「construction で catch」 「main で run し て か ら audio に hand off」 「block boundary で audio が apply」 が 並 立 し て お り timing が 1 path に 揃 っ て な い。

**impl AI 影 響**: name 強 制 trigger で impl が (a) 全 slot 一 律、 (b) persistent slot で trigger、 (c) migrations 引 数 で trigger に 分 か れ る。 migrate timing で (a) main で run し て post-migration blob を audio に 渡 す、 (b) audio thread で run (= 仕 様 違 反 リ ス ク)、 (c) hybrid に 分 か れ る。 後 者 は audio thread 例 外 path が 起 動 す る か 否 か に 直 結 す る た め 矛 盾 重 い。

**判 断 軸**: trigger は declaration-side flag (= persistent slot or migrations 引 数) と main-side 振 る 舞 い (= snapshot() 呼 び 出 し) ど ち ら で 起 動 す る か。 migrate の thread は 「main 側 で run し 完 了 後 audio 側 で apply」 path に 一 本 化 す る か。

---


## P2 — 仕様 invariant + lifecycle (16 件)

## payload length が build-time JS number と し て 取 れ る path が prose declare さ れ て な い

**場 所**: `docs/01-dsl.md:511`、 `docs/01-dsl.md:541-542`、 `docs/12-canonical-examples.md:583`

**何 が 起 き て い る か**: prose は 「message declaration が payload length を build time に pin し た 場 合、 `samples.length` が `Node<'i32'>` に 加 え て JS `number` と し て も 取 れ る」 と 言 う が、 そ の pin mechanism (= declaration option) が prose 内 で declare さ れ て な い。 `payloadCapacity` は 「reserved bytes」 = 上 限 で あ っ て 実 長 固 定 で は な い。 canonical で `samples.length` 経 由 の build-time for は 出 現 せ ず、 確 認 例 が 取 れ な い。

**impl AI 影 響**: impl AI は `.length` を 常 に `Node<'i32'>` で emit す る か、 declaration option で JS number 化 path を 別 mechanism で 入 れ る か 判 断 不 能。 build-time for unroll の bound に `length` を 使 え る か が 仕 様 か ら 引 け な い。

**判 断 軸**: pin mechanism (= 例 え ば `payloadShape` / `payloadFixed` 等 の 別 option) を 明 文 化 す る か、 「build-time JS number 化 path は 出 さ な い、 常 に `Node<'i32'>` で 通 す」 に 倒 す か。

---

## `emitIf` の constant-truthy reject が ど の context ま で 広 が る か

**場 所**: `docs/01-dsl.md:436`、 `docs/01-dsl.md:456`、 `docs/01-dsl.md:1296-1308`、 `docs/12-canonical-examples.md:1197`

**何 が 起 き て い る か**: prose は `emitIf` を `forSample` / `forSample.byN` / `everyNSamples` / handler bodies / per-block top の 5 context で 呼 び 可 と し、 constant-truthy (= `emitIf(true, ...)`) の reject を 「`forSample` 内 で error」 と だ け 明 言。 「per-block top の constant-truthy」 「`forSample.byN` 内 の constant-truthy」 「`everyNSamples` 内 の constant-truthy」 が reject 対 象 か silent OK か prose で 不 明。 per-block top で `emitIf(true, ...)` を 書 く と block ご と 1 emit = 344Hz emit = 256 ring 容 量 で 1 秒 以 内 overflow、 footgun pattern だ が prose で reject path 不 明。

**impl AI 影 響**: impl AI は (a) 全 context で reject、 (b) `forSample` 直 接 だ け reject で 他 silent、 (c) rate down 系 (`forSample.byN` / `everyNSamples`) は OK で 他 reject、 で 判 断 が 割 れ、 user code 動 く / 動 か な い が 実 装 ご と に drift。

**判 断 軸**: reject 対 象 を 「per-sample 系 (= forSample 直 接 + forSample.byN + 内 部 everyNSamples)」 一 括 か 「forSample 直 接 だ け」 か。 per-block top の constant-truthy を reject す る か silent OK か は 別 軸 と し て decide。

---

## `replaceProcessor` で ok: false 時 の new node lifetime

**場 所**: `docs/05-client.md:316-348`、 `docs/12-canonical-examples.md:1295-1305`

**何 が 起 き て い る か**: prose は ReplaceResult の ok: false branch で も `node` field を 返 す と declare し て 「runs on declaration defaults」 と あ る。 内 部 で 新 AudioWorkletNode を 既 に 生 成 し て いる た め、 caller が `result.node` を 使 わ ず return す る と (= canonical Ex 10 の 形) 「未 connected な default node」 が ぶ ら 下 が る 形。 dispose 責 任 が caller か framework か prose で declare ナ シ。

**impl AI 影 響**: impl AI は (a) ok: false 時 に framework が 内 部 dispose し て node field を null に、 (b) `result.node` を returned ま ま に し て caller dispose、 (c) silent leak、 で 判 断 が 割 れ、 long-running session で Web Audio リ ソ ー ス が 累 積 す る か 否 か が drift。

**判 断 軸**: dispose 責 任 を framework に 寄 せ る (= ok: false 時 は new node を internally drop) か、 caller に 寄 せ る (= `result.node` を 取 っ て dispose 強 制) か。 canonical Ex 10 が 戻 り 値 を 触 ら ず return す る 形 を 規 範 化 す る な ら framework 側 寄 せ 推 奨。

---

## handler context か ら subgraph method 呼 ぶ 時 の boundary が 明 示 ナ シ

**場 所**: `docs/01-dsl.md:582`、 `docs/01-dsl.md:839`、 `docs/01-dsl.md:1221`

**何 が 起 き て い る か**: §5.2 は subgraph method の 呼 び 出 し context を 「parent の forSample / per-block top」 2 ケ ー ス し か 言 及 せ ず、 §5.6.4 は 「handler 含 む 全 expression context か ら 呼 び 可」 と declare。 §9.1 は 「subgraph method が 内 部 で forSample を 開 く 形」 を declare す る が、 method が handler context か ら 呼 ば れ た 場 合 「内 部 forSample が handler context 内 で 動 く の か、 handler drain 後 の per-block context で 動 く の か」 prose 明 示 ナ シ。 Q56 で handler body の expression scope を forSample と 一 致 さ せ た が、 「handler 内 で 新 規 forSample を 開 け る か」 は 未 確 定。

**impl AI 影 響**: handler 内 で subgraph method 呼 び 出 し → method 内 で forSample を 開 く path で、 「handler 内 forSample 全 体 が block 開 始 時 に inline で 1 回 動 く 形」 と 「forSample が 独 立 の per-sample loop と し て drain 後 に 動 く 形」 で WASM emission が 別 物 に な る。

**判 断 軸**: handler 内 で forSample を 開 く こ と を (a) 禁 止、 (b) handler context 内 で inline 1 回 実 行 (= sample loop に な ら な い)、 (c) drain 後 の per-block context で 別 sample loop と し て 動 か す、 の ど れ に 倒 す か。 method 経 由 で 呼 ば れ る 場 合 も 同 path で 統 一。

---

## 「L1 / L2 / L3」 略 称 が enforcement layer と integration layer の 2 概 念 で 衝 突

**場 所**: `docs/00-foundations.md:222-226`、 `docs/00-foundations.md:54-55`、 `docs/01-dsl.md:553-596`、 `docs/03-compiler.md:61-82`

**何 が 起 き て い る か**: foundations §5.2 matrix と 03-compiler §2.4 は 「L1 = TS type error、 L2 = graph-capture-time、 L3 = static analysis」 と enforcement layer 名 を declare。 一 方 01-dsl §5 と foundations §3 Primitive 定 義 は 「L1 helper = pure TS function、 L2 subgraph = stateful、 L3 = no L3 placeholder」 と 全 く 別 概 念 を 同 略 称 で declare。 03-compiler だ け 「Layer 1 / Layer 2 / Layer 3」 と フ ル 語 表 記 で foundations の 「L1 / L2 / L3」 と 微 妙 に 表 記 違 い。

**impl AI 影 響**: impl AI が foundations §5.2 matrix の 「L2 rejects ...」 を 読 ん で error ID surface / DevTools 表 示 / error message 文 言 に 「L1」 「L2」 「L3」 label を 露 出 し た 時、 01-dsl §5 で 既 に 「L1 helper / L2 subgraph」 を 学 ん だ user の mental model と 直 接 衝 突。 ま た どち ら が canonical 表 記 (= 略 称 か フ ル 語 か) も 仕 様 か ら 取 れ な い。

**判 断 軸**: enforcement layer か integration layer の どち ら か 1 つ を 別 命 名 に 寄 せ る (= 例 え ば enforcement 側 を 「typecheck / capture / static」 等 の 機 能 語 に 変 え、 integration 側 は L1/L2/L3 の ま ま 残 す) path か、 両 方 を 別 命 名 に 寄 せ る path か。 略 称 衝 突 を 解 消 し な い と error surface 露 出 で user 混 乱 が 構 造 的 に 起 き る。

---

## No blocking I/O / No GC invariant の 静 的 検 出 path が inventory に 不 在

**場 所**: `docs/03-compiler.md:144-163`、 `docs/00-foundations.md:202-218`、 `docs/00-foundations.md:230-232`

**何 が 起 き て い る か**: foundations §5.1 で 「No blocking I/O on the audio thread」 「No GC pressure」 を invariant と し て declare し、 §5.2 matrix で 「Emission boundary に postMessage / fetch / console / sync-RPC を 出 さ な い」 「Emission + Runtime contract で alloc 系 を 出 さ な い」 と し て cover。 一 方 03-compiler §2.6 stable error ID inventory に は 該 当 する 静 的 check の ID が 1 件 も 列 挙 さ れ て な い (= scope-violation / allocation-on-audio-thread / memory-budget 等 は あ る が、 「user が L1 helper / handler 内 で `console.log(...)` を 書 い た 」 等 を 検 出 す る ID が 不 在)。

**impl AI 影 響**: impl AI が 「surface に な い か ら 自 動 的 に 防 げ る」 と 解 釈 し て 静 的 check pass を 実 装 し な い と、 user が L1 helper body 内 で `globalThis.postMessage(...)` や `setTimeout(...)` や `new Uint8Array(...)` を 書 い た 場 合 (= helper body は graph capture time に JS と し て 評 価 さ れ る) silent dead code と し て 通 過 し、 runtime で 1 度 も 実 行 さ れ な い こ と に user が 気 づ か な い footgun が 残 る。 ま た allocation-on-audio-thread 検 出 が `new Uint8Array` / object spread を 拾 う か、 `postMessage` / `fetch` / `console` も 同 一 ID で 拾 う か、 別 ID に 分 け る か も 仕 様 か ら 取 れ な い。

**判 断 軸**: invariant 5 つ ご と に 「対 応 す る 静 的 検 出 ID が inventory に 揃 う か」 を zip し て 確 認 し、 No blocking I/O / No GC に も 静 的 check ID を 立 て る か、 「surface に 無 い か ら 検 出 不 要、 helper body 評 価 で silent 化 さ れ る pattern は そ の ま ま」 と し て docs で 明 文 化 す る か。 後 者 を 採 る 場 合 も 「user が 書 い た postMessage は graph capture 時 評 価 で 1 回 だ け 走 る が runtime で は 1 度 も 動 か な い」 mental model を どこ か で declare 必 要。

---

## typed-array payload → `Node<T>` element type の mapping が 全 列 挙 で な い

**場 所**: `docs/01-dsl.md:511-518`、 `docs/03-compiler.md:156`、 `docs/12-canonical-examples.md:710,728-729`

**何 が 起 き て い る か**: 01-dsl §4.3 prose で payload typed-array → element `Node<T>` mapping を 「`Float32Array` → `Node<'f32'>`、 `Uint8Array` → `Node<'i32'>` (zero-extended)、 etc.」 と 2 例 + 「etc.」 で declare し、 残 り の typed-array 種 (= `Int8Array` / `Int16Array` / `Uint16Array` / `Int32Array` / `Uint32Array` / `Float64Array` / `BigInt64Array` / `BigUint64Array`) の mapping を 全 列 挙 で 書 か ず。 canonical Ex 6 は `message<{ steps: Int32Array }>` を 使 い、 `steps.at(s)` 戻 り 値 を `state.i32` に store す る pattern を 規 範 と し て 提 示 = `Int32Array` → `Node<'i32'>` を 暗 黙 と し て いる。 03-compiler §2.6 `payload-element-type-mismatch` も bulk `copyFrom` 限 定 で per-element `.at()` の type check 厳 密 度 を declare せず。

**impl AI 影 響**: impl AI が typed-array → element type mapping を 自 動 推 論 す る 際、 sign-extend か zero-extend か reject か で 全 typed-array 種 ご と に 振 れ る。 特 に `BigInt64Array` を `Node<'i64'>` に 自 動 lift す る か explicit な carrier 経 由 を 強 制 す る か、 `Float64Array` を `Node<'f64'>` に lift す る か `Node<'f32'>` に narrow す る か で 仕 様 surface が drift。 per-element `.at(idx)` 経 由 と bulk `copyFrom` 経 由 で 別 type check ル ー ル に な る か も 不 明。

**判 断 軸**: typed-array → `Node<T>` の mapping を 1 表 で 全 列 挙 (= 8 種 全 部) し、 reject す る 種 (= `BigInt64Array` 等 は v1.0.0 で 対 応 し な い 等) を 明 文 化 す る か。 per-element と bulk で ル ー ル を 揃 え る か 別 軸 で 切 る か も 同 時 に decide。

---

## canonical Ex 5 grain spawn 部 が elision comment で 残 り、 12 冒 頭 「self-contained」 規 律 違 反

**場 所**: `docs/12-canonical-examples.md:3`、 `docs/12-canonical-examples.md:31`、 `docs/12-canonical-examples.md:609-614`

**何 が 起 き て い る か**: 12 冒 頭 L3 prose が 「Every example is self-contained: top to bottom, **no `// ...` elisions, no "imagine the rest".**」 と 強 declare し て お り、 Ex 1 dispose コ メ ン ト ア ウ ト は 修 正 済 み (= beforeunload handler 経 由 で 実 code 化)、 残 る は Ex 5 grain spawn ロ ジ ッ ク (L609-614) の `// (round-robin assignment — illustrative; full unrolling omitted for brevity here would use a build-time for over NUM_VOICES with a select chain — production authors keep it explicit.)` elision。 `grainSpawned.emitIf(...)` 呼 び が 一 度 も 出 ず、 Coverage table L31 「`event<T>` Ex 5 exercise」 claim が 不 成 立。

**impl AI 影 響**: impl AI agent が Ex 5 を event<T> 規 範 emit と し て 参 照 す る と source を 見 失 う、 Coverage table と code の zip が 取 れ な い。

**判 断 軸**: Ex 5 grain spawn 部 を inline 完 結 で 書 き 直 す (= build-time for over NUM_VOICES + select chain で 全 voice 展 開、 `grainSpawned.emitIf(spawn, { ... })` を 加 え る) か、 12 冒 頭 prose を 「illustrative comment 許 容」 に 緩 め る か decide。 production-grade canonical 整 合 性 anchor 性 質 を 守 る な ら 前 者、 ただし voice allocation logic の 全 unroll は 数 十 行 規 模 で 余 湖 さ ん の canonical 設 計 視 認 領 域。

---

## `InspectionResult` の `head: number[]` field で f64 / i64 値 の precision 表 現 path が 仕 様 か ら 取 れ な い

**場 所**: `docs/05-client.md:99-108`、 `docs/decisions-log.md` (Q42 / Q47 / Q48)

**何 が 起 き て い る か**: `SlotInspection` 型 で `kind: 'buffer'` variant が `head: number[]` を 持 ち prose で 「first ~64 elements as preview」 と declare。 こ の `number[]` 表 現 を `buffer.u8` (u8、 0〜255)、 `buffer.i32` (signed 32-bit)、 `buffer.f32` (float32)、 `buffer.f64` (float64 = JS number 自 然)、 `buffer.i64` (53 bit 超 で precision loss 発 生) で 全 部 同 一 path で 表 す path が prose で 説 明 ナ シ。 `kind: 'state'` の `value: number | boolean` も `state.f64` / `state.i64` を 想 定 し た 表 現 ナ シ (= Q42 で publish は f64/i64 reject だ が snapshot は 別 軸 で f64/i64 を 受 け 得 る = declared blob を inspect す る path で precision 形 が 取 れ な い)。

**impl AI 影 響**: impl AI が `InspectionResult` 型 を 起 こ す 時、 (a) i64 / f64 を JS number に narrow し て 渡 し precision loss、 (b) `head: (number | bigint)[]` 等 union 化、 (c) variant ご と に `head` 型 を 切 り 替 え る 別 type formation (= `kind: 'buffer.i64', head: bigint[]` 等)、 で 3 way 以 上 に 割 れ る。 consumer 側 「preset preview を 数 字 で 表 示」 UI が impl ご と に 53 bit 超 の i64 値 で 値 が 変 わ る possibility。

**判 断 軸**: `state.f64` / `state.i64` / `buffer.f64` / `buffer.i64` が snapshot 対 象 か decide し (= Q42 で publish reject だ が snapshot は 別)、 snapshot 対 象 な ら `InspectionResult` 型 を bigint 含 む 形 に 広 げ る か、 「inspect は preview 限 定 で lossy OK、 正 確 な 値 が 欲 し い consumer は 別 path」 と 仕 様 で declare す る か。 v1.0.0 で inspect 範 囲 を `state.f32` / `state.i32` / `state.bool` + `buffer.u8` / `buffer.i32` / `buffer.f32` だ け に 限 定 し て i64 / f64 を inspect から 落 と す path も candidate。

---

## roadmap §3.1 が messaging §5.4 に な い 「event/message payload の torn read」 を 既 ratify と し て 主 張

**場 所**: `docs/10-roadmap.md:55`、 `docs/02-messaging.md:140-146` (= §5.4 既 written)、 `docs/02-messaging.md:113-130` (= §5.1 / §5.2 既 written)

**何 が 起 き て い る か**: roadmap §3.1 既 written prose で 「Double-buffered `buffer.publish` regions — eliminates torn reads on multi-byte published regions **and variable-length `event<T>` / `message<T>` payloads**」 と event/message payload の torn read を mitigation 対 象 と し て 既 ratify。 一 方 `02-messaging.md` §5.4 prose は torn read リ ス ク を 「`buffer.<type>` 共 有 region の copy が byte-wise」 「`state.f64` / `state.i64` の publish 拒 否 が 同 axis (Q27-f)」 に 限 定 し、 event/message payload の torn read に は 1 行 も 触 れ な い (= roadmap が messaging doc よ り 1 step 先 を 主 張)。 ま た roadmap §3.1 「Double-buffered `buffer.publish` regions」 が `state.f64 / state.i64` publish 解 禁 を v1.x.0 mandatory に 含 む か も 不 明。

**impl AI 影 響**: impl AI が v1.x.0 mitigation 実 装 を 開 始 す る 時、 (a) event/message payload の double-buffer 経 路 を §5.1 / §5.2 fixed-slot 構 造 の 上 に 設 計 す る 必 要 が あ る が、 §5.4 で torn read prose 不 在 の た め 「event/message payload で 実 際 に torn read が 起 こ り う る か」 の 仕 様 判 断 に 迷 う、 (b) `state.f64 / state.i64` publish 解 禁 が v1.x.0 mandatory に 含 ま れ る か で roadmap §3.1 限 定 / messaging §5.4 一 般 化 の どち ら を 信 用 す る か で 結 論 が 分 か れ る。

**判 断 軸**: messaging §5.4 を 拡 張 し て 「event/message payload の torn read リ ス ク + state.f64/i64 publish 拒 否 が 同 axis の deferral」 を 既 ratify と し て 明 文 化 す る path、 ま た は roadmap §3.1 「event/message payloads」 を retract し て v1.x.0 mandatory を 「buffer.publish 限 定」 に 倒 す path、 2 way で decide。 「state.f64/i64 publish v1.x.0 解 禁」 を 含 む か も 同 commit で 明 文 化。

---

## 同 名 で input と output を 両 方 宣 言 し た 時 の 観 測 用 数 字 が ど ち ら か 不 明

**場 所**: `docs/05-client.md:48-51`、 `docs/11-midi.md:312`、 `docs/decisions-log.md` Q47

**何 が 起 き て い る か**: main 側 で MIDI port ご と に 「あ ふ れ た 件 数」 を 観 測 す る surface (= `node.midi.<name>.diagnostics.overflowCount()`) が 公 開 surface に 出 て い る が、 こ の counter が input 側 の ring buffer overflow と output 側 の ring buffer overflow の どち ら を 数 え る か prose で 明 言 ナ シ。 別 entry で 「同 名 input/output 衝 突 を 許 す か 禁 止 す る か」 は 軸 と し て 立 っ て い る が、 仮 に 同 名 を 許 す path に decide し た 場 合、 こ の counter が ど ち ら 由 来 か / 両 方 を 合 算 す る か / 別 method (= `.inputOverflowCount()` / `.outputOverflowCount()` 等) で 分 け る か が dangling。

**impl AI 影 響**: impl AI が (a) input 側 counter を 返 す 実 装、 (b) output 側 counter を 返 す 実 装、 (c) 両 方 合 算、 (d) 同 名 を 禁 止 し た 上 で 1 方 向 の counter を 返 す、 で 4 way に 分 か れ る。 user 側 「な ぜ overflow し た か」 の debug path が impl ご と に 別 物 で、 同 source code が 別 impl で 観 測 値 が 一 致 し な い。

**判 断 軸**: 同 名 input/output 衝 突 軸 (= 既 entry) で 「禁 止」 と decide す れ ば 自 然 に 1 方 向 だ け で 解 消。 「許 す」 path を 採 る 場 合 は 「input / output で 別 method」 path 推 奨 (= `.midi.<name>.input.diagnostics.overflowCount()` 等 の 形 で 分 離)。

---

## 公 開 output / input wrapper の 接 続 method が AudioParam 接 続 / 部 分 切 断 で 何 を 受 け る か 不 明

**場 所**: `docs/05-client.md:38`、 `docs/05-client.md:46`、 `docs/05-client.md:50`、 `docs/05-client.md:230-238`、 `docs/12-canonical-examples.md:1304-1306`

**何 が 起 き て い る か**: 公 開 node に は 名 前 付 き wrapper (`node.outputs.<name>` / `node.inputs.<name>`) と raw AudioWorkletNode (`node.node`) の 2 系 統 が あ り、 §6.4 prose に 「typed wrapper の `.disconnect()` は 当 該 名 前 の output だ け、 raw `.node.disconnect()` は 全 output」 と い う 1 行 の 線 引 き は あ る。 一 方 で wrapper の `.connect()` / `.disconnect()` の 受 け る 引 数 (= 接 続 先 が AudioNode か AudioParam か、 input/output index を 取 る か 取 ら な い か、 引 数 ナ シ で 全 destination か) が prose で 全 く declare さ れ て い な い。 Web 標 準 の `AudioNode.connect/disconnect` は 6+4 overload を 持 つ が、 wrapper は そ の どれ を mirror す る か / 制 限 す る か 不 明。

**impl AI 影 響**: impl AI が wrapper を 実 装 す る 時、 (a) 全 overload mirror、 (b) `connect(dest: AudioNode, input?: number)` だ け / `disconnect(): void` 限 定 で 簡 易 化、 (c) AudioParam 接 続 (LFO modulation 等) を wrapper か raw か どち ら で 受 け る か decide で path が 3 way 以 上。 raw `.node` 経 由 で の 接 続 を どこ ま で 推 奨 / 非 推 奨 と す る か の 規 範 も canonical で 明 確 化 さ れ て お ら ず、 Ex 10 が raw を 使 う 一 方 で 他 Ex は wrapper を 使 う 混 在 で 推 奨 path が 取 れ な い。

**判 断 軸**: wrapper を 「特 定 の output index に 固 定 さ れ た 1 段 abstraction、 接 続 先 は AudioNode / AudioParam 両 方 受 け る、 input index は 引 数 で 取 る」 path で 明 文 化 す る path 推 奨。 全 destination 切 断 / 単 一 destination 切 断 の 引 数 形 も 1 か 所 で declare し、 raw `.node` 経 由 path は 「multi-output processor で 全 output を 一 括 で 触 る advanced 用 途」 限 定 と canonical に 落 と し 込 む。

---

## 関 数 と 観 測 用 数 字 を 同 居 さ せ た 公 開 surface の 構 造 が doc に declare さ れ て い な い

**場 所**: `docs/05-client.md:46-47`、 `docs/02-messaging.md:16-17`、 `docs/12-canonical-examples.md` (Ex 6 / Ex 9 で `node.messages.<name>(payload)` 形 使 用)

**何 が 起 き て い る か**: main 側 か ら worklet 側 に 1 回 だ け 送 る 用 の surface (= `node.messages.<name>`) が 「`(payload): void`」 (= 関 数 と し て 呼 ぶ) と 「`.diagnostics.overflowCount()`」 (= property と し て 観 測) の 両 方 を 同 一 識 別 子 で 提 供 し て い る が、 TS 型 declaration の 形 (= 関 数 と property の 同 居 を どう 表 現 す る か) が prose に declare ナ シ。 同 種 surface の 別 declaration 種 と 構 造 が 揃 っ て お ら ず、 worklet 側 か ら main 側 へ の event 系 surface は 「`.on(handler)` + `.diagnostics`」 形 で 関 数 部 分 を sub-method に し て お り、 messages だ け 直 接 callable + named member の 形。

**impl AI 影 響**: impl AI が `node.messages.<name>` の 型 を 出 す と き、 (a) 関 数 と property の intersection、 (b) callable object signature (`{ (payload): void; diagnostics: ... }`)、 (c) 関 数 部 分 を 別 method (= `.send(payload)`) に 分 け て events / midi と 揃 え る、 で 3 way に 分 か れ る。 同 時 に 「`const send = node.messages.upload; send.diagnostics.overflowCount()` が 動 く か」 が path ご と に 別 (= 構 造 分 解 し た 後 も diagnostics に reach で き る か は callable object か intersection か で 挙 動 が 異 な る)。 form の 領 域 と い う 意 見 も あ る が、 構 造 分 解 後 の 観 測 path 可 否 は user-observable な 挙 動 差。

**判 断 軸**: messages を 「`.send(payload)` + `.diagnostics`」 形 に 倒 し て events / midi と 構 造 を 揃 え る path、 ま た は 「callable + property」 形 を 明 文 化 し て 構 造 分 解 後 も diagnostics に reach で き る こ と を 仕 様 invariant と し て declare す る path、 2 way で decide。 前 者 は user が 覚 え る 構 造 が 1 種 類 で 済 む 利 点、 後 者 は 識 別 子 が 1 行 で 済 む 利 点 (= 既 canonical の 形 を 維 持)。

---

## offline で 渡 す 自 動 化 用 配 列 の 長 さ が online の 自 動 化 surface と 直 結 し な い

**場 所**: `docs/13-offline-render.md:32`、 `docs/05-client.md:42-43` (= `.params.<name>: AudioParam`)、 `decisions-log.md` Q18 (= per-block param 配 列 長 1/128/0)

**何 が 起 き て い る か**: offline で param 値 を 注 入 す る 形 が `params: { cutoff: [1000, 1000, /* per-sample or per-block */] }` 配 列 形 で 書 か れ、 prose 注 釈 が 「per-sample (= 128 値) or per-block (= 1 値)」 を 示 唆。 一 方 online surface は `node.params.<name>: AudioParam` で `setValueAtTime` / `linearRampToValueAtTime` / `exponentialRampToValueAtTime` / 別 AudioNode の connect (= LFO modulation) 全 部 受 け る。 offline で online と 同 等 の 自 動 化 を 再 現 す る path が 規 定 さ れ て い な い。 配 列 長 が k-rate=1 / a-rate=128 / no-automation=0 の 3 値 union な の か、 render 全 体 sample 数 (= `duration × sampleRate`) の curve を pre-compute し て 渡 す 形 な の か、 1 意 に 読 め な い。

**impl AI 影 響**: impl AI が (a) 3 値 union の per-block 配 列 を block ご と に 注 入 す る form、 (b) render 全 体 curve を 1 本 の Float32Array で 渡 す form、 で 二 way。 後 者 を 採 用 す る と offline 側 で 自 動 化 計 算 を user 自 身 が 書 く 必 要 が あ り、 online で AudioParam.setValueAtTime で 動 い た curve を offline で 同 一 出 力 と し て 検 証 で き な い (= B1 acceptance で online と offline を 比 較 す る pipeline が user 側 自 作)。

**判 断 軸**: offline で AudioParam 自 動 化 を 再 現 す る path を 仕 様 上 立 て る 推 奨 = (1) offline config が AudioParam-like な 命 令 列 (= `[{ atSample: 0, value: 1000 }, { atSample: 4800, rampTo: 500, duration: 0.1 }, ...]`) を 受 け る form か、 (2) online で 動 か し た AudioParam の curve を blob で 取 り 出 し て offline に そ の ま ま 渡 す form か、 (3) 「offline で は user pre-compute の Float32Array (長 さ = 全 sample) を 1 本 で 渡 し、 online AudioParam 再 現 は user 責 任」 path を 仕 様 明 言 し て trade-off を 明 文 化。

---

## ship 判 定 リ ス ト の 数 え 上 げ が ratify 文 言 と 揃 っ て い な い

**場 所**: `docs/10-roadmap.md:36-42`、 `docs/decisions-log.md:2586` (= Q62 ratify entry)

**何 が 起 き て い る か**: ship 判 定 リ ス ト が 10-roadmap §1 で 8 項 目 (= A1-A3 / B1-B2 / C1 / D1 / E1 / F1) と し て 列 挙。 一 方 Q62 ratify entry 内 で 「9 項 目 checklist (= A1〜A3 + B1〜B2 + C1 + D1 + E1〜E2 + F1)」 と 明 言、 E1〜E2 と 2 項 目 化 さ れ て い る。 actual roadmap §1 で は E1 単 体 = 数 え 上 げ で 1 項 目 不 在。 E2 が ratify で 何 を 想 定 し て い た か prose 不 在。 F1 自 体 が 「公 開 surface が decisions-log と 整 合」 を 要 求 す る た め、 Q62 と roadmap §1 の zip 違 反 が F1 自 己 違 反 を 構 成 す る self-reference ル ー プ。

**impl AI 影 響**: impl AI が ship 可 否 判 定 を 走 ら せ る 時、 (a) roadmap §1 を 信 用 し て 8 項 目 で 走 ら せ E2 を check し な い、 (b) Q62 を 信 用 し て 9 項 目 で 走 ら せ E2 が 何 か 不 在 で acceptance 不 能、 で 二 way。 「E2 が 何 を 検 証 す る か」 自 体 が 仕 様 hole で あ り、 ship 判 定 pipeline 自 体 が 動 か な い。

**判 断 軸**: Q62 ratify entry に 戻 っ て E2 の 内 容 を 確 定 (= 例 え ば 「runtime invariant 内 部 観 察 path」 等 何 を 想 定 し て い た か decisions-log 起 草 主 旨 を read し て recover) し て 10-roadmap §1 を 9 項 目 化 す る か、 「E2 は ratify wording ミ ス で E1 単 体 が 正」 と decide し て Q62 ratify wording 側 を retract す る か。 同 commit で 数 え 上 げ を 1 か 所 に zip。

---

## browser smoke の pass 条 件 と 入 力 源 が 仕 様 不 在

**場 所**: `docs/10-roadmap.md:32-34`、 `docs/decisions-log.md:2590-2599` (= Q62 D1)

**何 が 起 き て い る か**: ship 判 定 D1 が 「Chromium × Firefox × Safari × {isolated, not isolated} = 6 セ ル で canonical Ex 1〜3 が 起 動 + 出 音」 で declare。 「起 動」 = AudioWorkletNode が construct で き る、 は 1 意。 「出 音」 = 何 を 観 測 す る か (= audio thread が `process` を 1 回 で も 呼 ん だ ら pass か、 AnalyserNode で RMS 0 以 上 な ら pass か、 destination ま で 音 が 出 て い れ ば pass か) が 仕 様 不 在。 さ ら に canonical Ex 1 (stereo gain) は input ナ シ で は silent、 Ex 4 (lookahead limiter) も 同 様 — smoke test 用 の input 源 (= oscillator 1 段 接 続 か、 silent input か、 user provide か) が declare ナ シ。

**impl AI 影 響**: impl AI が (a) 「`process` 1 回 呼 ば れ た ら pass」 で 緩 い 検 証、 (b) RMS > 0 で pass、 (c) 既 知 reference 出 力 と 比 較 (= D1 が B1 と zip)、 で 3 way。 入 力 源 を user に 委 ね る path だ と 6 セ ル × 3 Ex × n agent で test code が 別 物。 D1 acceptance が 別 agent で 別 結 論 で ship 判 定 が drift。

**判 断 軸**: D1 を 「6 セ ル で canonical Ex 1〜3 を render し、 destination まで audio packet が 流 れ た こ と + 出 力 RMS が 0 以 上 で あ る こ と」 で 1 意 化 し、 入 力 源 を 「framework が provide す る silent / オ シ レ ー タ 等 標 準 source」 で 仕 様 化 す る 推 奨。 alternative path (= D1 と B1 を zip し て browser 上 offline reference 比 較) を 採 る な ら 6 セ ル × 3 Ex の reference output を 仕 様 同 梱 し、 D1 を 「B1 を 6 セ ル で 走 ら せ る」 と 1 意 化。

---


---
