# 06 — Testing (`@unworklet/test`)

Vitest matchers + audio test utility for unworklet processors。 `@unworklet/offline` (= `13-offline-render.md`) を ラ ッ プ し、 audio-domain assertion + 入 力 信 号 構 築 + MIDI event 構 築 + sample/time 変 換 を 提 供。 全 て deterministic + browser 不 要 で 走 行 (= host JS WebAssembly runtime path、 `13-offline-render.md` §3)。

## Status

fill 済 み 42 件 (= matcher 19 / signal 7 / MIDI 10 / sample-time 6) + chain form 全 19 件 + TS-only chain typing guard (= `WhenResult<T, M>` / `WhenAudioActual<T, M>`)。 `expectStateValue` (= snapshot blob slot 値 assert) は 上 流 `inspect` (= `05-client.md` §2.6) fill 待 ち で Phase 11 に plain + chain 同 ship 予 定 = 当 phase の export surface か ら は 除 外 (= 常 に throw す る public API を ship し な い 行 動 規 律、 v1.0.0 surface は 動 く matcher だ け 並 べ る)。

### Upstream 依 存 状 況 (= Phase 4 vs 後 続 phase)

matcher 自 体 は 全 件 fill 済 み で `RenderOfflineResult` を 与 え れ ば 正 し く 動 く が、 `renderOffline` 側 が `events` / `state` を 実 際 に capture す る 経 路 は 後 続 phase で 立 ち 上 が る (= `10-roadmap.md` §Phase 7 / Phase 9 / Phase 11)。 当 phase で の 影 響:

- **`expectEventsEqual` / `expectEventCount` / `expectEventsContaining`** は `renderOffline.events` を 直 接 比 較。 Phase 7 (= messaging) で renderer の event 捕 捉 が fill さ れ る ま で `events` は 常 に `[]` (= 空 配 列 stub)、 「empty 期 待 = empty 実 測」 で 偽 pass。 非 empty 期 待 で は loud fail。 当 phase で は hand-built `RenderOfflineResult` (= test fixture) に 対 し て 使 う か、 audio path (= `expectAudioMatches` 等) で 同 等 検 証 を 補 完 し、 end-to-end event assertion は Phase 7 fill 後 に zip。
- **`expectMidiOut` / `expectMidiBalance`** も 同 様 に Phase 9 (= MIDI) で renderer fill さ れ る ま で 上 と 同 じ 偽 pass 経 路 を 持 つ。 hand-built fixture path で の 使 用 は 安 全、 real renderOffline 出 力 と の end-to-end zip は Phase 9 待 ち。
- **`expectStateMatches`** は Phase 11 (= snapshot/restore) で renderer の `state` capture が fill さ れ る ま で `state` は 常 に `new Uint8Array(0)` (= 空 blob stub)、 「empty blob 期 待」 で 偽 pass。 非 empty 期 待 で は length mismatch で loud fail。
- **`RenderOfflineResult.sampleRate`** field は `config.sampleRate` を そ の ま ま carry し て metadata と し て 信 頼 で き る (= `expectAudioMatches` / `expectAudioMatchesGolden` の sampleRate 比 較 で 使 う)。 一 方 で processor の `ctx.sampleRate` は Phase 3 placeholder = `0` で、 DSP 内 で `ctx.sampleRate` を 直 接 読 む code path は real rate が flow し て こ な い (= core 側 で の plumbing 完 了 = 後 続 phase)。 当 phase で sampleRate 比 較 が catch す る の は metadata mismatch (= 同 PCM / 異 rate label)、 「processor が ctx.sampleRate を 読 ん で 計 算 し た 結 果 が real rate に zip し て い な い」 path は core 側 fix 待 ち = matcher 側 の 振 る 舞 い と は 独 立。

要 約: matcher は 入 力 contract (= `RenderOfflineResult`) に 対 し て 正 し く 動 く こ と が 担 保 さ れ て お り、 上 流 renderer が real data を 出 し 始 め る ご と に end-to-end usage path が 自 然 に 開 く。 当 phase で end-to-end 検 証 が 通 る の は 「audio 出 力 path」 だ け (= Phase 4 完 了 条 件 = `10-roadmap.md` §Phase 4 「Ex 1 (= meter な し) の audio output が tolerance=0 で reference と 一 致」)、 event / MIDI / state path は 後 続 phase で 順 次 zip。

