# 04 — Worklet runtime

The audio-thread side: the generated `AudioWorkletProcessor` template that wraps the compiled WASM, marshals I/O, dispatches messages and events, and enforces realtime-safety at the runtime boundary. This is an internal module of `@unworklet/core` — the template is emitted by `@unworklet/vite-plugin` at build time and loaded via `audioWorklet.addModule(processorUrl)`; there is no direct `import` surface.

The default `addModule` output also `registerProcessor`s the generated template under its compile-time name, so authors using the declarative path never call `registerProcessor` themselves. Authors who need to touch the web-standard `AudioWorkletProcessor` surface directly (custom `constructor(opts)`, raw `this.port`, `process()` return-value lifecycle, custom methods) build their own `class extends AudioWorkletProcessor` using `def.worklet = { initialize, process, parameterDescriptors }` and `registerProcessor` it under a separate name — both names coexist, both back the same `CompiledProcessor<C>`. See `01-dsl.md` §11 and `decisions-log.md` Q80.

## Status

partial (§7 publish scheduling written; §1–§6 + §8 placeholder)

## 1. Startup sequence

<!-- Startup sequence (audio-thread side; runs once per node instantiation):
     1. Constructor receives processorOptions (WASM binary, optional SAB
        handles + pre-allocated transfer buffers for the postMessage
        fallback per A5 of 08-deployment §2).
     2. Instantiate WASM. Linear memory is pre-sized at build time from
        auto-summed declarations (Q30); zero-initialize.
     3. Allocate / wire up all pre-allocated regions per 03-compiler §4
        sub-region set:
          - state slots + buffer slots (Q5; values restored if `restore`
            blob was provided)
          - event<T> / message<T> ringbuffers (Q27-d — SAB when available)
          - event<T> / message<T> payload content buffers (Q27-e)
          - MIDI in / out ringbuffers (Q4-c)
          - sysex content buffer (Q4-c-iii)
          - state.publish / buffer.publish shared regions (Q27-a)
          - per-slot publish counters (§7 — initialize each to 0)
          - snapshot region (Q5)
     4. Signal ready to main thread; `createNode` promise resolves.

     No framework-side pre-warm step (Q20). Per-region byte-layout
     specifics + WASM instantiate options are impl-phase fill per Q61. -->

## 2. Per-block execution

<!-- Per-block runtime step order:
     1. Drain **all** registered handlers across `message<T>.onReceive` + every
        `midiInput().onEvent` port (Q38-b — handlers run before any per-block
        top-level statement or `forSample`, in registration order). Sample-
        accurate `atSample` is carried into the handler arg (Q38-d).
     2. Marshal input channels into linear memory (Q19 — channel count baked
        into WASM, no per-sample dispatch on `c`).
     3. Marshal parameter arrays (length 1 / 128 / 0 — see Q18 / A3 in
        08-deployment §2).
     4. Call the exported `process(...)` with the 4 I/O pointer args (= input
        channels / output channels / param arrays / message queue per
        03-compiler §4).
     5. Read output channels from linear memory.
     6. Walk publish-flagged slots (state.publish / buffer.publish) per §7:
        increment per-slot counter, copy to shared region + bump version on
        due ticks (Q27-a, Q39-a).
     7. Return true.

     Per-step impl shape detail is impl-phase fill per Q61. -->


## 3. Render quantum handling

The Web Audio spec fixes the render quantum at 128 samples. unworklet bakes that value (`SAMPLES_PER_BLOCK = 128`, see Q35) **all the way into the emitted WASM** (Q18, `decisions-log.md`):

- `forSample` / `forSample.byN` loop bounds are emitted as compile-time-constant 128 / `128 / stride` iteration counts.
- Audio-I/O buffer offsets and SIMD lane mapping are resolved at compile time from the same constant.
- The WASM code never reads the block size at runtime — no per-quantum branch on length, no dynamic loop bound.

For safety against a future browser changing the render quantum size, the worklet's `process(inputs, outputs)` entry point performs a single runtime length check (`outputs[0][0].length === SAMPLES_PER_BLOCK`) before invoking the WASM `process` function. If the check fails, the worklet **emits silence** (zero buffer) on every output channel, **leaves the node connected** to the audio graph (`process()` returns `true`), and fires a main-side `node.onError({ code: 'block-length-mismatch', expected: 128, received: <actual> })` event (§8). The node stays addressable so the consumer can `.dispose()` and replace it, surface the failure to the user, or both — framework-side auto-dispose-on-error is not part of v1.0.0 (§8). Same fallback path as `wasm-trap` (§8) — uniform "silence + onError + node connected" runtime guard contract (Q75):

```text
runtime guard (worklet):
  Render quantum size mismatch: expected 128, got 256.
  Output switched to silence; node stays connected. Consumer can observe
  node.onError({ code: 'block-length-mismatch', ... }) and dispose / replace.
  This unworklet build is compiled against the Web Audio spec's fixed 128-sample
  render quantum. If a browser update changes that size, this processor build
  must be regenerated against the new specification.
```

