# Open questions

unworklet v1.0.0 spec が impl AI agent によって矛盾なく実装されるための残 grill 項目。 ratify されたら `decisions-log.md` に移してこの file から削る。

全 49 entry、 priority 軸 = 「impl AI agent がこの docs だけで手放し実装した時に矛盾 / 揺れが出るか」 重大度。

- **P1 = 16 件**: ship blocker (= wire byte が drift / canonical 自身が build 不能 / 同 source code で別 impl が reproducible でない)
- **P2 = 32 件**: 仕様 invariant + lifecycle (= public surface completeness / mental model / placeholder zip)
- **P3 = 1 件**: prose 揺れ / mechanical sweep (= 親 batch sweep 後 diff review 領域)

---

## P1 — ship blocker 系 (16 件)

### cluster (2) canonical integrity / Q ratify との衝突 (3)

## event<T> payload の `number` field が float 値 を 取 り う る canonical 3 例 と Q46 prose が 真 っ 向 衝 突

**場 所**: `docs/12-canonical-examples.md:411`、 `docs/12-canonical-examples.md:449-451`、 `docs/12-canonical-examples.md:565`、 `docs/12-canonical-examples.md:1038`、 `docs/12-canonical-examples.md:1063`、 `docs/01-dsl.md:511 (= §4.1)`、 `decisions-log.md` (Q46)

**何 が 起 き て い る か**: Q46 で 「worklet 側 emit-shape は `T` の 全 `number` field を `Node<'i32'>` に lift、 全 `boolean` field を `Node<'bool'>` に lift、 typed-array field は §4.3 proxy に lift」 と 厳 密 ratify 済。 一 方 canonical で は (a) Ex 4 L411 `event<{ level: number; channel: 0 | 1 }>` を declare し L449-451 で `level: abs(main.at(0, i))` (= `Node<'f32'>`) を emit、 (b) Ex 5 L565 `event<{ voice: number; pos: number }>` を declare し pos は semantic-ally sample-position の float 値 (実 emit は `// ...` で 省 略)、 (c) Ex 8 L1038 `event<{ note: number; voice: number; velocity: number }>` を declare し L1063 で `velocity: div(f32(velocity), 127)` (= `Node<'f32'>`) を emit。 全 ケ ー ス で 「`number` field に float 値 を 入 れ た い」 意 図 が canonical に 規 範 化 さ れ て いる が、 Q46 ル ー ル で は こ れ ら は 全 部 type error。

**impl AI 影 響**: impl AI agent は (a) Q46 strict で 実 装 し canonical 3 例 を 全 部 build error 化、 (b) emit-shape の `number` 推 論 を `Node<'i32' | 'f32'>` の どち ら か 自 動 選 択 に 拡 張、 (c) event<T> payload type に float marker (= `Float32` 等 別 type) を 別 surface で 追 加、 で path が 3 way 以 上 に 割 れ る。 audio plugin 系 の event は velocity / pos / level / pan / pitch 等 float 自 然 が 多 数 で、 Q46 を strict に 取 る と event<T> surface が 実 用 に な ら な い。

**判 断 軸**: Q46 prose の 「`number` → `Node<'i32'>`」 lift を 「`number` → `Node<'f32'>`」 に 寄 せ 直 す か、 payload type に float / int 別 marker を 入 れ る か、 「emit site で 任 意 の Node<T> を 受 け 入 れ Node の T を そ の ま ま wire type に 反 映」 path に 倒 す か。 後 者 が canonical の 形 (= Ex 4 / Ex 5 / Ex 8 の declare 自 然) と zip し や す く 推 奨 だ が、 ratify 済 Q46 の retract が 必 要 = decisions-log で rejected 案 と し て 残 し て 再 ratify。

---

## SIMD primitive の 一 部 が declare さ れ て い る だ け で canonical で 一 度 も 動 か な い 状 態 で 残 っ て い る

**場 所**: `docs/01-dsl.md:938-944`、 `docs/01-dsl.md:922-925`、 `docs/12-canonical-examples.md:274`、 `docs/12-canonical-examples.md:810`、 `docs/12-canonical-examples.md:313-321`、 `docs/12-canonical-examples.md:863-875`

**何 が 起 き て い る か**: v1.0.0 で expose す る SIMD primitive 一 式 (= `vec4` / `splat` / `addVec` / `subVec` / `mulVec` / `divVec` / `sumLanes` / `vec.lane`) の う ち、 `vec4` / `subVec` / `divVec` / `vec.lane` の 4 個 が canonical Ex 3 / Ex 7 で 一 度 も 呼 ば れ て い な い。 canonical の import 行 も `splat` / `mulVec` / `addVec` / `sumLanes` の 4 個 だ け を 取 り 込 ん で お り、 残 り 4 個 は spec prose で declare さ れ て い る が canonical で 規 範 確 認 が ナ シ。 12 の Coverage table も `vec.lane` を Ex 3 / Ex 7 で exercise 済 み と claim し て い る が、 実 code に 該 当 行 ゼ ロ。

**impl AI 影 響**: impl AI が canonical を 仕 様 の 規 範 確 認 source と し て 読 む と、 (a) `vec4(a, b, c, d)` の construction で lift rule が ど こ ま で 効 く か (= JS literal を 何 個 渡 し て も 通 る か)、 (b) `subVec` / `divVec` を `sumLanes` 等 と 自 然 に 組 み 合 わ せ る 形、 (c) `vec.lane(i)` の `i` が `0 | 1 | 2 | 3` literal-only か 一 般 `Node<'i32'>` か、 (d) `vec.lane` 違 反 時 の error 形 が canonical で 学 べ な い。 結 果 と し て impl AI が 「surface に declare は あ る が canonical で zip ナ シ = ship 範 囲 不 明」 と 判 断 し て deferral 寄 り に 倒 す リ ス ク、 ま た は 自 力 解 釈 で 実 装 を 進 め て 後 で canonical 反 映 時 に drift。 AGENTS.md HARD CONTRACT (= 全 doc 変 更 を canonical で 規 範 確 認) と も 直 接 衝 突。

**判 断 軸**: v1.0.0 surface の SIMD primitive 全 8 個 を canonical で 1 回 ず つ exercise す る 形 に Ex 3 / Ex 7 を 拡 張 す る か、 新 規 SIMD-only canonical を 1 件 立 て て 残 り 4 個 を 集 約 exercise す る か。 「declare だ け で canonical exercise ナ シ」 の v1.0.0 surface を 残 す path は AGENTS.md HARD CONTRACT 違 反 な の で 不 可、 ど ち ら か の zip path を 取 る 必 要 あ り。 同 commit で Coverage table の `vec.lane` 行 を 実 exercise Ex に zip 直 す。

---

---

### cluster (3) wire format byte layout (4)

## event 用 slot と MIDI 用 slot で 「い つ の sample で 発 生 し た か」 を 表 す 数 字 の 位 置 が 別

**場 所**: `docs/02-messaging.md:111-120`、 `docs/11-midi.md:316-327`

**何 が 起 き て い る か**: 02-messaging.md §5.1 は `event<T>` の ringbuffer slot を 「先 頭 4 byte が atSample、 続 い て T fields、 末 尾 に payloadLen / payloadOffset」 と 規 定。 11-midi.md §4.1 の MIDI slot は 「status / data1 / data2 / _pad / atSample (末 尾 4 byte)」 で atSample が 末 尾 配 置。 02 §1 は 「The same ringbuffer machinery serves MIDI」 「underneath it shares the SAB ringbuffer + Atomics protocol described in §4 and §5」 と 明 言 す る が、 slot 内 field 並 び 順 が doc 間 で 別 物。

**impl AI 影 響**: 「shared machinery」 を そ の ま ま 受 け 取 る と impl が (a) MIDI slot に 02 §5.1 形 式 (atSample 先 頭) を 当 て て 11 §4.1 と 矛 盾、 (b) 逆 に MIDI 末 尾 配 置 を `event<T>` 全 般 に 当 て て 02 §5.1 と 矛 盾、 (c) どち ら が 正 本 か 判 ら ず 2 種 serializer を 別 個 emit し て postMessage path と SAB path で wire byte が drift、 の 3 way に 分 か れ る。 「header (= head / tail / overflowCount) は 共 通、 slot 部 分 は variant 別」 が 仕 様 か prose で 明 示 ナ シ。

**判 断 軸**: 「shared = ring buffer header と Atomics protocol だ け、 slot encoding は declaration 種 ご と に 別 layout を OK と す る」 path を 1 か 所 で declare し、 02 §5.1 と 11 §4.1 の atSample 位 置 を そ の ま ま 残 す か、 「slot 内 field 並 び は 全 declaration 種 で 統 一 す る」 path に 倒 し て どち ら か (先 頭 / 末 尾) に 揃 え る か。

---

## variable-length 中 身 の 並 べ 方 が event と MIDI sysex で 別 形 式 な の に 「same transport」 主 張 が 残 る

**場 所**: `docs/02-messaging.md:122-126`、 `docs/11-midi.md:338-349`

