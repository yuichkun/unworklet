# 04 — Worklet runtime (`@unworklet/worklet`)

The audio-thread side: the generated `AudioWorkletProcessor` template that wraps the compiled WASM, marshals I/O, dispatches messages and events, and enforces realtime-safety at the runtime boundary.

## Status

partial (§7 publish scheduling written; §1–§6 + §8 placeholder)

## 1. Startup sequence

<!-- 1. Constructor receives processorOptions (WASM binary, optional SAB handles).
     2. Instantiate WASM, zero linear memory.
     3. Allocate message/event queues (SAB-backed if available; postMessage-backed otherwise).
     4. Run pre-warm loop (Q20 — count, both-branch coverage of `select`, optional user training input).
     5. Signal ready to main thread; createNode promise resolves.
     Q20 (pre-warm correctness) lands in step 4. -->

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

## 5. Pre-warm details

<!-- See §1 step 4 — full design including `select` branch coverage and training-input config. -->

## 6. Denormal handling

<!-- Q21 — auto-detection of feedback paths via DAG cycle analysis, flush-to-zero injection
     points, opt-out, static-analysis warnings. Lands here. -->

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
