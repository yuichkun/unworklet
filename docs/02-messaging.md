# 02 — Messaging (typed message / event contract)

Runtime contract for typed main↔worklet communication. Schema declaration syntax lives in `01-dsl.md` §4; this doc covers the wire-level contract, queue behavior, and delivery guarantees.

## Status

skeleton

## 1. Send / receive surface

<!-- Main-thread sender:    delay.messages.<name>(payload)
     Worklet handler:       sample.onMessage('<name>', handler)
     Publish-phase emitter: emit.<name>(payload)
     Main-thread subscriber: delay.events.<name>.on(handler) → unsubscribe -->

## 2. Delivery semantics

<!-- - Messages: drained at block boundaries, never mid-sample; in-arrival-order.
     - Events: non-blocking; worklet never waits for delivery; best-effort.
     - Both queues fixed-capacity; overflow → onError with structured diagnostic.
     - Variable-length payloads via SAB (when available) or pre-allocated transfer region (fallback). -->

## 3. Queue sizing and overflow policy

<!-- Default capacities, user-configurable knobs in processor config, exact overflow error shape. -->

## 4. SAB vs postMessage path

<!-- High-level: detect-at-runtime, choose path, surface active mode via diagnostic API.
     Detailed degradation behavior lives in 08-deployment.md §3 — this section just states the contract. -->

## 5. Wire format

<!-- Fixed-size message struct layout, ring buffer header, atomics protocol when SAB is in use. -->