**何 が 起 き て い る か**: 02-messaging.md §5.2 は variable-length payload を 「main slot に `payloadLen` + `payloadOffset` を 持 ち、 content buffer は offset で 指 し て 並 ぶ」 形 で 規 定 し、 「This is the same machinery used for MIDI sysex; one transport implementation covers both」 と 明 言。 一 方 11-midi.md §4.3 の sysex content buffer は 「`| length (u32) | data (length bytes) | length (u32) | data (length bytes) | ...`」 と 各 entry が 内 部 で length prefix を 持 ち sequence で 連 続 す る 形、 main slot 側 は 「status = 0xF0 + 3 byte pad + sysexIndex」 (= `payloadLen` 不 在)。

**impl AI 影 響**: impl AI が 「same transport」 を 信 用 し て (a) event<T> の content buffer を 11 §4.3 の length-prefix sequence 形 で 書 く と 02 §5.1 の `payloadLen` (main slot 側 で 長 さ を 持 つ) と 矛 盾、 (b) 逆 に MIDI sysex の content buffer を 02 §5.2 の offset 指 し flat memory 形 で 書 く と 11 §4.3 と 矛 盾。 deserializer の byte offset 計 算 が 直 接 壊 れ、 main 側 / worklet 側 で wire 一 致 し な く な る。

**判 断 軸**: 「main slot で 長 さ を 持 ち、 content buffer は flat memory + offset 指 し 」 (= 02 §5.2 形 式) に 1 本 化 し 11 §4.3 の content buffer 表 を 書 き 直 す path 推 奨。 main slot 側 の `payloadLen` / `sysexIndex` 命 名 ば ら つ き も 同 時 に zip。

---

## sysex の slot 構 造 だ け atSample 不 在 で 「全 handler 引 数 は atSample を 持 つ 」 主 張 と 衝 突

**場 所**: `docs/11-midi.md:316-327`、 `docs/11-midi.md:342-346`、 `docs/11-midi.md:155-167`

**何 が 起 き て い る か**: 11-midi.md §4.1 で MIDI slot を 「`| status (u8) | data1 (u8) | data2 (u8) | _pad (u8) | atSample (u32) |` = 8 bytes」 で uniform に 規 定。 同 §4.3 の sysex variant slot は 「`| status = 0xF0 | _pad | _pad | _pad | sysexIndex (u32) |`」 と 後 半 4 byte が atSample で は な く sysexIndex に 置 換、 atSample field が 完 全 に 消 え る。 一 方 §2.3 prose は 「Every handler argument carries `atSample`」 と sample-accurate dispatch を 強 く 主 張、 sysex inbound handler signature も `({ data, atSample })` 形 を 規 範 化 (= §2.5 L249 / canonical Ex 9)。

**impl AI 影 響**: sysex 経 路 で `atSample` を どこ か ら 取 る か で impl が 分 岐: (a) content buffer 側 に atSample を 入 れ る 拡 張 (= 11 §4.3 の content buffer schema に atSample が 1 行 も 出 て こ ず、 仕 様 か ら 取 れ な い)、 (b) sysex slot サ イ ズ を 12 byte 等 に 拡 張 (= §4.1 の 「8 bytes per slot, slot-indexed pointers」 uniform 性 が 崩 れ る)、 (c) sysex 経 路 で atSample を 0 固 定 / block 開 始 時 刻 で 注 入 (= sample-accurate 主 張 が 崩 れ る)。 wire 上 で atSample を どこ か に 入 れ る path が 仕 様 か ら 一 意 に 決 ま ら な い。

**判 断 軸**: sysex slot に atSample を 持 た せ る (= slot size を sysex variant だ け 拡 張 し uniform 性 と の zip を prose で 明 示) か、 sysex content buffer entry 内 に atSample field を 追 加 す る か、 「sysex は block 開 始 時 注 入 で atSample 不 在 を 許 容」 path に 倒 し て §2.3 の wording を 改 訂 す る か。 sample-accurate 主 張 を 守 る な ら 前 2 path、 §4.1 uniform 性 を 守 る な ら 中 央 path 推 奨。

---

## worklet 側 で 新 規 に 中 身 を 構 築 し て 流 す path が sysex 専 用 で event は declare 不 在

**場 所**: `docs/11-midi.md:100-114`、 `docs/11-midi.md:248-279`、 `docs/01-dsl.md:340-358`、 `docs/01-dsl.md:511-518`

**何 が 起 き て い る か**: 11-midi.md §2.2 の sysex emit (worklet → main) signature が 「`{ type: 'sysex'; data: Buffer<'u8'> | TypedArrayFieldRef<'u8'>; length: Node<'i32'>; atSample: Node<'i32'> }`」 と 「`Buffer<'u8'>` (= worklet 側 で 事 前 確 保 し た 領 域) を 受 け 入 れ る」 専 用 path を 持 つ。 11-midi.md §2.5 は 「sysex 内 容 を 新 規 構 築 す る 経 路 は build-time-fixed `Buffer<'u8'>` の み (= `Uint8Array` literal や `new Uint8Array(...)` 不 可)」 と 明 言。 一 方 一 般 の `event<T>` の emit (= 例 え ば worklet 側 で 計 算 し た spectrum を `event<{ spectrum: Float32Array }>` で 流 す) で `Buffer<'f32'>` を 受 け 入 れ る path は 01-dsl.md §4.3 / 02-messaging.md §1 と も declare ナ シ。 変 数-長 typed-array field は 「typed-array-field proxy で 公 開」 と あ る が、 proxy は **incoming** payload を main → worklet 側 で 読 む 形、 worklet → main で 「新 規 構 築 し た 中 身」 を emit す る path に proxy は 該 当 し な い。

**impl AI 影 響**: worklet が 計 算 結 果 を typed-array field 付 き で main へ emit し た い ケ ー ス (= 例 え ば FFT spectrum、 波 形 解 析 結 果) で impl が (a) MIDI sysex と uniform に `data: Buffer<T> | TypedArrayFieldRef<T>` を 受 け る surface を 追 加 す る、 (b) 「event<T> の emit-side variable-length field は inbound proxy か ら の forward の み 」 と 制 限 し て worklet 側 新 規 構 築 を 不 可 と す る、 で 2 path に 分 か れ る。 後 者 を 採 る と canonical で 「worklet → main の FFT 結 果 emit」 が 書 け な く な る (= 一 般 audio 用 例 の 中 心 機 能 が cover で き な い)。

**判 断 軸**: sysex 専 用 path を 一 般 化 し て event<T> emit 側 で も `Buffer<T>` を 受 け 入 れ る surface (= `{ field: Buffer<T> | TypedArrayFieldRef<T>; length: Node<'i32'> }`) を 立 て る path に 倒 す か、 「worklet 側 で 新 規 typed-array 中 身 を emit す る 経 路 は MIDI sysex 専 用、 event<T> は inbound proxy forward の み」 と 制 限 し て canonical で 同 ケ ー ス を 出 さ な い path か。 前 者 推 奨 (= 一 般 audio 用 例 を cover、 surface も sysex と uniform)。

---

### cluster (4) handler / drain / boundary timing (1)

## render quantum サ イ ズ 不 一 致 時 の 動 作 が silence vs 停 止 vs onError-only で 3 way 不 一 致

**場 所**: `docs/04-worklet-runtime.md:34-42`、 `docs/03-compiler.md:163`、 `docs/00-foundations.md:226`、 `docs/00-foundations.md:238`

**何 が 起 き て い る か**: render quantum size が 128 と 違 う 時 の path が 3 doc で 別 物。 04-worklet-runtime §3 は 「stops processing rather than producing garbled audio or silent output」 (= silence 出 さ ず 停 止)。 00-foundations §5.2 「Runtime guard」 定 義 は 「fallback to silence + a main-side error event」 (= silence 出 し な が ら error event) で、 §5.2 末 尾 で 04 §3 を canonical 例 と し て 参 照。 03-compiler §2.6 は 「`node.onError` event」 surface だ け で audio output 動 作 ナ シ。

**impl AI 影 響**: impl AI が process(...) の return false (= node disconnect) を 採 る か、 silence buffer を 流 し 続 け る か、 onError 発 火 の み で audio 動 作 を 維 持 す る か で 4 path に 分 か れ る。 main 側 で onError handler が 受 け 取 れ る 設 計 か も 同 時 に drift。

**判 断 軸**: 「runtime guard fallback の 具 体 動 作 = (a) silence + onError、 (b) process return false で 停 止、 (c) onError 発 火 後 silence 継 続」 の ど れ を 単 一 path と し て 01 / 03 / 04 / 00-foundations 全 て で 揃 え る か。 仕 様 invariant と し て 1 か 所 で declare し 他 章 は そ こ を 参 照。

---

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

### cluster (8) snapshot / restore lifecycle (2)

## `snapshot()` の 「graph-capture-time error」 が 何 を trigger に 検 出 さ れ る か

**場 所**: `docs/00-foundations.md:212`、 `docs/01-dsl.md:331`、 `docs/01-dsl.md:1055`、 `docs/01-dsl.md:1172`、 `docs/05-client.md:88`、 `docs/05-client.md:112`、 `docs/05-client.md` (§6.1 / §6.5)