Adaptive emission (= a single build that handles multiple render-quantum sizes) is permanently out of v1.0.0 scope; if browser specs evolve, it can be added additively in v1.x.0 without changing the v1.0.0 surface.

## 4. Channel-count handling

The `channels: C` value declared on `audioInput({ channels: C, name })` / `audioOutput({ channels: C, name })` is **baked into the emitted WASM module** (Q19, `decisions-log.md`). The compiler emits one specialized code path per declared channel count, with channel access (`.ch(c).at(i)` reader / `.ch(c).at(i).write(v)` writer per Q78) lowering to direct WASM loads/stores at compile-time-known offsets — no per-sample dispatch on `c`. SIMD lane mapping for stride-based bulk operations is therefore also determined at compile time.

If a consumer needs both a mono and a stereo build of the same algorithm, they author **two separate `defineProcessor` calls** — one with `channels: 1`, one with `channels: 2`. There is no runtime switch.

As a structural consequence (Q19's resolution also closes #62), `createNode` does **not** accept main-side overrides for `numberOfInputs` / `numberOfOutputs` / `outputChannelCount`. Those values are derived from the processor's `audioInput` / `audioOutput` declarations and would invalidate the WASM specialization if changed at instantiation. See `05-client.md` §1.

Upstream sources that connect with a different channel count than the worklet declared are normalized by Web Audio's standard up-mix / down-mix rules (`channelCountMode` / `channelInterpretation`) before the worklet sees them; unworklet does not intervene in that layer (= same behavior as `01-dsl.md` §1.2 specifies).

## 5. Pre-warm

unworklet does **not** provide a framework-side pre-warm step in v1.0.0 (Q20, `decisions-log.md`). The reasoning:

- WASM is AOT-compiled by the browser before the worklet's `process` is first invoked, so the JS-style "first-N-blocks JIT spike" pattern does not apply.
- Hardware-level warmup (branch predictor, caches) settles within a few render quanta of real audio — the resulting transient is inaudible within the first few milliseconds of plugin output.
- Having the framework run silent blocks through user-authored `process` code at start-up would mean injecting synthesized inputs the author did not request, conflicting with the declarative principle that user-authored structure is what runs.

Consumers who genuinely need full-performance from the very first quantum (rare in practice) can warm up from the main side by feeding silent buffers through the AudioContext for a few quanta before connecting the real source. An opt-in `createNode(..., { preWarm: {...} })` option may be added additively in v1.x.0 if the need materializes (e.g. if a future browser switches WASM execution from AOT to partial JIT).

## 6. Denormal handling

IEEE 754 の **subnormal** 範 囲 (= 約 1e-38 以 下 の 極 小 値) は 多 く の CPU で 通 常 計 算 の 5〜100 倍 遅 い。 audio DSP の filter feedback path (= IIR filter の 内 部 state) が 長 い 無 音 区 間 で 0 に 漸 近 す る と こ の 範 囲 に 入 り、 audio thread の CPU spike → 音 切 れ の 原 因 と な る。

unworklet は こ の 経 路 を **コ ン パ イ ル 時 に 自 動 で 塞 ぐ** (Q21, `decisions-log.md`):

- `state.f32` / `state.f64` の `.store(v)` を WASM emission 時 に subnormal ガ ー ド で 包 む — 絶 対 値 が **`1e-30`** 以 下 な ら 0 に 落 と す。 閾 値 1e-30 は IEEE 754 binary32 の subnormal 範 囲 (≈ 2^-126 〜 2^-149、 ≈ 1.18e-38 以 下) を 完 全 に 含 む 単 純 boundary で、 normal 範 囲 の 末 端 (1.18e-38 〜 1e-30) も 同 時 に flush さ れ る が audio 出 力 と し て 不 可 聴 (= Q21 rationale)、 user 調 整 余 地 ナ シ で 1 値 fix
- ガ ー ド は 1 比 較 + 1 select の 軽 量 inline、 通 常 計 算 path で の cost は 無 視 で きる レ ベ ル
- user code は 変 更 ナ シ で 自 動 適 用 = audio DSP 業 界 標 準 の flush-to-zero と 同 等 の 挙 動

v1.0.0 で opt-out 機 能 は な い。 subnormal 値 を そ の ま ま 保 ち た い 数 値 計 算 用 途 (= 科 学 計 算 等) は unworklet の scope 外 と し て 扱 う。 必 要 性 が 出 た 時 点 で v1.x.0 で opt-out option を additive に 追 加 検 討。

framework が user 値 を 暗 黙 で 変 え る 形 に な る が、 1e-40 等 の 極 小 値 は audio 出 力 と し て 不 可 聴 = 0 と み な し て 音 の 意 味 は 変 わ ら な い こ と、 既 audio framework (JUCE 等) で の 業 界 標 準 と 整 合 す る こ と、 footgun 撤 廃 の 価 値 で declarative 原 則 か ら の 例 外 を 正 当 化 す る。

## 7. State publish scheduling

The worklet runtime drives `state.publish` and `buffer.publish` propagation directly from the audio thread. There is no separate publish lambda: continuous worklet → main values are declared with the `publish` option on `state` / `buffer` (see `01-dsl.md` §3 and `decisions-log.md` Q27-a), and moment-in-time worklet → main delivery uses `event<T>.emitIf(...)` (Q27-b) and MIDI emit. The publish path covers continuous values only.

Per render quantum, after the user's `process` body completes:

1. Runtime walks the list of `publish`-flagged slots. Each slot carries a per-slot counter in sample-units (initialized to 0 at instantiation) and a target threshold = **`sampleRate / rateFps`** (= the number of samples that elapse between consecutive publish ticks at the requested fps — higher `rateFps` means a smaller threshold, more frequent publishes).
2. Each slot's counter is incremented by `SAMPLES_PER_BLOCK`. If the counter has met or exceeded the threshold, the slot is **due**: runtime copies the current scalar value (`Atomics.store` for `state.<type>`) or the buffer region (`memcpy` for `buffer.<type>`) into the shared region, **unconditionally** increments the slot's version counter (see `02-messaging.md` §5.4 and Q39-a in `decisions-log.md` — no value-equality check on the audio thread), and subtracts the threshold from the local counter (carrying the remainder).
3. Runtime continues to the next render quantum.

Cost per published slot is bounded: scalar copies are one `Atomics.store`; buffer copies are `memcpy` over a fixed region. Higher `rateFps` schedules more frequent copies but never blocks; lower `rateFps` simply skips the copy in most blocks. The audio thread never allocates and never waits on the main thread.

In the SAB-unavailable fallback, the same scheduling logic runs on the audio thread; the "copy into shared region" step is replaced by enqueuing the current value (or buffer view) into a postMessage at the render-quantum boundary. Sample-accurate timing of internal updates is unaffected; main-side observation latency picks up the postMessage round-trip.

Subscriber notification (main side) is described in `05-client.md` §5.

Authoritative API: `01-dsl.md` §3 (declaration shape) + `05-client.md` §2 (main-side reader).
Authoritative rationale: `decisions-log.md` Q27.

## 8. Error handling

Main-side `node.onError(handler)` receives a discriminated union. v1.0.0 の event-code カ タ ロ グ は 4 種:

```typescript
type NodeErrorEvent =
  | { code: 'wasm-trap';            message: string }
  | { code: 'queue-overflow';       source: 'event' | 'message' | 'midi'; name: string; dropped: number }
  | { code: 'sab-unavailable' }
  | { code: 'block-length-mismatch'; expected: number; received: number };
```

1. **`wasm-trap`** — WASM runtime trap during `process(...)`. Audio output: silence for the current quantum + the following quanta until the node is disposed. The audio thread does not propagate the trap as a thrown exception (= realtime-safety invariant 3 in `00-foundations.md` §5.1).
2. **`queue-overflow`** — `event<T>` / `message<T>` / MIDI ringbuffer drop-oldest fired (Q27 + Q4-c-iv)。 Audio output unaffected。 Per-channel 累 計 counter は `node.<kind>.<name>.diagnostics.overflowCount()` で pull 観 測 (Q47)。 つ ま り push (= `.onError`) で 各 drop の 発 生 を 通 知、 pull (= `.diagnostics`) で 累 計 を 取 る 二 段 構 え。
3. **`sab-unavailable`** — runtime detected `SharedArrayBuffer` is not constructible / `crossOriginIsolated` is false and selected the postMessage fallback transport (= A5 of `08-deployment.md` §2 / Q11)。 Audio output unaffected; only main-side observation latency picks up the postMessage round-trip.
4. **`block-length-mismatch`** — `outputs[0][0].length !== SAMPLES_PER_BLOCK` detected at the worklet entry (= §3 / Q18 / Q68 / Q75)。 Audio output: silence (zero buffer) on every quantum after the first detection, until the node is disposed (= same path as `wasm-trap`). Node stays connected; consumer decides whether to `.dispose()` and replace.

Node destruction is initiated only by the consumer via `.dispose()` (= `05-client.md` §2)。 There is no framework-side "destroy node on error" path in v1.0.0 — `wasm-trap` / `block-length-mismatch` emit silence on the output channels while keeping the node object addressable and connected, so the consumer can observe `.onError` + tear down explicitly (Q75).

Per-error-code message shape の細部、 source-location attribution (= §7 source maps 経 由)、 recovery semantics は impl-phase fill per Q61。

