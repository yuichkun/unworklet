# 05 — Client (`@unworklet/client`)

The main-thread API. Wraps the standard `AudioWorkletNode` with a typed surface for params, messages, and events, and manages module loading, readiness, and disposal.

## Status

skeleton

## 1. `createNode`

<!-- createNode<C>(context, processor, options?): Promise<UnworkletNode<C>>
     - context: BaseAudioContext
     - processor: CompiledProcessor<C> (artifact from the compiler)
     - options.initial: per-param initial values
     - options.numberOfInputs / numberOfOutputs / outputChannelCount: AudioWorkletNodeOptions passthroughs
     Loads WASM (cached), adds Worklet module, instantiates the node, awaits worklet readiness. -->

## 2. `UnworkletNode<C>` surface

<!-- - .node:     raw AudioWorkletNode (for advanced graph wiring)
     - .params:   typed AudioParam accessors
     - .messages: typed senders (.<name>(payload))
     - .events:   typed subscribers (.<name>.on(handler) → unsubscribe)
     - .dispose(): tear down node, queues, worklet
     - .onError(handler): error subscription (worklet traps, queue overflow, SAB-mode change). -->

## 3. Param connection / automation

<!-- Standard AudioParam capabilities are preserved end-to-end:
     - setValueAtTime / linearRamp / exponentialRamp
     - connection from other AudioNodes (LFO modulation) — example in §3.3 of 01-dsl.md. -->

## 4. Lifecycle states

<!-- creating → ready → running → disposed.
     Errors transition: any → errored (terminal). -->

## 5. Event subscription details

<!-- Tick scheduling for queue drain on main thread; backpressure if subscribers are slow;
     unsubscribe semantics. -->