**何 が 起 き て い る か**: prose で 「`snapshot()` を 呼 ぶ processor body は 全 slot に `name` 必 須」 と あ る が、 `snapshot()` 自 体 は main thread 側 の `node.snapshot()` で、 worklet 側 declare-time に は 評 価 さ れ な い。 「graph-capture-time error」 の 起 動 trigger が prose で 不 明 確 (= `snapshot: 'persistent'` flag を 持 つ slot が 1 つ で も あ れ ば trigger な の か、 `migrations` 引 数 の 有 無 で trigger な の か、 全 slot に 一 律 強 制 な の か)。 加 え て migrate 実 行 の thread (= main か audio か) が prose 中 で 「construction で catch」 「main で run し て か ら audio に hand off」 「block boundary で audio が apply」 が 並 立 し て お り timing が 1 path に 揃 っ て な い。

**impl AI 影 響**: name 強 制 trigger で impl が (a) 全 slot 一 律、 (b) persistent slot で trigger、 (c) migrations 引 数 で trigger に 分 か れ る。 migrate timing で (a) main で run し て post-migration blob を audio に 渡 す、 (b) audio thread で run (= 仕 様 違 反 リ ス ク)、 (c) hybrid に 分 か れ る。 後 者 は audio thread 例 外 path が 起 動 す る か 否 か に 直 結 す る た め 矛 盾 重 い。

**判 断 軸**: trigger は declaration-side flag (= persistent slot or migrations 引 数) と main-side 振 る 舞 い (= snapshot() 呼 び 出 し) ど ち ら で 起 動 す る か。 migrate の thread は 「main 側 で run し 完 了 後 audio 側 で apply」 path に 一 本 化 す る か。

---

## `snapshot()` 呼 び 出 し 時 の name 必 須 性 が 「全 slot 必 須」 と 「少 な く と も 1 slot 必 須」 で doc 間 で 別 物

**場 所**: `docs/01-dsl.md:331`、 `docs/05-client.md:112`、 `docs/decisions-log.md:282`、 `docs/12-canonical-examples.md:318`、 `docs/12-canonical-examples.md:529`

**何 が 起 き て い る か**: name 必 須 性 ル ー ル が 2 doc で 別 wording。 01-dsl.md §3.1 (L331) は 「`name?` — slot identity. Required when the parent processor calls `snapshot()` (graph-capture-time error otherwise).」 (= 「snapshot 呼 ぶ processor の 各 slot に name 必 須」)。 05-client.md §2.6 (L112) は 「A processor that calls `snapshot()` without any `name`-bearing slot is a graph-capture-time error.」 (= 「全 slot が name ナ シ の 時 だ け error、 1 つ で も name 持 ち が あ れ ば OK」)。 decisions-log Q5-b (L282) は 01-dsl.md 寄 り の wording。 canonical Ex 3 / Ex 5 等 は 全 slot に name を 振 っ て お り 01-dsl.md 寄 り、 し か し §3.1 L318 example `state.f32(0)` (= name ナ シ) も canonical 内 に 出 現 し て お り 「snapshot 持 ち の processor で 1 個 で も `state.f32(0)` を 持 つ と error か 否 か」 が 仕 様 で 取 れ な い。

**impl AI 影 響**: 既 entry 「`snapshot()` の 『graph-capture-time error』 が 何 を trigger に 検 出 さ れ る か」 で trigger 軸 を 立 て て い る が、 こ の entry は 「error trigger が 検 出 さ れ た 後、 reject 対 象 が 全 slot か 1 slot で も name 持 ち が あ れ ば OK か」 と い う 別 軸。 (a) strict path で 全 slot 必 須 = `state.f32(0)` を 含 む processor で `node.snapshot()` 呼 ぶ と error、 (b) lenient path で 1 slot 必 須 = `state.f32(0)` 含 ん で も `state.i32(0, { name: 'x' })` が 1 つ あ れ ば 通 過、 で WASM build pass/fail が 揺 れ、 同 じ source code で 別 impl が reproducible で な い。

**判 断 軸**: 01-dsl.md §3.1 / decisions-log Q5-b の strict (= 全 slot 必 須) path 採 用 で 05-client.md §2.6 prose を rewrite す る か、 05-client.md lenient (= 1 slot で OK) path 採 用 で 01-dsl.md §3.1 / Q5-b を rewrite す る か。 strict path 採 用 な ら restore 側 で 「name 不 在 slot は そ も そ も blob に 載 ら ず restore も で き ず」 と 自 然 に zip = 推 奨。 既 entry の trigger 軸 と 同 commit で decide す る path。

---

### cluster (9) main 側 / offline / acceptance (4)

## node に error が 来 た 時 に 受 け 取 る 値 の 形 が 全 spec で 書 か れ て い な い

**場 所**: `docs/05-client.md:54`、 `docs/08-deployment.md:39`、 `docs/04-worklet-runtime.md:101-102`、 `docs/12-canonical-examples.md:122`、 `docs/12-canonical-examples.md:260`

**何 が 起 き て い る か**: 公 開 surface `.onError(handler)` で handler に 渡 る 値 の 型 が prose / 型 declaration の どこ に も 書 か れ て い な い。 canonical で は `node.onError((err) => console.error(...))` の 形 で `err` を 受 け る だ け で 中 身 を 触 ら ず、 型 を 確 認 で き る 例 が ナ シ。 「event code」 と い う 概 念 は 「`sab-unavailable`」 を 1 か 所 で 例 示 し て い る が (= 08 §2)、 (a) 全 event code 一 覧 (= worklet trap / queue overflow / sab-unavailable / block-length-mismatch 等) が ど の doc に も 無 い、 (b) handler に 渡 る 値 は `Error` 系 か `{ code, message }` 系 か discriminated union か 不 明、 (c) 同 surface が 「queue overflow event」 を push 通 知 す る 一 方 で 別 surface (= `.diagnostics.overflowCount()`) で pull 観 測 も 提 供 さ れ て お り、 ど ち ら が 一 次 channel か prose で declare ナ シ。

**impl AI 影 響**: impl AI が `(err: ???) => void` の `???` を 決 め ら れ ず、 (a) `Error` で 緩 く、 (b) `{ code: string; message: string }` 形、 (c) `{ code: 'wasm-trap' } | { code: 'sab-unavailable' } | ...` の discriminated union、 (d) event code 列 挙 を 自 力 で 補 完、 で 4 way 以 上 に 分 か れ る。 consumer 側 で `err.code === 'sab-unavailable'` 等 の switch 分 岐 を 書 け る か / 書 け な い か が impl ご と に 別。 さ ら に queue overflow を push で 受 け る か pull で 取 り に 行 く か で diagnostics surface 全 体 の 設 計 が 変 わ る。

