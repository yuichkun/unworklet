# 04 — Worklet runtime

The audio-thread side: the generated `AudioWorkletProcessor` template that wraps the compiled WASM, marshals I/O, dispatches messages and events, and enforces realtime-safety at the runtime boundary. The worklet runtime template itself is an internal artifact of `@unworklet/core`; its emission is one of the outputs of `@unworklet/core`'s `compile` function (= the same entry point that `@unworklet/unplugin` invokes inside the bundler build pipeline, that `@unworklet/offline` invokes inside `renderOffline`, and that a plain Node or browser host script invokes directly — all consumers go through the same function). The emitted template is loaded via `audioWorklet.addModule(processorUrl)`; there is no direct `import` surface.

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
          - event<T> ringbuffers (both directions — Q27-d, SAB when available)
          - event<T> payload content buffers (Q27-e)
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
     1. Drain **all** registered handlers across `event<T>({ from: "main" }).onReceive`
        + every `event.midi({ from: "main" }).onEvent` port (Q38-b — handlers run before any per-block
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

IEEE 754 **subnormal** values (magnitudes below approximately 1e-38) are 5–100x slower than normal-range arithmetic on many CPUs. When the internal state of an IIR filter's feedback path approaches zero during a long silence, it can enter this range, causing CPU spikes on the audio thread and audible dropouts.

unworklet **closes this path automatically at compile time** (Q21, `decisions-log.md`):

- Every `.write(v)` call on `state.f32` / `state.f64` is wrapped with a subnormal guard during WASM emission: values whose absolute magnitude falls below **`1e-30`** are flushed to zero. The 1e-30 threshold fully covers the IEEE 754 binary32 subnormal range (approximately 2^-126 to 2^-149, i.e. below approximately 1.18e-38); the narrow tail of normal-range values between 1.18e-38 and 1e-30 is also flushed, but those magnitudes are inaudible as audio output (= Q21 rationale). The threshold is a single fixed value with no user adjustment.
- The guard is a lightweight inline sequence — one comparison and one select — with negligible cost on the normal execution path.
- The guard applies automatically with no change to user code, equivalent to the flush-to-zero behavior that is standard practice in audio DSP frameworks.

v1.0.0 does not provide an opt-out. Use cases that require subnormal values to be preserved (e.g. scientific computation) are outside unworklet's scope. If such a need arises, an opt-out option can be added additively in v1.x.0.

Although the framework silently modifies user-written values, values as small as 1e-40 are inaudible as audio output and are therefore semantically equivalent to zero. This behavior is consistent with established audio frameworks such as JUCE, and the footgun-elimination value justifies the exception to the declarative principle.

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

Main-side `node.onError(handler)` receives a discriminated union. The v1.0.0 event-code catalog has five entries:

```typescript
type NodeErrorEvent =
  | { code: "wasm-trap"; message: string }
  | { code: "queue-overflow"; source: "event" | "message" | "midi"; name: string; dropped: number }
  | { code: "sab-unavailable" }
  | { code: "block-length-mismatch"; expected: number; received: number }
  | { code: "worklet-initialize-not-called" };
```

1. **`wasm-trap`** — WASM runtime trap during `process(...)`. Audio output: silence for the current quantum + the following quanta until the node is disposed. The audio thread does not propagate the trap as a thrown exception (= realtime-safety invariant 3 in `00-foundations.md` §5.1).
2. **`queue-overflow`** — `event<T>` (both directions) / MIDI ringbuffer drop-oldest fired (Q27 + Q4-c-iv). The `source` discriminant identifies which transport overflowed: `"event"` for `event<T>({ to: "main" })` (worklet → main), `"message"` for `event<T>({ from: "main" })` (main → worklet), and `"midi"` for MIDI. Audio output is unaffected. Per-channel cumulative overflow counts are observable via `node.<kind>.<name>.diagnostics.overflowCount()` (Q47) — push (`.onError`) reports each individual drop as it occurs, while pull (`.diagnostics`) exposes the running total.
3. **`sab-unavailable`** — runtime detected that `SharedArrayBuffer` is not constructible or `crossOriginIsolated` is false, and selected the postMessage fallback transport (= A5 of `08-deployment.md` §2 / Q11). Audio output is unaffected; only main-side observation latency picks up the postMessage round-trip.
4. **`block-length-mismatch`** — `outputs[0][0].length !== SAMPLES_PER_BLOCK` detected at the worklet entry (= §3 / Q18 / Q68 / Q75). Audio output: silence (zero buffer) on every quantum after the first detection, until the node is disposed (= same path as `wasm-trap`). Node stays connected; consumer decides whether to `.dispose()` and replace.
5. **`worklet-initialize-not-called`** — in the path-beta escape hatch (= `01-dsl.md` §11), an author-supplied `class extends AudioWorkletProcessor` called `def.worklet.process(this, ...)` without first calling `def.worklet.initialize(this, opts)` in the constructor. Because the audio thread cannot throw (= invariant 3), the worklet sends a single structured postMessage notification and produces silence thereafter. Q80.

Node destruction is initiated only by the consumer via `.dispose()` (= `05-client.md` §2). There is no framework-side "destroy node on error" path in v1.0.0 — `wasm-trap` / `block-length-mismatch` / `worklet-initialize-not-called` emit silence on the output channels while keeping the node object addressable and connected, so the consumer can observe `.onError` + tear down explicitly (Q75).

Fine-grained details of per-error-code message shape, source-location attribution (via §7 source maps), and recovery semantics are impl-phase fill per Q61.
