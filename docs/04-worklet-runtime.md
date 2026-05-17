# 04 — Worklet runtime (`@unworklet/worklet`)

The audio-thread side: the generated `AudioWorkletProcessor` template that wraps the compiled WASM, marshals I/O, dispatches messages and events, and enforces realtime-safety at the runtime boundary.

## Status

partial (§7 publish scheduling written; §1–§6 + §8 placeholder)

## 1. Startup sequence

<!-- 1. Constructor receives processorOptions (WASM binary, optional SAB handles).
     2. Instantiate WASM, zero linear memory.
     3. Allocate message/event queues (SAB-backed if available; postMessage-backed otherwise).
     4. Signal ready to main thread; createNode promise resolves.
     Note: there is no framework-side pre-warm step (Q20). -->

## 2. Per-block execution

<!-- 1. Drain message queue → invoke registered handlers.
     2. Marshal input channels into linear memory.
     3. Marshal parameter arrays (length 1 / 128 / 0 — see Q18).
     4. Call exported `process`.
     5. Read output channels from linear memory.
     6. Return true. -->

## 3. Render quantum handling

<!-- Q18 — block size as runtime constant vs compile-time constant; default 128;
     graceful behavior across spec revisions. Lands here. -->

## 4. Channel-count handling

The `channels: C` value declared on `audioInput({ channels: C, name })` / `audioOutput({ channels: C, name })` is **baked into the emitted WASM module** (Q19, `decisions-log.md`). The compiler emits one specialized code path per declared channel count, with channel access (`.at(c, i)` / `.set(c, i, v)`) lowering to direct WASM loads/stores at compile-time-known offsets — no per-sample dispatch on `c`. SIMD lane mapping for stride-based bulk operations is therefore also determined at compile time.

If a consumer needs both a mono and a stereo build of the same algorithm, they author **two separate `defineProcessor` calls** — one with `channels: 1`, one with `channels: 2`. There is no runtime switch.

As a structural consequence (Q19's resolution also closes the long-standing #62 hole), `createNode` does **not** accept main-side overrides for `numberOfInputs` / `numberOfOutputs` / `outputChannelCount`. Those values are derived from the processor's `audioInput` / `audioOutput` declarations and would invalidate the WASM specialization if changed at instantiation. See `05-client.md` §1.

Upstream sources that connect with a different channel count than the worklet declared are normalized by Web Audio's standard up-mix / down-mix rules (`channelCountMode` / `channelInterpretation`) before the worklet sees them; unworklet does not intervene in that layer (= same behavior as `01-dsl.md` §1.2 already specifies).

## 5. Pre-warm

unworklet does **not** provide a framework-side pre-warm step in v1.0.0 (Q20, `decisions-log.md`). The reasoning:

- WASM is AOT-compiled by the browser before the worklet's `process` is first invoked, so the classic JS "first-N-blocks JIT spike" does not apply.
- Hardware-level warmup (branch predictor, caches) settles within a few render quanta of real audio — the resulting transient is inaudible within the first few milliseconds of plugin output.
- Having the framework run silent blocks through user-authored `process` code at start-up would mean injecting synthesized inputs the author did not request, conflicting with the declarative principle that user-authored structure is what runs.

Consumers who genuinely need full-performance from the very first quantum (rare in practice) can warm up from the main side by feeding silent buffers through the AudioContext for a few quanta before connecting the real source. An opt-in `createNode(..., { preWarm: {...} })` option may be added additively in v1.x.0 if the need materializes (e.g. if a future browser switches WASM execution from AOT to partial JIT).

## 6. Denormal handling

IEEE 754 の **subnormal** 範 囲 (= 約 1e-38 以 下 の 極 小 値) は 多 く の CPU で 通 常 計 算 の 5〜100 倍 遅 い。 audio DSP の filter feedback path (= IIR filter の 内 部 state) が 長 い 無 音 区 間 で 0 に 漸 近 す る と こ の 範 囲 に 入 り、 audio thread の CPU spike → 音 切 れ の 原 因 と な る。

unworklet は こ の 経 路 を **コ ン パ イ ル 時 に 自 動 で 塞 ぐ** (Q21, `decisions-log.md`):

- `state.f32` / `state.f64` の `.store(v)` を WASM emission 時 に subnormal ガ ー ド で 包 む — 値 が 1e-30 以 下 (絶 対 値) な ら 0 に 落 と す
- ガ ー ド は 1 比 較 + 1 select の 軽 量 inline、 通 常 計 算 path で の cost は 無 視 で きる レ ベ ル
- user code は 変 更 ナ シ で 自 動 適 用 = audio DSP 業 界 標 準 の flush-to-zero と 同 等 の 挙 動

v1.0.0 で opt-out 機 能 は な い。 subnormal 値 を そ の ま ま 保 ち た い 数 値 計 算 用 途 (= 科 学 計 算 等) は unworklet の scope 外 と し て 扱 う。 必 要 性 が 出 た 時 点 で v1.x.0 で opt-out option を additive に 追 加 検 討。

framework が user 値 を 暗 黙 で 変 え る 形 に な る が、 1e-40 等 の 極 小 値 は audio 出 力 と し て 不 可 聴 = 0 と み な し て 音 の 意 味 は 変 わ ら な い こ と、 既 audio framework (JUCE 等) で の 業 界 標 準 と 整 合 す る こ と、 footgun 撤 廃 の 価 値 で declarative 原 則 か ら の 例 外 を 正 当 化 す る。


## 7. State publish scheduling

The worklet runtime drives `state.publish` and `buffer.publish` propagation directly from the audio thread. There is no separate publish lambda (see `01-dsl.md` §6 and `decisions-log.md` Q27-a).

Per render quantum, after the user's `process` body completes:

1. Runtime walks the list of `publish`-flagged slots. Each slot carries a per-slot counter in sample-units (initialized to 0 at instantiation) and a target threshold derived from `rateFps × SAMPLES_PER_BLOCK / sampleRate`.
2. Each slot's counter is incremented by `SAMPLES_PER_BLOCK`. If the counter has met or exceeded the threshold, the slot is **due**: runtime copies the current scalar value (`Atomics.store` for `state.<type>`) or the buffer region (`memcpy` for `buffer.<type>`) into the shared region, **unconditionally** increments the slot's version counter (see `02-messaging.md` §5.4 and Q39-a in `decisions-log.md` — no value-equality check on the audio thread), and resets the local counter (carrying the remainder).
3. Runtime continues to the next render quantum.

Cost per published slot is bounded: scalar copies are one `Atomics.store`; buffer copies are `memcpy` over a fixed region. Higher `rateFps` schedules more frequent copies but never blocks; lower `rateFps` simply skips the copy in most blocks. The audio thread never allocates and never waits on the main thread.

In the SAB-unavailable fallback, the same scheduling logic runs on the audio thread; the "copy into shared region" step is replaced by enqueuing the current value (or buffer view) into a postMessage at the render-quantum boundary. Sample-accurate timing of internal updates is unaffected; main-side observation latency picks up the postMessage round-trip.

Subscriber notification (main side) is described in `05-client.md` §5.

Authoritative API: `01-dsl.md` §3 (declaration shape) + `05-client.md` §2 (main-side reader).
Authoritative rationale: `decisions-log.md` Q27.

## 8. Error handling

<!-- WASM trap → emit error event, output silence, continue;
     unrecoverable error → destroy node, fire onError on main thread. -->