**判 断 軸**: handler 引 数 型 を discriminated union (= `{ code: 'wasm-trap' } | { code: 'sab-unavailable' } | { code: 'queue-overflow', source: string, dropped: number } | { code: 'block-length-mismatch' } | ...) で 明 文 化 し、 event code 全 列 挙 を 1 か 所 (= 05-client §2 か foundations §5) で declare す る path 推 奨。 queue overflow を push (= onError) で 集 約 通 知 し 詳 細 counter は pull (= diagnostics) で 取 る 二 段 構 え を prose で 明 文 化 する か、 push / pull の どち ら か 1 path に 倒 す か decide。

---

## pure-JS と WASM の bit-exact 約 束 で 例 外 と な る 演 算 一 覧 が 仕 様 不 在

**場 所**: `docs/06-testing.md:31-33`、 `docs/13-offline-render.md:51-52`、 `docs/10-roadmap.md:23-24`、 `docs/03-compiler.md:196-198`

**何 が 起 き て い る か**: 「documented FP differences」 / 「documented FP tolerance bands」 と い う 表 現 が 4 doc に 同 居 す る が、 「ど の 演 算 で / ど の 程 度 の 差 が 許 容 さ れ る か」 を 列 挙 し た prose が 1 か 所 も な い。 さ ら に doc 間 で 規 定 が 揺 れ る: 06 §3 「pure-JS は bit-exact、 WASM 側 だ け tolerance あ り」 (= 非 対 称)、 10 §1 B2 「pure-JS と WASM が 同 入 力 で 同 出 力、 documented FP diff 除 外」 (= 両 方 bit-exact + 例 外)、 13 §3 「Optional: WASM backend, cross-validated against the pure-JS interpreter for bit-identity (modulo documented FP differences)」 = 10 寄 り。 Q17 ratify で 「polynomial approximation の 最 大 誤 差 約 1e-4」 は math intrinsics 全 体 の 仕 様 値 だ が、 「pure-JS と WASM が 同 polynomial を 使 え ば bit-exact、 別 libm を 使 え ば 差 が 出 る」 axis を 1 意 化 し て い な い。

**impl AI 影 響**: impl AI が (a) 「pure-JS が `Math.sin` 等 native libm、 WASM が polynomial = sin/cos/exp/log 等 が 全 て tolerance 対 象」、 (b) 「pure-JS も WASM も 同 polynomial 実 装 = 全 演 算 bit-exact」、 (c) 「WASM 側 が libm import で pure-JS と 一 致」、 で 3 way 以 上 に 分 か れ、 acceptance B2 検 証 で 「ど の 演 算 を tolerance 対 象 と し て 除 外 す る か」 が 別 agent で 別 物 = pass/fail 判 定 自 体 が 別 結 論。 canonical Ex 2 (sin/cos/exp 多 用) で の bit-exact 達 成 可 否 が 1 意 で な い。

**判 断 軸**: 「pure-JS と WASM で 同 一 polynomial approximation を 共 通 実 装 と し て emit、 全 演 算 が bit-exact、 documented FP diff は 「存 在 し な い」」 path で 仕 様 を 閉 じ る 推 奨 (= Q17 と 直 接 zip、 acceptance B2 の 「除 外 列 挙」 自 体 が 不 要)。 alternative path (= 演 算 ご と に tolerance 仕 様 値) を 採 る な ら 演 算 単 位 + tolerance 値 の 表 を 1 か 所 で declare 必 須。

---

## P2 — 仕様 invariant + lifecycle (32 件)

## `forSample.byN` を function + property hybrid で expose す る か

**場 所**: `docs/01-dsl.md:1287-1294`

**何 が 起 き て い る か**: signature が `forSample(callback): void` を free function で declare し、 同 時 に `forSample.byN(stride, callback): void` を property と し て declare し て いる (= callable function に property が ぶ ら 下 が る hybrid)。 canonical で `forSample.byN(4, ...)` を 直 接 invoke す る 形 だ が、 こ の hybrid 形 を export す る か `forSample` と `forSampleByN` を 別 named export に 分 け る か prose で 確 定 し て な い。

**impl AI 影 響**: impl AI は (a) hybrid 形 で 1 つ の named export に 統 合、 (b) `forSample` と `forSampleByN` を 別 named export に 分 け、 (c) `forSample` を namespace object に 変 え る、 の 3 path で 判 断 が 割 れ、 canonical の 書 き 方 (`forSample.byN(...)`) が 動 く か が 実 装 ご と に 変 わ る。

**判 断 軸**: canonical の 形 を そ の ま ま 通 す と (a)、 ど ち ら か を 単 純 化 す る と (b)。 命 名 自 体 で は な く 「callable に property を 生 や す 形 を 使 う か」 が invariant。

---

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

## canonical の declared-but-unused slot を 仕 様 で reject す る か

**場 所**: `docs/12-canonical-examples.md:520`、 `docs/12-canonical-examples.md:565`、 `docs/12-canonical-examples.md:677`

**何 が 起 き て い る か**: canonical Ex 5 で `playbackPos = param({...})` と `grainSpawned = event<...>(...)` を declare し て いる が、 worklet body 内 で `playbackPos.at(...)` / `grainSpawned.emitIf(...)` の 呼 び 出 し が 1 件 も な い。 main 側 で は `node.events.grainSpawned.on(...)` で subscribe し て いる。 「declared だ が body で 1 度 も emit/use し な い」 surface を graph-capture-time error / warning / silent OK の ど れ で 扱 う か prose で declare ナ シ。 canonical が 規 範 と し て 「reject さ れ な い こ と」 を 示 し て いる の か prose で 不 明。

**impl AI 影 響**: impl AI は (a) dead declaration を graph-capture-time error で reject、 (b) warning 出 す が build 通 す、 (c) silent OK、 で 判 断 が 割 れ、 canonical 自 体 が build 通 ら な い 実 装 が 出 る possibility。

**判 断 軸**: dead declaration を silent OK と し て canonical を 規 範 化 す る か、 reject path に 倒 し て canonical 修 正 す る か。 canonical が 「declare だ け で 後 か ら 配 線 す る」 pattern を 想 定 す る な ら silent OK 推 奨。

---

## handler context か ら subgraph method 呼 ぶ 時 の boundary が 明 示 ナ シ

**場 所**: `docs/01-dsl.md:582`、 `docs/01-dsl.md:839`、 `docs/01-dsl.md:1221`

**何 が 起 き て い る か**: §5.2 は subgraph method の 呼 び 出 し context を 「parent の forSample / per-block top」 2 ケ ー ス し か 言 及 せ ず、 §5.6.4 は 「handler 含 む 全 expression context か ら 呼 び 可」 と declare。 §9.1 は 「subgraph method が 内 部 で forSample を 開 く 形」 を declare す る が、 method が handler context か ら 呼 ば れ た 場 合 「内 部 forSample が handler context 内 で 動 く の か、 handler drain 後 の per-block context で 動 く の か」 prose 明 示 ナ シ。 Q56 で handler body の expression scope を forSample と 一 致 さ せ た が、 「handler 内 で 新 規 forSample を 開 け る か」 は 未 確 定。

**impl AI 影 響**: handler 内 で subgraph method 呼 び 出 し → method 内 で forSample を 開 く path で、 「handler 内 forSample 全 体 が block 開 始 時 に inline で 1 回 動 く 形」 と 「forSample が 独 立 の per-sample loop と し て drain 後 に 動 く 形」 で WASM emission が 別 物 に な る。

**判 断 軸**: handler 内 で forSample を 開 く こ と を (a) 禁 止、 (b) handler context 内 で inline 1 回 実 行 (= sample loop に な ら な い)、 (c) drain 後 の per-block context で 別 sample loop と し て 動 か す、 の ど れ に 倒 す か。 method 経 由 で 呼 ば れ る 場 合 も 同 path で 統 一。

---

## param marshalling 仕 様 (length 1 / 128 / 0) が doc 間 で 散 在 し て boundary closed で な い

**場 所**: `docs/04-worklet-runtime.md:21`、 `docs/08-deployment.md:2`、 `docs/03-compiler.md:3`

**何 が 起 き て い る か**: 04 §2 placeholder は 「Marshal parameter arrays (length 1 / 128 / 0 — see Q18)」 と 1 行 で 投 げ、 length 0 case の default 適 用 boundary (= per-block top で declared default で fill か、 per-sample loop 内 で fill か、 broadcast か copy か) を declare せ ず。 08 §2 A3 は normalization の 「user 側 view (= user は `param.at(i)` / `param.at(0)` だ け 触 る)」 を 規 定 す る が WASM emit 側 の boundary 動 作 は declare ナ シ。 03 §3 も placeholder の ま ま 「static analysis」 が closed で な い。

**impl AI 影 響**: length 0 の 場 合 declared default を per-block top で 1 度 fill す る か per-sample で fill す る か で WASM emission が 別 物 に な る。 a-rate param の per-block top 呼 び (= 既 entry 「a-rate param を per-block top で `param.at(0)` 経 由 で 取 る pattern の canonical 確 認 不 在」 と zip) の 振 る 舞 い と も 直 接 影 響 し 合 う。

**判 断 軸**: marshalling 仕 様 を 04 §2 か 03 §3 の ど ち ら か 1 か 所 に 集 約 し、 length 1 (broadcast) / length 128 (full a-rate) / length 0 (default fill) の 3 case 全 て で 「ど の boundary で 何 を normalize す る か」 を 明 文 化 す る path 推 奨。

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

## framework が user 値 を 暗 黙 で 変 え る path の 完 全 列 挙 が 仕 様 surface に 不 在

**場 所**: `docs/00-foundations.md:208`、 `docs/00-foundations.md:117`、 `docs/04-worklet-runtime.md:67-78`、 `docs/01-dsl.md:545`

**何 が 起 き て い る か**: 04-worklet-runtime §6 で 「state.f32 / state.f64 の `.store(v)` で `1e-30` 以 下 を 0 に flush す る auto-rewrite」 を 明 言 し て いる が、 「framework が 暗 黙 で 値 を 変 え る path は subnormal flush が 唯 一」 と 全 doc で 保 証 す る prose は ナ シ。 別 path と し て 01-dsl §4.3 末 尾 で 「out-of-range `.at(idx)` reads は graph capture で `select`-based carrier-clamp で wrap」 と あ り、 こ れ も 「user が 渡 し た idx と 違 う 値 を 実 質 返 す」 = 意 味 を 変 え る auto-rewrite。 さ ら に param clamp (= `min/max` 範 囲 で 実 行 時 値 を clamp す る か declaration default で 終 わ る か) も 仕 様 内 で 明 確 declare ナ シ。

**impl AI 影 響**: impl AI が 「framework auto-rewrite の 完 全 列 挙」 を 仕 様 か ら 抽 出 し て user 向 け doc / DevTools surface に 列 挙 す る 時、 subnormal flush と carrier-clamp の 2 個 だ け か、 param clamp も か、 他 に も あ る か が 仕 様 か ら 取 れ ず。 「declarative」 原 則 (= user の 書 い た 構 造 が そ の ま ま WASM に な る) と 衝 突 す る auto-rewrite が どこ で 何 個 あ る か を impl AI が 1 箇 所 で 把 握 で き ず、 user mental model の 整 合 性 が 取 れ な い。

**判 断 軸**: foundations §5 か 別 章 で 「framework が user 値 を 暗 黙 に 変 え る path の 完 全 列 挙 表」 を 1 か 所 で 集 約 declare す る path 推 奨。 列 挙 範 囲 は 「subnormal flush / carrier-clamp / param clamp / SIMD vec 化 で の round mode 変 化 等」 全 部 zip。 こ の 表 が 「declarative 原 則 の 例 外 リ ス ト」 と し て invariant 化。

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

## profile 指 定 で snapshot し た blob を 別 profile の processor に restore し た 時 の `missing` 計 算 ル ー ル が 仕 様 で 不 定

**場 所**: `docs/05-client.md:64`、 `docs/05-client.md:78-83`、 `docs/05-client.md:101`、 `docs/01-dsl.md` §8.2

**何 が 起 き て い る か**: `node.snapshot({ profile: 'preset' })` で profile-restricted blob を 出 し、 別 declaration (= profile=`'session'` 専 用 slot を 持 つ processor) に restore す る path で、 `RestoreResult.missing` を 「現 schema の 全 slot」 で 計 算 す る か 「blob の profile-restricted slot 集 合」 で 計 算 す る か が 仕 様 prose に declare ナ シ。 `InspectionResult.profile: string | null` field (= 05-client.md L101) は blob に profile を 載 せ る path を 示 唆 す る が、 restore 時 に framework が そ の profile を どう 使 う か は declare 不 在。

**impl AI 影 響**: framework 実 装 で profile 付 き blob を restore す る path で、 (a) 現 schema 全 slot を base に missing を 計 算 (= profile-restricted blob だ と session-only slot が 全 部 missing と し て 出 る)、 (b) blob の profile-restricted 集 合 だ け で 計 算 (= session-only slot は そ も そ も 「探 さ な か っ た」 扱 い で missing に 出 さ ず)、 (c) blob profile と target processor profile を 比 較 し て 整 合 し な い 場 合 reject、 で 3 way 以 上 に 分 か れ る。 consumer 側 「preset partially loaded」 UI が impl ご と に 別 物。

**判 断 軸**: `missing` の base set を 「blob の profile-restricted slot 集 合」 (= 「preset blob は preset slot だ け に 触 れ る、 session-only slot は 影 響 範 囲 外」) に 倒 す path 推 奨 (= consumer mental model 「preset を 読 み 込 む と preset 部 分 だ け 動 く」 と zip)。 別 軸 で 「profile 不 一 致 reject path」 を 立 て る か は 別 entry で decide。

---

## `MigrationHelpers` の profile-scoped 系 helper と `oldProfileName` metadata の semantics が prose で declare 不 在

**場 所**: `docs/01-dsl.md:1138`、 `docs/01-dsl.md:1146`、 `docs/01-dsl.md:1149-1150`、 `docs/12-canonical-examples.md:898-919`、 `docs/05-client.md:101`

**何 が 起 き て い る か**: `MigrationHelpers` 型 で `parseSlotInProfile` / `writeSlotInProfile` (= profile-scoped 系) が listed さ れ、 「Profile-scoped read/write (used when migrating across profile renames)」 と 1 行 comment だ け 付 与。 同 metadata の `oldProfileName: string | null` も declare の み で semantics prose ナ シ。 canonical Ex 7 の migration entry は profile-scoped variant を 一 切 使 用 し て お ら ず、 仕 様 prose と canonical exercise が zip し て い な い (= AGENTS.md HARD CONTRACT 「canonical-examples で 仕 様 を 1 意 に exercise」 違 反)。 profile-scoped variant の `profile: string` 引 数 が old blob 内 の 別 profile を 指 す か target schema の profile 名 を 指 す か も 仕 様 か ら 取 れ ず、 `oldProfileName` が `snapshot({ profile })` で 出 し た blob だ け に 載 る か / `snapshot()` (no arg) で も 載 る か も declare ナ シ。

**impl AI 影 響**: impl AI が `MigrationHelpers` を 実 装 す る 時、 (a) `parseSlotInProfile(blob, name, type, profile)` で 旧 blob 内 の 別 profile を free 読 み 可 (= 全 profile slot を walk す る blob 形 式 要 求)、 (b) 旧 blob の `oldProfileName` 専 用 で 引 数 profile が それ と 一 致 し な い と undefined、 (c) 旧 blob は 「1 個 の profile snapshot」 で profile 引 数 は target 側 の profile 名 を 指 す、 で 3 解 釈。 writeSlotInProfile も 同 様 に target profile の 取 り 扱 い が dangling。 blob header の profile metadata 形 (= 1 個 か union か 全 profile か) も 仕 様 で 取 れ ず、 wire 上 の byte layout も drift。

**判 断 軸**: profile-scoped variant の 「source 側 profile 引 数 = 旧 blob 内 の どの profile を 読 む か」 / 「target 側 profile 引 数 = output blob の どの profile に 書 く か」 を prose で 明 文 化 し、 blob header に 載 る profile metadata の 形 (= `snapshot()` no-arg 時 は `null`、 `snapshot({ profile: 'preset' })` 時 は `'preset'` の 単 一 文 字 列、 全 profile snapshot path は v1.0.0 で 不 在) を declare。 canonical Ex 7 か 新 規 example で profile-rename migration を 1 例 exercise し て 仕 様 を 1 意 化 推 奨。

---

## `buffer.<T>` の `publish` option が 全 element type で 受 け 入 れ ら れ る か prose で 規 範 ナ シ

**場 所**: `docs/01-dsl.md:347-379`、 `docs/02-messaging.md:140-146`、 `docs/12-canonical-examples.md` (Ex 5 / Ex 8 で `buffer.f32` publish の み)

**何 が 起 き て い る か**: 01-dsl §3.2 で `buffer.f32 / buffer.f64 / buffer.i32 / buffer.i64 / buffer.bool / buffer.u8` の 6 factory variant を 列 挙 し、 共 通 で `publish?` option を 受 け 入 れ る 形 で signature declare。 一 方 02-messaging §5.4 L140 は 「Scalar `state.<type>` publish accepts only `state.f32` / `state.i32` / `state.bool` (Q42)」 と state publish の T 制 限 を 明 文 化 (= f64 / i64 / bool 以 外 reject) し て い る が、 buffer publish の T 制 限 は 1 行 も declare せ ず。 02 §5.4 L146 「buffer region は memory.copy で byte-wise、 torn read 起 こ る」 prose は buffer publish 一 般 を 想 定 す る が、 `buffer.f64` / `buffer.i64` / `buffer.u8` も 全 部 publish 通 す か / 一 部 reject か が 取 れ な い。 canonical で は `buffer.f32` publish の み 規 範 化 (= Ex 5 / Ex 8) で、 他 type の publish 規 範 確 認 が ナ シ。

**impl AI 影 響**: impl AI が `buffer.u8({ size, publish: { rateFps: 30 } })` (= sysex buffer や bytes view) を 通 す か reject す る か で 公 開 surface が drift。 (a) state publish 制 限 と zip し て `buffer.<T>` も `T ∈ {f32, i32, bool}` 限 定 で reject、 (b) 全 element type で publish 通 す (= torn-read OK の 設 計)、 (c) f32 だ け 通 し て 他 reject、 で 3 way に 分 か れ る。 main 側 subscriber 型 (= `Float32Array` か `Uint8Array` か `Int32Array` か) も declaration kind ご と に zip し な い と TS surface が 別 物。

**判 断 軸**: `buffer.<T>` publish の T 制 限 を 1 か 所 (= 02-messaging §5.4 末 尾) で 列 挙 declare し、 (a) state publish と 揃 え る か (= `buffer.<T>` も `T ∈ {f32, i32, bool, u8}` 等) / (b) 全 T 通 し て 「torn-read OK」 を invariant と し て 明 文 化 す る か decide。 main 側 subscriber 型 を declaration kind ご と に narrow す る path も 同 commit で 整 理。

---

## SIMD comprehensive surface の v1.x.0 rollout order を 規 定 す る Q-entry が 不 在

**場 所**: `docs/01-dsl.md:991`、 `docs/decisions-log.md:160` (Q3-b 内 prose)

**何 が 起 き て い る か**: 2 か 所 で 「SIMD comprehensive surface (f64x2 / i32x4 / mask vectors / shuffle / gather / scatter 等) の v1.x.0 rollout order は Q14 で 解 決」 と 引 用 し て い る が、 Q14 = Q62 で resolved 内 容 は 「v1.0.0 acceptance criteria (9 項 目 ship checklist)」 で あ り SIMD rollout order に 関 す る 規 定 ナ シ。 (= math intrinsics 引 用 部 分 [03-compiler L180] は Q14 → Q17 修 正 済 み で 別 entry で close。)

**impl AI 影 響**: impl AI が 引 用 ど お り Q14 entry を 引 き に 行 く と 内 容 不 一 致 で 戻 っ て き て し ま い、 SIMD rollout order の 規 定 自 体 が ど の Q-entry に も 存 在 し な い 事 実 に 気 づ か ず、 v1.x.0 で の SIMD 拡 張 path を 適 当 な 順 序 で 進 め て し ま う possibility。

**判 断 軸**: SIMD rollout order の 規 定 が Q-entry 不 在 な ら 別 Q を 立 て て decide す る か、 prose で 「rollout order は v1.x.0 で 別 途 ratify」 と 明 文 化 し て dangling ref を 解 消 す る path 推 奨。

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

## offline で 取 り 出 す event 列 の 形 が main 側 subscribe 引 数 と 揃 っ て い な い

**場 所**: `docs/13-offline-render.md:34,38`、 `docs/05-client.md:25-32`、 `docs/11-midi.md:13-17`、 `decisions-log.md` Q46

**何 が 起 き て い る か**: offline render の 戻 り 値 に 並 ぶ event 配 列 と、 入 力 と し て 注 入 す る event 配 列 が、 同 一 形 `{ name, payload, atSample }` で 書 か れ て い る。 一 方 (a) main 側 で event を 購 読 す る surface は handler 引 数 が 「直 接 payload」 で `name` field を 持 た な い (= 購 読 者 は 名 前 を 既 に 知 っ て い る)、 (b) MIDI は main 側 で discriminated union (= `{ type: 'noteOn', ... }`) で 受 け る (= field 名 が `name` で は な く `type`、 階 層 も 違 う)。 offline 戻 り 値 だ け 3 surface が 統 一 さ れ な い 別 形。

**impl AI 影 響**: impl AI が offline 用 に `{ name, payload, atSample }` wrap 形 を 採 用 す る と、 test helper で 「online subscriber 経 由 で 集 め た event 列」 と 「offline 戻 り 値 の event 列」 を 同 一 matcher で 比 較 で き ず、 acceptance B1 (= online で 観 測 し た 動 作 を offline で 再 現) を 書 く 時 に user が 形 変 換 を 自 力 で 書 く 状 態。 さ ら に MIDI を offline で 観 測 す る 場 合、 main 側 `{ type: 'noteOn', ... }` 形 と offline `{ name: 'noteIn', payload: { type: 'noteOn', ... } }` (= 多 階 層) の どち ら が canonical か decode path が 別 れ る。

**判 断 軸**: offline 戻 り 値 の event 列 形 を main 側 観 測 surface と 1 対 1 mirror で 揃 え る path 推 奨 (= 各 declaration 種 ご と に 「online subscribe で 渡 さ れ る 値 + atSample + declaration 名」 を そ の ま ま 並 べ る form)。 注 入 形 と 戻 り 値 形 を 別 物 と し て declare し て も 良 い が、 1 か 所 で 「online と 同 一 観 測 形」 を invariant 化。

---

## offline で 渡 す 自 動 化 用 配 列 の 長 さ が online の 自 動 化 surface と 直 結 し な い

**場 所**: `docs/13-offline-render.md:32`、 `docs/05-client.md:42-43` (= `.params.<name>: AudioParam`)、 `decisions-log.md` Q18 (= per-block param 配 列 長 1/128/0)

**何 が 起 き て い る か**: offline で param 値 を 注 入 す る 形 が `params: { cutoff: [1000, 1000, /* per-sample or per-block */] }` 配 列 形 で 書 か れ、 prose 注 釈 が 「per-sample (= 128 値) or per-block (= 1 値)」 を 示 唆。 一 方 online surface は `node.params.<name>: AudioParam` で `setValueAtTime` / `linearRampToValueAtTime` / `exponentialRampToValueAtTime` / 別 AudioNode の connect (= LFO modulation) 全 部 受 け る。 offline で online と 同 等 の 自 動 化 を 再 現 す る path が 規 定 さ れ て い な い。 配 列 長 が k-rate=1 / a-rate=128 / no-automation=0 の 3 値 union な の か、 render 全 体 sample 数 (= `duration × sampleRate`) の curve を pre-compute し て 渡 す 形 な の か、 1 意 に 読 め な い。

**impl AI 影 響**: impl AI が (a) 3 値 union の per-block 配 列 を block ご と に 注 入 す る form、 (b) render 全 体 curve を 1 本 の Float32Array で 渡 す form、 で 二 way。 後 者 を 採 用 す る と offline 側 で 自 動 化 計 算 を user 自 身 が 書 く 必 要 が あ り、 online で AudioParam.setValueAtTime で 動 い た curve を offline で 同 一 出 力 と し て 検 証 で き な い (= B1 acceptance で online と offline を 比 較 す る pipeline が user 側 自 作)。

**判 断 軸**: offline で AudioParam 自 動 化 を 再 現 す る path を 仕 様 上 立 て る 推 奨 = (1) offline config が AudioParam-like な 命 令 列 (= `[{ atSample: 0, value: 1000 }, { atSample: 4800, rampTo: 500, duration: 0.1 }, ...]`) を 受 け る form か、 (2) online で 動 か し た AudioParam の curve を blob で 取 り 出 し て offline に そ の ま ま 渡 す form か、 (3) 「offline で は user pre-compute の Float32Array (長 さ = 全 sample) を 1 本 で 渡 し、 online AudioParam 再 現 は user 責 任」 path を 仕 様 明 言 し て trade-off を 明 文 化。

---

## offline で 主 側 → worklet 側 message が 1 batch か block ご と か で 振 る 舞 い が 揺 れ る

**場 所**: `docs/13-offline-render.md:33`、 `docs/02-messaging.md:1-30` (= Q38-a render quantum 開 始 時 drain)、 `docs/12-canonical-examples.md` (Ex 5 / Ex 6 / Ex 7 で `node.messages.<name>(payload)` を 動 的 に 送 信)

**何 が 起 き て い る か**: offline config の `messages: [...]` 配 列 が atSample 不 在 で 書 か れ、 prose 注 釈 が 「delivered before render」 と 単 純。 online 側 で は Q38-a で 「各 render quantum 開 始 時 に handler が drain」 が ratify 済 (= main 側 send 直 後 で は な く 次 quantum で 受 信)。 offline で の 配 達 形 が (a) render 開 始 前 に 全 message を 1 batch で drain、 (b) block 0 の 開 始 時 に drain、 (c) 各 message に atSample / block 指 定 を 受 け 取 れ る surface 追 加、 で 3 way。 動 的 upload (= canonical Ex 5 / Ex 6 / Ex 7 の sample / pattern / IR 注 入) を 「render の どこ で 入 る か」 1 意 に 読 め な い。

**impl AI 影 響**: impl AI が (a) を 採 用 す る と Ex 5 で 「render 開 始 時 に sample upload 済 = 全 block で grain spawn 可」 と な る が、 online 動 作 (= upload 前 は silent、 upload 後 か ら 鳴 る) を 再 現 で き な い (= B1 acceptance で online と offline で 別 出 力)。 (b) は 同 様 (block 0 開 始 時 drain = upload 即 反 映)。 (c) を 自 力 拡 張 す る path は 仕 様 surface 増 加 で 別 agent と drift。 sample-accurate 動 的 upload を 再 現 す る path が 仕 様 不 在。

**判 断 軸**: offline message inject 形 を 「`{ atQuantum: number, payload: T }` (= block 番 号 で 配 達 タ イ ミ ン グ 指 定)」 拡 張 で 1 意 化 す る 推 奨 (= online quantum 単 位 drain と 直 接 zip)。 「block 0 開 始 時 drain 固 定」 path を 採 る な ら 動 的 upload 系 Ex の B1 acceptance を 「全 message を pre-drain し た 状 態 で の 出 力」 に 限 定 す る 注 釈 を 同 commit で 明 文 化。

---

## offline render の 長 さ が 1 block 単 位 で 割 り 切 れ な い 時 の 振 る 舞 い 規 定 不 在

**場 所**: `docs/13-offline-render.md:30`、 `docs/decisions-log.md` Q18 (= render quantum 128 fully baked)

**何 が 起 き て い る か**: offline config の `duration` が 秒 単 位 で 受 け る 形 で declare、 prose 例 は `duration: 1.0`。 worklet runtime は 1 block = 128 sample 固 定 で baked (Q18) で、 `outputs[0][0].length !== 128` で error。 offline 側 で `duration × sampleRate` が 128 で 割 り 切 れ な い ケ ー ス の 振 る 舞 い が 仕 様 不 在: (a) `duration` を 切 り 上 げ て 128 倍 数 化 + 余 剰 を silence pad、 (b) 末 尾 partial block を 「128 sample 走 ら せ て 後 半 を truncate」、 (c) 128 倍 数 で な い `duration` を graph-capture-time error、 で 3 way。 入 力 配 列 長 (= `inputs: { main: pcm }` の `pcm.length`) が `duration × sampleRate` 同 値 か `ceil(... / 128) × 128` か も 同 軸 で 不 明。

**impl AI 影 響**: impl AI が (a) を 採 用 す る と reference output の sample 数 が `ceil(... / 128) × 128`、 (b) を 採 用 す る と `floor(duration × sampleRate)`、 (c) を 採 用 す る と `duration` 制 約 が user 側 に 露 出 = 3 path で B1 acceptance 検 証 の sample 数 が drift。 別 agent 間 で reference output の length が 一 致 せ ず、 bit-exact 比 較 自 体 が 不 能。

**判 断 軸**: 「`duration × sampleRate` を 128 倍 数 に 切 り 上 げ + 余 剰 silence pad + 入 力 も 同 様 に pad 受 容」 path 推 奨 (= user 側 制 約 ゼ ロ、 reference output 長 が 一 意 確 定)。 alternative path (= error / truncate) を 採 る な ら 同 commit で `duration` 制 約 + 入 力 配 列 長 制 約 を prose 明 文 化。

---

## offline で WASM backend を 選 ぶ 形 と cross-validation を 走 ら せ る path が 仕 様 不 在

**場 所**: `docs/13-offline-render.md:51-52`、 `docs/06-testing.md:31-33`、 `docs/10-roadmap.md:23-24`

**何 が 起 き て い る か**: 「Backend selection: opt-in flag on `renderOffline` config; default is pure-JS for the test/CI case」 と 13 で 述 べ ら れ る が、 13 の `renderOffline` config 例 (= `sampleRate` / `duration` / `inputs` / `params` / `messages` / `events` 等) に backend 選 択 用 の field が 存 在 し な い。 opt-in flag の 具 体 key 名 (= `backend: 'wasm'` か `useWasm: true` か `crossValidate: true` か) が 仕 様 不 在。 さ ら に 06 で 期 待 さ れ る cross-validation (= pure-JS と WASM を 同 時 走 行 し て diff 計 算) が `renderOffline` で 1 度 で 走 る path か、 2 回 呼 び で user が 自 力 diff 計 算 す る path か、 matcher 内 部 で auto 化 す る path か、 規 定 ナ シ。

**impl AI 影 響**: impl AI が (a) `renderOffline({ backend: 'wasm' })` で 1 backend ず つ 走 行 し user が 自 力 diff、 (b) `renderOffline({ crossValidate: true })` で 両 backend を 1 呼 び で 走 ら せ diff を 戻 り 値 に 載 せ る、 (c) matcher 側 (= `expectBitExactAcrossBackends(processor, config)`) で 2 回 走 行 を 内 包、 で 3 way。 acceptance B2 (= 両 backend bit-exact) の test を 書 く form が 別 agent で 別 物。

**判 断 軸**: `renderOffline` config に `backend: 'js' | 'wasm'` field を 立 て て 1 回 1 backend と し、 cross-validation 用 matcher を `@unworklet/test` 側 に 別 出 し (= `expectBitExactAcrossBackends(processor, config, { tolerance })`) で 1 path 化 推 奨。 alternative (= 1 呼 び で 両 backend) は config と 戻 り 値 形 が 二 重 化 し て 複 雑、 v1.0.0 で は 単 純 path 推 奨。

---

## ship 判 定 リ ス ト の 数 え 上 げ が ratify 文 言 と 揃 っ て い な い

**場 所**: `docs/10-roadmap.md:36-42`、 `docs/decisions-log.md:2586` (= Q62 ratify entry)

**何 が 起 き て い る か**: ship 判 定 リ ス ト が 10-roadmap §1 で 8 項 目 (= A1-A3 / B1-B2 / C1 / D1 / E1 / F1) と し て 列 挙。 一 方 Q62 ratify entry 内 で 「9 項 目 checklist (= A1〜A3 + B1〜B2 + C1 + D1 + E1〜E2 + F1)」 と 明 言、 E1〜E2 と 2 項 目 化 さ れ て い る。 actual roadmap §1 で は E1 単 体 = 数 え 上 げ で 1 項 目 不 在。 E2 が ratify で 何 を 想 定 し て い た か prose 不 在。 F1 自 体 が 「公 開 surface が decisions-log と 整 合」 を 要 求 す る た め、 Q62 と roadmap §1 の zip 違 反 が F1 自 己 違 反 を 構 成 す る self-reference ル ー プ。

**impl AI 影 響**: impl AI が ship 可 否 判 定 を 走 ら せ る 時、 (a) roadmap §1 を 信 用 し て 8 項 目 で 走 ら せ E2 を check し な い、 (b) Q62 を 信 用 し て 9 項 目 で 走 ら せ E2 が 何 か 不 在 で acceptance 不 能、 で 二 way。 「E2 が 何 を 検 証 す る か」 自 体 が 仕 様 hole で あ り、 ship 判 定 pipeline 自 体 が 動 か な い。

**判 断 軸**: Q62 ratify entry に 戻 っ て E2 の 内 容 を 確 定 (= 例 え ば 「runtime invariant 内 部 観 察 path」 等 何 を 想 定 し て い た か decisions-log 起 草 主 旨 を read し て recover) し て 10-roadmap §1 を 9 項 目 化 す る か、 「E2 は ratify wording ミ ス で E1 単 体 が 正」 と decide し て Q62 ratify wording 側 を retract す る か。 同 commit で 数 え 上 げ を 1 か 所 に zip。

---

## test matcher の 状 態 比 較 が permanent 領 域 限 定 で 一 時 領 域 の bug を 見 逃 す

**場 所**: `docs/06-testing.md:15-27`、 `docs/13-offline-render.md:35-39`、 `decisions-log.md` Q5 (= snapshot blob は profile 依 存 / persistent slot 限 定)

**何 が 起 き て い る か**: 06 §2 で `expectStateMatches(result, expectedSnapshot)` matcher が listed さ れ、 prose で 「Compares end-of-render snapshot blob (Q5 format)」。 13 §2 で `result.state` を 「Uint8Array snapshot blob (Q5 format)」 と 規 定。 Q5 ratify で snapshot blob は profile 依 存 で、 transient slot (= `persistent: false` 明 示 / 一 時 領 域) は 含 ま な い。 つ ま り `expectStateMatches` で transient slot (= 例 え ば 内 部 filter coefficient / phase accumulator 等 audio 計 算 内 部 状 態) を 検 証 で き ず、 「DSP 計 算 が 1 行 間 違 っ て い て も persistent slot だ け 一 致 す れ ば test pass」 と い う 抜 け 道 が 仕 様 上 存 在。

**impl AI 影 響**: impl AI が `expectStateMatches` を (a) persistent slot 限 定 比 較 (= Q5 snapshot format 通 り) で 実 装 し て transient bug を 見 逃 す path、 (b) 全 slot (= transient 含 む) を 比 較 す る 拡 張 surface を offline 専 用 に 追 加 し て Q5 format と zip し な い path、 で 二 way。 後 者 は offline 専 用 path で 仕 様 surface 増 加。 acceptance B1 (= canonical を offline で 再 現) を 「audio 出 力 と state の 両 軸 で 検 証」 す る path が 仕 様 hole。

**判 断 軸**: 「test matcher の 状 態 比 較 は audio 出 力 (= `expectAudioMatches`) で DSP 計 算 を 担 保 + persistent slot (= `expectStateMatches`) で migration 経 路 を 担 保 と 役 割 分 担」 path 推 奨 (= transient slot は audio 出 力 経 由 で 観 測)。 alternative path (= offline 専 用 で 全 slot 露 出) を 採 る な ら surface 形 + Q5 format と の zip 説 明 を 同 commit で 明 文 化。

---

## browser smoke の pass 条 件 と 入 力 源 が 仕 様 不 在

**場 所**: `docs/10-roadmap.md:32-34`、 `docs/decisions-log.md:2590-2599` (= Q62 D1)

**何 が 起 き て い る か**: ship 判 定 D1 が 「Chromium × Firefox × Safari × {isolated, not isolated} = 6 セ ル で canonical Ex 1〜3 が 起 動 + 出 音」 で declare。 「起 動」 = AudioWorkletNode が construct で き る、 は 1 意。 「出 音」 = 何 を 観 測 す る か (= audio thread が `process` を 1 回 で も 呼 ん だ ら pass か、 AnalyserNode で RMS 0 以 上 な ら pass か、 destination ま で 音 が 出 て い れ ば pass か) が 仕 様 不 在。 さ ら に canonical Ex 1 (stereo gain) は input ナ シ で は silent、 Ex 4 (lookahead limiter) も 同 様 — smoke test 用 の input 源 (= oscillator 1 段 接 続 か、 silent input か、 user provide か) が declare ナ シ。

**impl AI 影 響**: impl AI が (a) 「`process` 1 回 呼 ば れ た ら pass」 で 緩 い 検 証、 (b) RMS > 0 で pass、 (c) 既 知 reference 出 力 と 比 較 (= D1 が B1 と zip)、 で 3 way。 入 力 源 を user に 委 ね る path だ と 6 セ ル × 3 Ex × n agent で test code が 別 物。 D1 acceptance が 別 agent で 別 結 論 で ship 判 定 が drift。

**判 断 軸**: D1 を 「6 セ ル で canonical Ex 1〜3 を render し、 destination まで audio packet が 流 れ た こ と + 出 力 RMS が 0 以 上 で あ る こ と」 で 1 意 化 し、 入 力 源 を 「framework が provide す る silent / オ シ レ ー タ 等 標 準 source」 で 仕 様 化 す る 推 奨。 alternative path (= D1 と B1 を zip し て browser 上 offline reference 比 較) を 採 る な ら 6 セ ル × 3 Ex の reference output を 仕 様 同 梱 し、 D1 を 「B1 を 6 セ ル で 走 ら せ る」 と 1 意 化。

---

## offline と online で 同 processor の build artifact 同 一 性 を 担 保 す る path 不 在

**場 所**: `docs/13-offline-render.md:54-58`、 `docs/07-vite-plugin.md:100-130` (= §6.3 artifact set)、 `decisions-log.md` Q5-e (= schema-hash 経 由 担 保)、 `decisions-log.md` Q57 (= offline blob を online で restore す る path 明 言)

**何 が 起 き て い る か**: 13 §4 で 「offline で 走 ら せ た 結 果 の `state` blob を `node.restore(state)` で online 継 続 で き る」 と declare。 schema hash 一 致 が 担 保 さ れ な い と blob は restore 拒 否 さ れ る (Q5-e)。 「offline で 走 ら せ た processor」 と 「online で `createNode` す る processor」 が 同 source か ら 同 schema hash で emit さ れ る path が 仕 様 不 在: (a) `@unworklet/vite-plugin` で 1 度 build し た artifact (= `.graph.json` / `.memory.json` / `.schema-hash.json`) を offline / online 両 方 が 同 一 ファイル set と し て 共 有、 (b) offline 用 / online 用 で 別 build pipeline を 走 ら せ 都 度 schema hash 計 算 一 致 を 信 頼、 (c) vite-plugin の `?worklet` import が offline runner で も 同 一 artifact を load す る path を 仕 様 明 言、 で architecture が dangling。

**impl AI 影 響**: impl AI が (a) を 採 用 し て offline / online で artifact set を 共 通 source と し て 参 照 す る path を 立 て な い と、 canonical Ex 7 (= migration chain で offline で 旧 processor を 走 ら せ snapshot → online で 新 processor に restore + replaceProcessor で 入 れ 替 え) の cross-runtime test が 動 か な い。 (b) 採 用 で schema hash 計 算 が pipeline 違 い で drift し て restore が 常 に reject さ れ る path も 成 立。 acceptance B1 (= offline で canonical を 再 現) と Q57 (= offline と online で 同 blob path) の zip が 仕 様 不 在。

**判 断 軸**: 「`@unworklet/vite-plugin` で 1 度 emit し た artifact set を offline runner が internal API 経 由 で 直 接 load し、 online と 同 一 schema hash を 共 有 す る」 path を 仕 様 明 文 化 推 奨。 13 §4 prose と 07 §6.3 artifact 表 を zip し て 「offline / online 両 経 路 が 同 一 artifact set を 参 照」 を declare、 同 commit で `@unworklet/offline` package の input 形 (= `import processor from './gain?worklet'`) と offline runner の 内 部 artifact resolve path を 明 文 化。

---

## test matcher の 比 較 単 位 と 既 定 が 仕 様 不 在 で audio 比 較 が 別 agent で 結 論 別

**場 所**: `docs/06-testing.md:13-27`、 `docs/10-roadmap.md:22-24` (= B1 bit-exact + documented FP diff 除 外)

**何 が 起 き て い る か**: 06 §2 placeholder で `expectAudioMatches(actual, expected, { tolerance })` を 例 示、 prose 「Bit-identical or within-tolerance comparison of Float32Array channels」。 `tolerance` の 単 位 (= sample 単 位 abs diff threshold か、 RMS dB 差 か、 NaN 受 容 path か) が 仕 様 不 在。 default 値 (= `tolerance` 省 略 時) が bit-exact (= `0`) か polynomial 近 似 誤 差 約 1e-4 か も 不 在。 さ ら に 多 channel 比 較 形 (= `Float32Array[]` を channel ご と に 比 較 か flat ま と め て 比 較 か) も 仕 様 不 在 で、 offline 戻 り 値 形 entry と zip し な い と 別 agent で 別 物。

**impl AI 影 響**: impl AI が (a) `tolerance` 省 略 = bit-exact、 sample abs diff、 channel ご と 比 較 form、 (b) `tolerance` 省 略 = 1e-4 程 度、 RMS 差 form、 (c) hybrid form、 で 3 way 以 上。 acceptance B1 で 各 canonical Ex の 適 切 tolerance 値 を どう 決 め る か も 仕 様 不 在 で 別 agent で 「同 一 reference に 対 し て pass / fail」 別 結 論。

**判 断 軸**: `expectAudioMatches` の `tolerance` 単 位 を 「sample abs diff (= abs(actual[i] - expected[i]) <= tolerance を 全 sample で 満 た す)」 で 1 意 化 + default = `0` (= bit-exact、 documented FP diff 除 外 は 別 entry で 一 意 化) + 多 channel は `Float32Array[]` を channel ご と に 同 一 tolerance で 比 較 path 推 奨。 alternative path (= RMS / dB) を 採 る な ら 単 位 + default を 仕 様 明 文 化 必 須。

---

## v1.0.0 公 開 package 間 の 依 存 関 係 が 仕 様 不 在 で 公 開 surface 完 全 性 検 証 不 能

**場 所**: `docs/06-testing.md:9-11` (= `@unworklet/test` が `@unworklet/offline` に depend)、 `docs/13-offline-render.md:9-20` (= 4 package の 役 割 分 担)、 `docs/09-repo-structure.md` (= Q60 ratify で pnpm workspace 設 定 batch)、 `decisions-log.md` Q23

**何 が 起 き て い る か**: 公 開 4 package (= `@unworklet/core` / `@unworklet/vite-plugin` / `@unworklet/offline` / `@unworklet/test`) は 09 / Q23 で 公 開 surface と し て ratify 済 だ が、 package 間 dependency graph (= 何 が 何 を `dependencies` / `peerDependencies` / `devDependencies` で 受 け る か) が 仕 様 不 在。 06 §1 で 「`@unworklet/test` does not re-implement rendering. It depends on `@unworklet/offline`」 と 言 明 が あ る も の の、 (a) `@unworklet/test` の `package.json` で `@unworklet/offline` を `dependencies` (= auto-resolve)、 (b) `peerDependencies` (= user 別 install 必 須)、 で 公 開 surface が drift。 同 様 に `@unworklet/vite-plugin` と `@unworklet/core` の 関 係、 `@unworklet/offline` と `@unworklet/core` の 関 係 も 仕 様 不 在。

**impl AI 影 響**: impl AI が package.json を 起 こ す 時、 (a) 全 部 `dependencies` で auto-resolve 路 線 = user は `@unworklet/test` 1 個 install で 動 く、 (b) `peerDependencies` で 明 示 install 路 線 = user が 4 package 全 部 install、 で UX が 別 物。 acceptance F1 (= 公 開 surface 完 全 性 検 証) で 「v1.0.0 で 公 開 さ れ た package.json の dependencies field set」 を check す る path が 別 agent で 別 結 論 で ship 判 定 が drift。

**判 断 軸**: 4 package 間 dep graph を 1 か 所 で declare 推 奨 = (1) `@unworklet/core` は dependency 0 (= web platform 純 粋)、 (2) `@unworklet/vite-plugin` は `@unworklet/core` を peer (= user が 必 ず install 済)、 (3) `@unworklet/offline` は `@unworklet/core` を peer + 自 身 で interpreter ship、 (4) `@unworklet/test` は `@unworklet/offline` を dependency (= user install 数 削 減 + 同 一 major version 自 動 一 致) path で 1 意 化、 acceptance F1 に dep graph check を 追 加。

---

## P3 — prose 揺れ / mechanical sweep (1 件)

## SAB mode の event drain mechanism が doc ご と に 抽 象 level mismatch

**場 所**: `docs/05-client.md:129`、 `docs/02-messaging.md:65`

**何 が 起 き て い る か**: 02-messaging.md table は `event<T>` の 観 測 path を 「continuously by main thread reader」 と 抽 象 declare。 05-client.md §5.1 は 「default: per-MessageChannel ping in SAB mode, per-postMessage arrival in fallback mode」 と 具 体 mechanism を 1 行 だ け 書 く。 MessageChannel ping (= postMessage 系 API で SAB の Atomics 通 知 と は 別 mechanism) を SAB mode で 採 用 す る 必 然 性 が prose で 説 明 さ れ ず、 Atomics.notify ベ ー ス wakeup や rAF loop 等 別 path と の 選 択 軸 が 不 明。

**impl AI 影 響**: SAB mode で の main 側 event drain mechanism の 選 択 が impl ご と に drift。 MessageChannel / Atomics.notify / rAF / setTimeout の ど れ で も 仕 様 prose を 満 た せ て し ま う。

**判 断 軸**: mechanism を spec level (= SAB mode = Atomics 経 由 wakeup、 fallback = postMessage 順 次) で 1 doc に 集 約 declare す る か、 「mechanism は impl の 自 由 度、 観 測 ル ー ル だ け 規 定」 path に 倒 す か。 後 者 な ら 05 §5.1 の 具 体 mechanism 記 述 を 削 除 / 例 示 と し て marker す る 必 要 あ り。

---