## 1. Relationship to `@unworklet/offline`

`@unworklet/test` does **not** re-implement rendering。 `@unworklet/offline` の `renderOffline` を 内 部 呼 び 出 し、 戻 り 値 `RenderOfflineResult` (= `{ outputs, events, state }`) に audio-domain assertion を 重 ね る。 こ の split で offline rendering は server-side / batch / preview UI で 単 独 利 用 可 (= `13-offline-render.md` §1)、 test-specific 関 心 (= matcher / golden file / signal utility 等) は こ ち ら に 集 約。

Standard MIDI File loader (= `loadSmf` / `parseSmf`) は v1.0.0 ship 範 囲 外 = `10-roadmap.md` §3.2 additive で 追 加 想 定 (= 既 知 MIDI song を 入 力 と し て synth / arp 出 力 を 検 証 す る ユ ー ス)。

## 2. Matchers (= 19 件 + `expectStateValue` Phase 11)

全 matcher は **plain function form** で declare、 失 敗 時 = `Error` を throw、 vitest が catch し て test fail と し て 表 示。 chain form (= `expect.extend(...)`) は §6 で 別 declare、 plain と 並 立。

result 型 = `RenderOfflineResult` = `{ outputs: Record<string, Float32Array[]>, events: OfflineEmittedEvent[], state: Uint8Array }` (`13-offline-render.md` §2)。

全 numerical matcher (= audio compare / golden / snapshot / peak / rms / silence / peak-at / gain-at-freq / latency / DC offset) は 冒 頭 で `expectNoNaN` 相 当 の guard を 走 ら せ、 NaN / ±Infinity 入 力 を 必 ず fail に 落 と す。 理 由 = `Math.abs(NaN) > x = false` / `NaN >= x = false` の 特 性 で 数 値 比 較 系 matcher が NaN を 暗 黙 に 通 し て catastrophic DSP failure を 偽 pass さ せ る経 路 を 機 械 的 に 塞 ぐ た め (= sanity check と し て `expectStable` を 別 途 呼 ば な く て も matcher 自 体 が 自 衛)。 `expectAudioMatches` / `expectAudioMatchesGolden` は actual / expected 双 方 (= reference 側 も = corrupted golden や NaN fixture を freeze さ せ な い)。

### 2.1 Audio matchers

