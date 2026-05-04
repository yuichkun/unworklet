# 04 — Worklet runtime (`@unworklet/worklet`)

The audio-thread side: the generated `AudioWorkletProcessor` template that wraps the compiled WASM, marshals I/O, dispatches messages and events, and enforces realtime-safety at the runtime boundary.

## Status

skeleton

## 1. Startup sequence

<!-- 1. Constructor receives processorOptions (WASM binary, optional SAB handles).
     2. Instantiate WASM, zero linear memory.
     3. Allocate message/event queues (SAB-backed if available; postMessage-backed otherwise).
     4. Run pre-warm loop (Q17 — count, both-branch coverage of `select`, optional user training input).
     5. Signal ready to main thread; createNode promise resolves.
     Q17 (pre-warm correctness) lands in step 4. -->

## 2. Per-block execution

<!-- 1. Drain message queue → invoke registered handlers.
     2. Marshal input channels into linear memory.
     3. Marshal parameter arrays (length 1 / 128 / 0 — see Q15).
     4. Call exported `process`.
     5. Read output channels from linear memory.
     6. Return true. -->

## 3. Render quantum handling

<!-- Q15 — block size as runtime constant vs compile-time constant; default 128;
     graceful behavior across spec revisions. Lands here. -->

## 4. Channel-count handling

<!-- Q16 — compile-time specialization (mono / stereo) vs generic loop; user opt-in for
     specialization at higher fixed counts. Lands here. -->

## 5. Pre-warm details

<!-- See §1 step 4 — full design including `select` branch coverage and training-input config. -->

## 6. Denormal handling

<!-- Q18 — auto-detection of feedback paths via DAG cycle analysis, flush-to-zero injection
     points, opt-out, static-analysis warnings. Lands here. -->

## 7. Publish-phase scheduling

<!-- Worklet-local scheduler; reads state, evaluates publish body, appends to event queue.
     Decoupled from the audio thread's timing constraints. -->

## 8. Error handling

<!-- WASM trap → emit error event, output silence, continue;
     unrecoverable error → destroy node, fire onError on main thread. -->