- **`expectAudioMatches(actual, expected, opts?)`** — sample 単 位 比 較。 `expected` 型 = `RenderOfflineResult | Float32Array[]` (= 全 result 形 / 単 一 port 形)。 `opts.tolerance` default `0` = bit-exact (= `renderOffline` deterministic 保 証 で 自 然 成 立)。 多 port + Float32Array[] form は 単 一 port 推 論 不 能 で throw、 consumer は full result form に 寄 せ る。 `RenderOfflineResult` 形 で 渡 し た 時 は `actual.sampleRate` と `expected.sampleRate` 一 致 を 必 須 check (= 同 PCM / 異 rate = pitch / timing bug を 偽 pass さ せ な い)、 `Float32Array[]` 形 は raw buffer = rate metadata 不 在 = 比 較 無 し (= consumer が rate sensitive な ら full result form で 渡 す)。
- **`expectAudioMatchesGolden(actual, wavPath, opts?)`** — wav file (= 明 示 fixture) を decode し て bit-exact 比 較。 `opts.tolerance` default `0`。 単 一 port 専 用 = 多 port は throw。 業 界 standard reference file 等 を 外 部 か ら 持 ち 込 む 場 面 用。 wav header の `sampleRate` と `actual.sampleRate` も 必 須 check (= 異 rate で 同 PCM な ら pitch / timing が ズ レ る た め)。
- **`expectAudioMatchesSnapshot(actual, opts?): Promise<void>`** — vitest `toMatchSnapshot` 同 形 path。 `actual` は 3 shape = `RenderOfflineResult` (= `result.sampleRate` 経 由) / `Float32Array` (= mono 1 ch 直 接、 `opts.sampleRate` default `48000`) / `Float32Array[]` (= multi-ch 直 接、 同 上) = signal generator 出 力 等 を wrap な し で 渡 す path。 path 解 決 優 先 順 = (1) `opts.snapshotPath` 明 示 = full path 上 書 き、 (2) `opts.snapshotName` 明 示 = `<test-file-dir>/__snapshots__/<safe(snapshotName)>.wav` (= test-file-base prefix も counter も ナ シ、 consumer が unique 命 名 責 任 で test 名 と 独 立 に 短 い 識 別 子 を carry)、 (3) 両 省 略 = auto-infer = `<test-file-dir>/__snapshots__/<test-file-base>__<safe(test-name)>_<hash8>__<counter>.wav` (= 8 桁 FNV-1a hash を test 名 か ら 派 生 し て 付 与 = sanitize 後 同 一 slug に な る 異 な る test 名 (= "foo bar" と "foo!bar" 等) が 別 path に 解 決)。 sanitize は Unicode 保 持 + filesystem-unsafe (`/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`) + whitespace + 制 御 文 字 だ け `_` に collapse、 `snapshotName` で sanitize 結 果 が 空 な ら throw (= hidden `.wav` を 作 ら な い)。 初 回 = snapshot 不 在 → wav 自 動 書 き 出 し + test pass (= 耳 確 認 path、 dev 中 心)、 2 回 目 以 降 = bit-exact 比 較、 `vitest -u` で 強 制 上 書 き、 CI mode = snapshot 不 在 で fail。 **Concurrent test 注 意**: plain function 形 は `expect.getState()` global 経 由 で testPath / currentTestName / snapshot mode を 取 得 = `test.concurrent` 配 下 で 別 test の state を 読 む race 可 能 性 = sequential test 用 path。 concurrent 配 下 で auto-infer / `snapshotName` path を 使 う 時 は chain form (= `expect(actual).toMatchAudioSnapshot(opts?)` = `@unworklet/test/extend` 経 由) を 使 う = `expect.extend` の per-test bound `MatcherState` (= `this.testPath` / `this.currentTestName` / `this.snapshotState`) で race 回 避。 `opts.snapshotPath` を 明 示 す れ ば state 読 み ゼ ロ で concurrent でも 安 全。 **Retry / watch 注 意**: auto-infer counter は test boundary heuristic (= 直 前 と test key が 違 え ば reset) で sequential rerun は handle す る が、 同 一 process で 同 一 test が 連 続 invoke さ れ る (= vitest retry) 経 路 で は counter drift し て 新 規 file (= `_2.wav` / `_3.wav`) が 増 え る 可 能 性 = retry を 使 う test で は 明 示 `snapshotName` か `snapshotPath` を 推 奨。

### 2.2 Sample-level matchers

- **`expectNoNaN(result)`** — `result.outputs` 全 channel 走 査、 NaN / ±Infinity 検 出 で throw。
- **`expectPeakUnder(result, dbfs)`** — peak abs を 20·log10 で dBFS 換 算、 threshold 以 上 で throw。
- **`expectRmsUnder(result, dbfs)`** — 全 channel 平 方 和 平 均 平 方 根 を dBFS 換 算、 threshold 以 上 で throw。
- **`expectStable(result)`** — NaN ナ シ + 全 sample finite (= 発 散 ナ シ) を 1 行 で wrap。 IIR feedback / 長 時 間 render の 安 定 性 sanity check。 audio level は 問 わ ず (= clip し て て も pass)。
- **`expectMaster(result, opts?: { peakDbfs?, rmsDbfs? })`** — master bus デフ ォ check = NaN ナ シ + peak < `opts.peakDbfs` (default `-0.1`) + RMS < `opts.rmsDbfs` (default `-14`) を 1 行 wrap。 `expectStable` ⊂ `expectMaster` 関 係 = master は stable 含 む + clip / 過 大 loudness も 検 出。 NaN check は always on (= 全 numerical matcher で uniform = escape hatch ナ シ)。
- **`expectSilence(result, opts?: { tolerance? })`** — 全 sample が tolerance 内 で 0 (= default `0` = bit-exact silence)。 pure MIDI processor / mute / 起 動 直 後 等。
- **`expectPeakAtSample(result, expectedAtSample, opts?: { tolerance?, port? })`** — time domain = 最 大 abs index が `expectedAtSample` ± `opts.tolerance` (= sample 単 位)。 envelope attack peak 位 置 / impulse response peak 位 置 等。 全 0 buffer (= silent / mute / processor 無 反 応) は 「no detectable response」 で 必 ず throw (= 偽 sample 0 を peak と し て 通 さ な い、 mute regression を 拾 う)。
- **`expectGainAtFreq(result, freqHz, expectedDb, tolerance, opts?: { channel? })`** — freq domain = 内 部 FFT 経 由 で `freqHz` 周 辺 の dB ゲ イ ン が `expectedDb` ± `tolerance`。 EQ test の core。 単 一 ch port = ch 0 自 動、 多 ch port = `opts.channel` 必 須 (= 未 指 定 で throw、 silent blind spot 防 止)。
- **`expectLatency(result, expectedSamples, opts?: { tolerance?, channel? })`** — 入 力 impulse → 出 力 max abs index の delay sample 数 計 測 + assert。 lookahead processor の 設 計 latency 担 保。 channel 推 論 は `expectGainAtFreq` と 同 形 (= 単 一 自 動 / 多 ch 必 須)。 全 0 buffer (= 処 理 失 敗 / impulse 入 力 が 通 過 し な か っ た 状 態) は `expectPeakAtSample` と 同 様 「no detectable response」 で 必 ず throw。
- **`expectDcOffsetUnder(result, threshold)`** — 全 sample 平 均 値 (= DC bias) 絶 対 値 が threshold 未 満。 filter / EQ の DC 振 る 舞 い 確 認。

### 2.3 Event matchers

- **`expectEventsEqual(result, expectedEvents)`** — `result.events` (= `{ name, payload, atSample }[]`) と 順 序 + 全 件 + payload 完 全 一 致 比 較。
- **`expectEventCount(result, name, expectedCount)`** — 特 定 name の event 件 数 一 致 (= 順 序 / payload は 問 わ ず)。
- **`expectEventsContaining(result, partial)`** — 部 分 一 致 (= `partial[i]` が `result.events` の ど こ か に exists)。 順 不 同 + 余 計 な event 許 容。

### 2.4 MIDI matchers

- **`expectMidiOut(result, portName, expectedMidiEvents, opts?)`** — 特 定 `midiOutput({ name })` port 経 由 emit さ れ た MIDI event 列 を `MidiEvent` 形 (= `11-midi.md` §2.2) で 一 致 比 較。 `result.events[i].payload` は `13-offline-render.md` §2 contract で online handler に 渡 さ れ る 値 と 同 形 = `MidiEvent` 構 造 を そ の ま ま 担 う (= wire byte は `11-midi.md` §4 で 述 べ た 通 り compiler 内 部 = author / 消 費 者 surface で は ナ シ)、 matcher は 構 造 化 payload を 直 接 比 較。
- **`expectMidiBalance(result, portName, opts?: { hangingNotes? })`** — noteOn / noteOff pair が balance、 hanging note (= noteOn 後 noteOff な し) が `opts.hangingNotes` (default `0`) 件 ま で 許 容。 stray noteOff (= 出 現 時 点 で 対 応 (channel, note) の noteOn 在 庫 が ゼ ロ の noteOff = lifecycle 逆 転 / noteOn 1 に 対 し て noteOff 2 以 上) は always fail (= MIDI lifecycle で stray は 常 に bug = tolerance opt ナ シ)。 events を 時 系 列 走 査 す る running counter path で 「noteOff → noteOn (= 最 終 net 0)」 も 検 出。

### 2.5 State matchers

- **`expectStateMatches(result, expectedSnapshot)`** — `result.state` (= snapshot blob、 `'persistent'` slot 限 定) と byte-exact 比 較。
- **`expectStateValue(result, slotName, expectedValue)`** — _Phase 11 同 ship 予 定 = 当 phase の export ナ シ_。 snapshot blob を 内 部 で `inspect` (= `05-client.md` §2.6) し て 1 slot 値 取 得 + assert す る 設 計、 上 流 `inspect` fill 後 plain + chain 同 時 に export 復 活。

### 2.6 役 割 分 担: audio 出 力 / event / state snapshot

`expectAudioMatches` 系 (= DSP 計 算 path 全 体 を sample 単 位 で 担 保)、 `expectEventsEqual` 系 (= sample-accurate emit 検 証)、 `expectStateMatches` 系 (= migration / restore round-trip 経 路 担 保) は **役 割 直 交**。 transient slot (= filter coefficient、 phase accumulator 等) の bug は audio output に 現 れ る = `expectAudioMatches` で 検 出、 `'persistent'` slot は blob round-trip 経 路 で = `expectStateMatches` で 検 出。 三 軸 構 成 で 全 bug を cover。

## 3. Signal construction utility (= 7 件)

入 力 信 号 を `new Float32Array(N)` で 自 力 構 築 す る boilerplate を 削 減。 全 て deterministic = test 再 現 性 を 保 つ。

- **`sine(opts: { freqHz, durationSamples, sampleRate, amplitude?, phase? }): Float32Array`** — 純 音 (= `amplitude` default `1`、 `phase` default `0` rad)。
- **`silence(durationSamples): Float32Array`** — 全 0。
- **`impulse(durationSamples, opts?: { atSample? }): Float32Array`** — 単 一 sample 1.0、 残 り 0 (= impulse response 入 力)。 `atSample` default `0`。
- **`sineSweep(opts: { startHz, endHz, durationSamples, sampleRate, type?: 'lin' | 'log', amplitude? }): Float32Array`** — 周 波 数 sweep (= EQ test 入 力)。 `type` default `'log'`。
- **`whiteNoise(opts: { durationSamples, amplitude?, seed? }): Float32Array`** — 決 定 的 seed で xorshift 等 = test 再 現 性 担 保。
- **`dc(durationSamples, value?): Float32Array`** — 定 数 信 号 (= DC gain test 等)。 `value` default `1`。
- **`ramp(opts: { durationSamples, from, to }): Float32Array`** — 線 形 ramp (= gain ramp / param automation 模 倣)。

## 4. MIDI utility (= 10 件)

### 4.1 MIDI event 構 築 (= namespace `midi`、 9 variants + sequence)

`renderOffline` の `events` 配 列 に 渡 す main-side `MidiEvent` (= `11-midi.md` §2.2) を 構 築 す る namespace。 9 variants 全 て を 1 namespace に 集 約 し て top-level pollution を 回 避。

```ts
const midi: {
  noteOn(opts: { note: number; velocity: number; channel?: number }): MidiEvent;
  noteOff(opts: { note: number; velocity?: number; channel?: number }): MidiEvent;
  cc(opts: { controller: number; value: number; channel?: number }): MidiEvent;
  pitchBend(opts: { value: number; channel?: number }): MidiEvent;
  programChange(opts: { program: number; channel?: number }): MidiEvent;
  channelPressure(opts: { pressure: number; channel?: number }): MidiEvent;
  aftertouch(opts: { note: number; pressure: number; channel?: number }): MidiEvent;
  systemRealtime(status: number): MidiEvent;
  sysex(bytes: Uint8Array): MidiEvent;
  sequence(portName: string, events: Array<{ at: number; event: MidiEvent }>): OfflineEvent[];
};
```

`midi.sequence(portName, events)` は 配 列 一 括 構 築 で `OfflineEvent[]` (= `13-offline-render.md` §2) を 返 し、 `renderOffline({ events })` に そ の ま ま 渡 せ る path。 `channel` default `0`、 `noteOff` の `velocity` default `0`。

## 5. Sample / time conversion utility (= 6 件)

DSP test で sample / ms / sec / BPM の 行 き 来 を 1 行 で。

- **`samplesToMs(samples: number, sampleRate: number): number`**
- **`msToSamples(ms: number, sampleRate: number): number`**
- **`samplesToSec(samples: number, sampleRate: number): number`**
- **`secToSamples(sec: number, sampleRate: number): number`**
- **`bpmToSamples(opts: { bpm: number; division: Division; sampleRate: number }): number`** — 拍 → sample。
- **`bpmToMs(opts: { bpm: number; division: Division }): number`** — 拍 → ms。

`Division` literal union (= v1.0.0 core 6 件):

```ts
type Division = "1/1" | "1/2" | "1/4" | "1/8" | "1/16" | "1/32";
```

三 連 (= `'1/8t'` / `'1/16t'`) / dotted (= `'1/4d'` / `'1/8d'`) は v1.0.0 ship 範 囲 外 = `10-roadmap.md` §3.2 additive で 追 加 検 討。

## 6. Matcher chain form (= `expect.extend`)

vitest `expect.extend(...)` 登 録 経 由 で chain form (= `expect(result).toMatchAudio(...)`) も 並 立 で 提 供。 plain function form (= §2) と co-exist (= 同 test 内 で 両 形 混 在 OK)。 別 subpath `@unworklet/test/extend` で 分 離、 import 1 行 で test 全 体 に 反 映 + chain form を 使 わ な い consumer の bundle に chain 部 分 が 入 ら な い (= tree shake 整 合):

```ts
import "@unworklet/test/extend"; // = chain form 全 20 件 登 録 + TypeScript declare merge
```

### 6.1 chain 名 規 約

vitest core (= `toBe` / `toHave` / `toMatch` / `toContain` 等) に zip し て 個 別 自 然 化。 軸:

- **`toBe...`** = state / 形 容 詞 (= 「the result is X」)。 例: `toBeStable` / `toBeSilent` / `toBeFinite` / `toBeMasterReady`。
- **`toHave...`** = property 値 (= 「the result has X within bound」)。 例: `toHavePeakUnder(dbfs)` / `toHaveLatency(n)` / `toHaveDcOffsetUnder(threshold)`。
- **`toMatch...`** = pattern match (= 「the result matches Y」)。 例: `toMatchAudio(expected)` / `toMatchEvents(events)` / `toMatchState(blob)`。
- **`toContain...`** = 部 分 一 致 (= 「the result contains Z」)。 例: `toContainEvents(partial)`。
- snapshot 系 = vitest 標 準 `toMatchSnapshot` / `toMatchFileSnapshot` に zip。 例: `toMatchAudioSnapshot()` / `toMatchAudioFile(path)`。
- 動 詞 系 (= MIDI emit 等、 vitest `toThrow` 系) = 動 詞 化。 例: `toEmitMidi(port, events)`。

plain 名 と chain 名 は 1:1 機 械 派 生 で は な い (= chain 側 を 自 然 化 優 先)。 plain ↔ chain mapping は 各 plain 関 数 / chain method の JSDoc で 双 方 向 carry し て IDE hover 経 由 で 解 決。

chain method の receiver 型 は 既 定 で `expect(result).toMatchAudio(...)` の よ う に `RenderOfflineResult` だ け に 露 出 (= `WhenResult<T, M>` guard)。 例 外 = `toMatchAudioSnapshot` は plain `expectAudioMatchesSnapshot` の polymorphic actual (= `RenderOfflineResult | Float32Array | Float32Array[]`、 §2.1) に zip し て `WhenAudioActual<T, M>` で 拡 大、 `expect(sine(...)).toMatchAudioSnapshot()` (= signal generator 出 力 直 接) や `expect([ch0, ch1]).toMatchAudioSnapshot()` (= multi-ch buffer 直 接) も typecheck 通 過。

### 6.2 全 20 件 mapping

| plain                        | chain                  |
| ---------------------------- | ---------------------- |
| `expectAudioMatches`         | `toMatchAudio`         |
| `expectAudioMatchesGolden`   | `toMatchAudioFile`     |
| `expectAudioMatchesSnapshot` | `toMatchAudioSnapshot` |
| `expectNoNaN`                | `toBeFinite`           |
| `expectPeakUnder`            | `toHavePeakUnder`      |
| `expectRmsUnder`             | `toHaveRmsUnder`       |
| `expectStable`               | `toBeStable`           |
| `expectMaster`               | `toBeMasterReady`      |
| `expectSilence`              | `toBeSilent`           |
| `expectPeakAtSample`         | `toHavePeakAtSample`   |
| `expectGainAtFreq`           | `toHaveGainAtFreq`     |
| `expectLatency`              | `toHaveLatency`        |
| `expectDcOffsetUnder`        | `toHaveDcOffsetUnder`  |
| `expectEventsEqual`          | `toMatchEvents`        |
| `expectEventCount`           | `toHaveEventCount`     |
| `expectEventsContaining`     | `toContainEvents`      |
| `expectMidiOut`              | `toEmitMidi`           |
| `expectMidiBalance`          | `toHaveBalancedMidi`   |
| `expectStateMatches`         | `toMatchState`         |

## 7. Property-based test pattern

<!-- fast-check examples: bounded gain, stable feedback under random input, monotonicity invariants under parameter sweeps.
     The library does not bundle fast-check; the patterns are documented for users to wire up. -->

## 8. Vitest integration notes

<!-- Vite+ wraps Vitest; tests import from `vite-plus/test`, not `vitest`.
     See AGENTS.md for the Vite+ command surface. -->
