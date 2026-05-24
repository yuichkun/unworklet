# unworklet

**A declarative framework for writing Audio Worklet-based DSP in TypeScript, compiled to WebAssembly with realtime-safety guarantees.**

Version: 0.1.0 (Draft)
Status: Design Specification

---

## Table of Contents

1. [Overview](#1-overview)
2. [Goals and Non-Goals](#2-goals-and-non-goals)
3. [Architecture](#3-architecture)
4. [Core Concepts](#4-core-concepts)
5. [API Reference](#5-api-reference)
6. [Usage Examples](#6-usage-examples)
7. [Compilation Pipeline](#7-compilation-pipeline)
8. [Runtime Behavior](#8-runtime-behavior)
9. [Testing](#9-testing)
10. [Benchmarking and Profiling](#10-benchmarking-and-profiling)
11. [Design Decisions](#11-design-decisions)
12. [Implementation Concerns](#12-implementation-concerns)
13. [Open Questions](#13-open-questions)
14. [Roadmap](#14-roadmap)

---

## 1. Overview

`unworklet` is a TypeScript-first framework for building realtime audio DSP that runs inside the Web Audio API's `AudioWorkletGlobalScope`. Users write a single declarative processor definition in TypeScript; the framework handles everything else:

- Generation of the `AudioWorkletProcessor` subclass and `registerProcessor` call
- Compilation of the DSP graph to WebAssembly
- Automatic `parameterDescriptors` derivation
- Lock-free message passing in both directions
- SharedArrayBuffer-backed bulk data transfer (when available)
- Static memory layout with zero runtime allocation
- Pre-warming and JIT tiering stabilization
- Typed client-side API for the main thread

The library exists because the rules of realtime audio programming (no allocation, no locks, no system calls, no unbounded loops on the audio thread) are difficult to enforce in JavaScript by convention alone. `unworklet` enforces them **by construction**: the user's DSP code is expressed through primitives that can only produce allocation-free WebAssembly.

### 1.1 Scope

`unworklet` is a **standalone library**. It targets the Web Audio API as specified by the W3C and runs in any compliant browser or runtime that exposes the Audio Worklet interface. It has no dependency on any specific host application, embedding runtime, or modified browser distribution. Any user of the Web Audio API can adopt `unworklet` independently.

### 1.2 Naming

`unworklet` — "un-" the Worklet. Users do not write an `AudioWorkletProcessor`. They declare a processor; the framework produces the Worklet.

---

## 2. Goals and Non-Goals

### Goals

- **Zero Worklet boilerplate**: Users never write `extends AudioWorkletProcessor`, `registerProcessor`, `port.postMessage`, or `parameterDescriptors`.
- **Realtime-safe by construction**: All compiled DSP paths are statically guaranteed to perform zero heap allocations, no GC-triggering operations, and no unbounded loops.
- **TypeScript-native**: The full TypeScript type system applies to user code. IDE support, refactoring, and type inference work exactly as in any other TypeScript project.
- **npm-ecosystem-compatible**: Build-time and test-time code can use any npm package. Runtime DSP code is restricted to unworklet primitives.
- **Testable without browser**: A pure-JavaScript backend allows every processor to run under Vitest/Jest in Node.js.
- **Multi-target compilation**: A single processor definition compiles to WebAssembly (production), pure JavaScript (testing), and optionally other targets (C, WAT, GraphViz) from the same source.
- **Typed bidirectional messaging**: Main↔Worklet communication is statically typed end-to-end.
- **Deterministic memory footprint**: Memory usage is known and bounded at compile time.
- **Standards-only runtime**: Executes correctly in any spec-compliant Web Audio implementation.

### Non-Goals

- **Not a full DSP standard library**: unworklet provides primitive operators (`add`, `mul`, `sin`, `load`, `store`, `branch`). High-level constructs (`lowpass`, `reverb`, `adsr`) are distributed as separate, optional packages or user code.
- **Not a Faust replacement**: unworklet targets JavaScript developers, not DSP language veterans. Faust's mathematical abstraction level is intentionally out of scope.
- **Not an Elementary replacement**: Elementary is a runtime audio graph engine; unworklet is a compilation framework. The two are complementary, not competitive.
- **Not a replacement for hand-written WASM**: Users who need cutting-edge optimization should write WASM directly. unworklet targets the 90% case.
- **Not a music-making framework**: unworklet is the DSP layer. Higher-level concerns (sequencing, MIDI, song structure) are application-level.

---

## 3. Architecture

### 3.1 System Overview

```
┌──────────────────────────────────────────────────────────────┐
│                     User Source Code                          │
│                                                                │
│   ┌────────────────┐    ┌─────────────────┐                  │
│   │ processor.ts   │    │   app.ts        │                  │
│   │ (DSP definition)│    │ (Main thread)   │                  │
│   └────────┬───────┘    └────────┬────────┘                  │
└────────────┼─────────────────────┼────────────────────────────┘
             │                     │
             ▼                     ▼
┌────────────────────┐    ┌─────────────────────┐
│  unworklet Compiler │    │ @unworklet/client   │
│  (build-time)       │    │ (runtime)           │
│                     │    │                     │
│  - Graph building   │    │  - Node factory     │
│  - Static analysis  │    │  - Param bridging   │
│  - WASM emission    │    │  - Event dispatch   │
│  - Worklet codegen  │    │  - Queue management │
└─────────┬───────────┘    └──────────┬──────────┘
          │                           │
          ▼                           ▼
┌────────────────────┐    ┌─────────────────────┐
│  Build Artifacts   │    │   Browser Runtime   │
│                     │    │                     │
│  - processor.wasm   │◄───│  AudioWorkletNode   │
│  - processor.js     │    │                     │
│  - types.d.ts       │    │  AudioWorkletGlobal-│
│  - meta.json        │    │  Scope              │
└────────────────────┘    └─────────────────────┘
```

### 3.2 Package Layout

```
@unworklet/core         Primitive DSL, processor definition API
@unworklet/dsp          Arithmetic, control flow, memory primitives
@unworklet/compiler     AST → WASM compiler, codegen
@unworklet/client       Main-thread runtime (AudioWorkletNode wrapper)
@unworklet/worklet      Worklet-side runtime (AudioWorkletProcessor template)
@unworklet/test         Offline pure-JS renderer for Vitest/Jest
@unworklet/cli          Build, bench, dev-server commands
@unworklet/bench        Benchmarking utilities
```

### 3.3 Compilation Flow

```
processor.ts  ──►  AST (call graph of primitives)
                    │
                    ├─► Static Analysis
                    │   - Allocation check
                    │   - Loop boundedness
                    │   - Memory usage
                    │   - Cycle estimation
                    │
                    ├─► WASM Emitter (binaryen.js based)
                    │   ├─► .wasm binary
                    │   └─► Linear memory layout
                    │
                    ├─► Worklet JS Codegen
                    │   ├─► AudioWorkletProcessor class
                    │   ├─► parameterDescriptors
                    │   ├─► Message queue setup
                    │   └─► registerProcessor() call
                    │
                    ├─► Client TypeScript Codegen
                    │   ├─► Typed node wrapper
                    │   ├─► Typed param accessors
                    │   ├─► Typed message/event API
                    │   └─► .d.ts emission
                    │
                    └─► Metadata JSON
                        ├─► Parameter descriptors
                        ├─► Memory requirements
                        └─► Estimated CPU budget
```

---

## 4. Core Concepts

### 4.1 Processor Definition

A processor is declared with `defineProcessor(config)`. The result is a compile-time artifact consumed by `@unworklet/client` on the main thread and by the generated Worklet module in the `AudioWorkletGlobalScope`.

### 4.2 Nodes

All DSP primitives return `Node<T>` where `T` is a scalar type (`f32`, `f64`, `i32`, `i64`, or `bool`). Nodes are immutable representations of computation, not values. They form a directed acyclic graph.

Operators such as `add`, `mul`, `sin` accept `Node<T> | number` arguments and return `Node<T>`. The `number` case is automatically lifted to a `Node<T>` constant.

### 4.3 State

Persistent state between blocks is declared with `state.f32(initial)`, `state.i32(initial)`, etc. State objects expose `.load()` and `.store(node)`. State is allocated in WASM linear memory at compile time; no runtime allocation occurs.

### 4.4 Buffers

Fixed-size arrays are declared with `buffer.f32({ size, name })`. Buffers expose `readBuffer`, `writeBuffer`, and interpolated variants. Buffer size must be statically known or derived from `ctx.sampleRate` at compile time.

### 4.5 Parameters

Parameters are declared with `param({ default, min, max, automationRate, unit? })`. Within `process`, parameters are accessed via `params.<name>.at(i)`. The `.at(i)` call resolves to either a constant load (k-rate) or an indexed array load (a-rate) at compile time. The user never writes the length-branching code.

### 4.6 Messages (Main → Worklet)

Typed commands sent from the main thread. Declared with `message({ field: 'type', ... })`. Handled inside `process()` via `sample.onMessage('name', handler)`. Messages are drained at block boundaries, never mid-sample.

### 4.7 Events (Worklet → Main)

Typed notifications from the worklet. Declared with `event({ field: 'type', ... })`. Emitted from a separate `publish()` phase via `emit.<name>(payload)`. Internally delivered through a ring buffer (SAB-backed when cross-origin isolation permits, `postMessage` fallback otherwise) and flushed on a separate tick.

### 4.8 Context

The `ctx` object provides runtime constants made available at compile time: `ctx.sampleRate`, `ctx.blockSize` (128 per current spec), `ctx.channelCount`. These values are loaded from the `AudioContext` at processor instantiation and embedded into the WASM execution context.

### 4.9 Two Execution Phases

- **`process`**: Runs every audio block. Mapped to WASM. Hard realtime constraints apply. No allocation, no unbounded loops, no I/O.
- **`publish`**: Runs on a separate scheduler (e.g., every 33ms). Reads state, emits events. Not realtime-critical. Compiled to plain JavaScript.

---

## 5. API Reference

### 5.1 `@unworklet/core`

```typescript
function defineProcessor<C extends ProcessorConfig>(config: C): CompiledProcessor<C>;

function audioInput(opts: { channels: number }): InputDecl;
function audioOutput(opts: { channels: number }): OutputDecl;

function param<T extends ParamConfig>(config: T): ParamDecl<T>;
function state: {
  f32: (initial: number) => StateRef<'f32'>;
  f64: (initial: number) => StateRef<'f64'>;
  i32: (initial: number) => StateRef<'i32'>;
  i64: (initial: bigint) => StateRef<'i64'>;
  bool: (initial: boolean) => StateRef<'bool'>;
};

function buffer: {
  f32: (opts: { size: number | StaticExpr; name: string }) => BufferRef<'f32'>;
  // ... other types
};

function message<S extends MessageSchema>(schema: S): MessageDecl<S>;
function event<S extends EventSchema>(schema: S): EventDecl<S>;
```

### 5.2 `@unworklet/dsp`

Primitive operators (non-exhaustive):

```typescript
// Arithmetic
function add<T>(a: Node<T> | number, b: Node<T> | number): Node<T>;
function sub<T>(a: Node<T> | number, b: Node<T> | number): Node<T>;
function mul<T>(a: Node<T> | number, b: Node<T> | number): Node<T>;
function div<T>(a: Node<T> | number, b: Node<T> | number): Node<T>;
function mod<T>(a: Node<T> | number, b: Node<T> | number): Node<T>;
function neg<T>(a: Node<T>): Node<T>;

// Comparison
function eq<T>(a: Node<T>, b: Node<T> | number): Node<"bool">;
function lt<T>(a: Node<T>, b: Node<T> | number): Node<"bool">;
function gt<T>(a: Node<T>, b: Node<T> | number): Node<"bool">;
function lte<T>(a: Node<T>, b: Node<T> | number): Node<"bool">;
function gte<T>(a: Node<T>, b: Node<T> | number): Node<"bool">;

// Math
function sin(x: Node<"f32"> | number): Node<"f32">;
function cos(x: Node<"f32"> | number): Node<"f32">;
function tan(x: Node<"f32"> | number): Node<"f32">;
function tanh(x: Node<"f32"> | number): Node<"f32">;
function exp(x: Node<"f32"> | number): Node<"f32">;
function log(x: Node<"f32"> | number): Node<"f32">;
function sqrt(x: Node<"f32"> | number): Node<"f32">;
function abs<T>(x: Node<T>): Node<T>;
function floor(x: Node<"f32">): Node<"f32">;
function ceil(x: Node<"f32">): Node<"f32">;
function frac(x: Node<"f32">): Node<"f32">;
function min<T>(a: Node<T>, b: Node<T> | number): Node<T>;
function max<T>(a: Node<T>, b: Node<T> | number): Node<T>;
function clamp<T>(x: Node<T>, lo: Node<T> | number, hi: Node<T> | number): Node<T>;

// Control flow
function select<T>(cond: Node<"bool">, whenTrue: Node<T>, whenFalse: Node<T>): Node<T>;

// Memory
function load<T>(ref: StateRef<T>): Node<T>;
function store<T>(ref: StateRef<T>, value: Node<T>): void;
function readBuffer<T>(buf: BufferRef<T>, index: Node<"i32">): Node<T>;
function writeBuffer<T>(buf: BufferRef<T>, index: Node<"i32">, value: Node<T>): void;
function readBufferInterpolated(buf: BufferRef<"f32">, pos: Node<"f32">): Node<"f32">;

// Type conversion
function f32(x: Node<any> | number): Node<"f32">;
function i32(x: Node<any> | number): Node<"i32">;
```

### 5.3 `@unworklet/client`

```typescript
function createNode<C extends ProcessorConfig>(
  context: BaseAudioContext,
  processor: CompiledProcessor<C>,
  options?: {
    initial?: Partial<ParamInitial<C>>;
    numberOfInputs?: number;
    numberOfOutputs?: number;
    outputChannelCount?: number[];
  },
): Promise<UnworkletNode<C>>;

interface UnworkletNode<C> {
  node: AudioWorkletNode; // Raw node for advanced connection
  params: TypedParamAccessors<C>;
  messages: TypedMessageSenders<C>;
  events: TypedEventEmitters<C>;
  dispose(): Promise<void>;
  onError(handler: (err: UnworkletError) => void): () => void;
}
```

### 5.4 `@unworklet/test`

```typescript
function renderOffline<C>(
  processor: CompiledProcessor<C>,
  config: {
    sampleRate: number;
    duration: number;
    params?: Partial<ParamInitial<C>>;
    paramAutomation?: ParamAutomation<C>;
    input?: (sampleIndex: number) => number[];
    messages?: Array<{ at: number; send: MessageName<C>; payload?: any }>;
  },
): Promise<{
  output: Float32Array[];
  events: Array<{ at: number; name: string; payload: any }>;
  peak: number;
  rms: number;
  hasNaN: boolean;
}>;
```

---

## 6. Usage Examples

### 6.1 Stereo Delay — Processor Definition

`src/processor.ts`:

```typescript
import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  buffer,
  message,
  event,
} from "@unworklet/core";
import {
  add,
  sub,
  mul,
  mod,
  abs,
  max,
  readBufferInterpolated,
  writeBuffer,
  select,
  eq,
} from "@unworklet/dsp";

export default defineProcessor({
  name: "StereoDelay",
  version: "1.0.0",

  inputs: { audio: audioInput({ channels: 2 }) },
  outputs: { audio: audioOutput({ channels: 2 }) },

  params: {
    delayTime: param({
      default: 0.25,
      min: 0.001,
      max: 2.0,
      unit: "seconds",
      automationRate: "a-rate",
    }),
    feedback: param({
      default: 0.4,
      min: 0,
      max: 0.95,
      automationRate: "a-rate",
    }),
    mix: param({
      default: 0.3,
      min: 0,
      max: 1,
      automationRate: "a-rate",
    }),
    bypass: param({
      default: 0,
      min: 0,
      max: 1,
      automationRate: "k-rate",
    }),
  },

  memory: { maxDelaySeconds: 2.0 },

  messages: {
    clear: message({}),
    setPreset: message({ preset: "u8" }),
  },

  events: {
    peakLevel: event({ left: "f32", right: "f32" }),
  },

  process: ({ inputs, outputs, params, ctx }) => {
    const size = Math.ceil(ctx.sampleRate * 2.0);
    const delayL = buffer.f32({ size, name: "delayL" });
    const delayR = buffer.f32({ size, name: "delayR" });
    const writeIdx = state.i32(0);
    const peakL = state.f32(0);
    const peakR = state.f32(0);

    return ({ sample, i }) => {
      sample.onMessage("clear", () => {
        delayL.fill(0);
        delayR.fill(0);
        writeIdx.store(0);
      });

      const inL = inputs.audio.left.at(i);
      const inR = inputs.audio.right.at(i);

      const delaySamples = mul(params.delayTime.at(i), ctx.sampleRate);
      const readPos = mod(sub(writeIdx.load(), delaySamples), size);

      const dlyL = readBufferInterpolated(delayL, readPos);
      const dlyR = readBufferInterpolated(delayR, readPos);

      writeBuffer(delayL, writeIdx.load(), add(inL, mul(dlyL, params.feedback.at(i))));
      writeBuffer(delayR, writeIdx.load(), add(inR, mul(dlyR, params.feedback.at(i))));

      const m = params.mix.at(i);
      const outL = add(mul(inL, sub(1, m)), mul(dlyL, m));
      const outR = add(mul(inR, sub(1, m)), mul(dlyR, m));

      const finalL = select(eq(params.bypass.at(i), 1), inL, outL);
      const finalR = select(eq(params.bypass.at(i), 1), inR, outR);

      outputs.audio.left.at(i, finalL);
      outputs.audio.right.at(i, finalR);

      writeIdx.store(mod(add(writeIdx.load(), 1), size));
      peakL.store(max(mul(peakL.load(), 0.9995), abs(finalL)));
      peakR.store(max(mul(peakR.load(), 0.9995), abs(finalR)));
    };
  },

  publish: ({ state, emit, every }) => {
    every(33, "ms", () => {
      emit.peakLevel({
        left: state.peakL.load(),
        right: state.peakR.load(),
      });
    });
  },
});
```

### 6.2 Main Thread — Connection and Control

`src/app.ts`:

```typescript
import { createNode } from "@unworklet/client";
import StereoDelay from "./processor";

const ctx = new AudioContext({ sampleRate: 48000 });
const delay = await createNode(ctx, StereoDelay, {
  initial: { delayTime: 0.375, feedback: 0.5, mix: 0.4 },
});

const source = ctx.createMediaElementSource(audioElement);
source.connect(delay.node).connect(ctx.destination);
```

### 6.3 Parameter Automation

```typescript
const t = ctx.currentTime;

delay.params.delayTime.setValueAtTime(0.1, t);
delay.params.delayTime.linearRampToValueAtTime(0.8, t + 2.0);

delay.params.feedback.exponentialRampToValueAtTime(0.9, t + 4.0);
delay.params.feedback.linearRampToValueAtTime(0.4, t + 6.0);
```

### 6.4 Modulating a Parameter with Another AudioNode

```typescript
const lfo = ctx.createOscillator();
lfo.frequency.value = 2;
const depth = ctx.createGain();
depth.gain.value = 0.002;

lfo.connect(depth).connect(delay.params.delayTime);
lfo.start();
```

### 6.5 Messaging

```typescript
delay.messages.clear();
delay.messages.setPreset({ preset: 3 });

// TypeScript errors on misuse:
// delay.messages.setPreset({ preset: 'abc' });  // Error
// delay.messages.unknownAction();                // Error
```

### 6.6 Event Subscription

```typescript
const unsubscribe = delay.events.peakLevel.on(({ left, right }) => {
  vuMeter.update(left, right);
});

// Later:
unsubscribe();
await delay.dispose();
```

### 6.7 Testing

`tests/processor.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { renderOffline } from "@unworklet/test";
import StereoDelay from "../src/processor";

describe("StereoDelay", () => {
  it("delays impulse by delayTime seconds", async () => {
    const { output } = await renderOffline(StereoDelay, {
      sampleRate: 48000,
      duration: 0.5,
      params: { mix: 1, feedback: 0, delayTime: 0.1 },
      input: (i) => (i === 0 ? [1, 1] : [0, 0]),
    });
    expect(output[0][4800]).toBeCloseTo(1, 2);
  });

  it("remains stable at max feedback", async () => {
    const { peak, hasNaN } = await renderOffline(StereoDelay, {
      sampleRate: 48000,
      duration: 5.0,
      params: { feedback: 0.95, mix: 0.5 },
      input: (i) => (i < 100 ? [1, 1] : [0, 0]),
    });
    expect(peak).toBeLessThan(2.0);
    expect(hasNaN).toBe(false);
  });

  it("responds to clear message", async () => {
    const { output } = await renderOffline(StereoDelay, {
      sampleRate: 48000,
      duration: 0.5,
      params: { feedback: 0.9, mix: 1.0, delayTime: 0.1 },
      input: (i) => (i < 100 ? [1, 1] : [0, 0]),
      messages: [{ at: 0.25, send: "clear" }],
    });
    const afterClear = Math.floor(48000 * 0.3);
    expect(Math.abs(output[0][afterClear])).toBeLessThan(0.01);
  });
});
```

### 6.8 Package Scripts

`package.json`:

```json
{
  "scripts": {
    "dev": "unworklet dev",
    "build": "unworklet build",
    "test": "vitest",
    "typecheck": "tsc --noEmit",
    "bench": "unworklet bench --duration 60s",
    "analyze": "unworklet analyze"
  }
}
```

---

## 7. Compilation Pipeline

### 7.1 Graph Construction Phase

The user's `process` function is invoked once at compile time with proxy objects. Each primitive call (`add`, `mul`, etc.) constructs an AST node. The result is a DAG of operations rooted at output assignments.

### 7.2 Static Analysis Phase

- **Allocation check**: Verify that the AST contains no expressions capable of heap allocation. This is enforced by construction (no primitives produce allocating code), but the analyzer validates the invariant.
- **Loop boundedness**: All loops have statically-known iteration counts.
- **Memory sizing**: Sum all `state` and `buffer` declarations. Emit as WASM linear memory initial size.
- **Type inference**: Resolve all `Node<T>` types; verify consistency.
- **Parameter reachability**: Warn on declared but unused parameters.
- **Cycle estimation**: Estimate instruction count per sample based on operation weights.

### 7.3 WASM Emission Phase

Uses `binaryen.js` (or a custom minimal emitter) to produce the WASM binary. Key properties:

- Single exported function `process(blockPtr, paramPtrs, messagePtr) -> void`
- Linear memory layout:
  - `[0, M)`: State variables
  - `[M, M+B)`: Declared buffers
  - `[M+B, M+B+I)`: I/O scratch (input/output/param arrays)
  - `[M+B+I, M+B+I+Q)`: Message/event queue areas
- No `memory.grow` calls emitted
- No imports other than math intrinsics (optional; can be inlined)

### 7.4 Worklet JavaScript Emission

Emit a JavaScript file containing:

```javascript
class GeneratedProcessor extends AudioWorkletProcessor {
  constructor(options) {
    /* queue wiring, WASM instantiation */
  }
  static get parameterDescriptors() {
    /* from user declaration */
  }
  process(inputs, outputs, parameters) {
    /* marshal + call WASM */
  }
}
registerProcessor("StereoDelay", GeneratedProcessor);
```

### 7.5 Client Code Emission

Emit TypeScript declarations and runtime helpers so that `createNode(ctx, StereoDelay)` returns a fully-typed object whose `.params`, `.messages`, and `.events` reflect the processor's schema.

---

## 8. Runtime Behavior

### 8.1 Startup Sequence

1. Main thread calls `createNode(ctx, processor)`.
2. Client loads WASM binary (cached after first load).
3. Client adds Worklet module via `ctx.audioWorklet.addModule(workletUrl)`.
4. Client constructs `AudioWorkletNode` with `processorOptions` containing the WASM binary and (when cross-origin isolation is available) SAB handles.
5. Worklet-side constructor:
   - Instantiates WASM module.
   - Initializes linear memory to zero.
   - Allocates message/event queues (SAB-backed or postMessage-backed).
   - Runs pre-warm loop (~1000 invocations of `process` with zero input).
   - Sets "ready" state and signals main thread.
6. Client awaits readiness before resolving the `createNode` promise.

### 8.2 Per-Block Execution

Inside the generated `process(inputs, outputs, parameters)`:

1. Drain message queue (Atomics-based ring buffer when SAB is available, otherwise a postMessage-fed internal queue).
2. For each message, invoke corresponding handler registered via `sample.onMessage`.
3. Write input channels to WASM linear memory.
4. Write parameter arrays (length 1 or 128 as provided) to linear memory.
5. Call exported `process` function.
6. Read output channels from linear memory.
7. Return `true` from `process()`.

### 8.3 Publish Execution

Publishes run on the worklet-local scheduler. They:

1. Read current state values from linear memory.
2. Evaluate `publish` body.
3. On `emit.*` calls, append to event queue.
4. Main thread drains the queue on its own schedule and dispatches to subscribers.

### 8.4 Message Semantics

- Messages are delivered **at block boundaries**, never mid-sample.
- Multiple messages in one block are processed in arrival order.
- Message payloads are fixed-size structures. Variable-length data must be delivered via SharedArrayBuffer reference (or via a pre-allocated transfer region when SAB is unavailable).
- Message queue has fixed capacity; overflow is reported via `onError`.

### 8.5 Event Semantics

- Events are non-blocking; the worklet never waits for delivery.
- Event queue has fixed capacity; overflow drops oldest events and reports via `onError`.
- Event delivery is best-effort; not suitable for critical state synchronization.

### 8.6 Error Handling

- WASM traps are caught by the worklet-side wrapper; processor outputs silence, emits error event, continues running.
- Unrecoverable errors destroy the node; `onError` fires on main thread.

---

## 9. Testing

### 9.1 Pure-JS Backend

The same AST emitted for WASM can be interpreted in pure JavaScript. This enables:

- Zero-build testing in Node.js.
- Step-through debugging with standard DevTools.
- Property-based testing with `fast-check` and similar libraries.
- Cross-validation: the WASM and JS backends must produce bit-identical output for the same input (modulo documented floating-point differences).

### 9.2 Bit-Exact Reference Testing

`renderOffline` guarantees identical output for identical inputs across runs. Regression tests compare against golden `.wav` files.

### 9.3 Property-Based Testing

```typescript
import fc from "fast-check";
import { renderOffline } from "@unworklet/test";

it("gain stays within expected bounds", () => {
  fc.assert(
    fc.property(
      fc.float({ min: -1, max: 1 }),
      fc.float({ min: 0, max: 2 }),
      async (signal, gain) => {
        const { peak } = await renderOffline(MyGain, {
          sampleRate: 48000,
          duration: 0.01,
          params: { gain },
          input: () => [signal],
        });
        expect(peak).toBeLessThanOrEqual(Math.abs(signal * gain) + 1e-6);
      },
    ),
  );
});
```

---

## 10. Benchmarking and Profiling

### 10.1 `unworklet bench`

Consumes a processor definition and outputs:

- Estimated instructions per block and per second (from static weights + runtime timing)
- Wall-clock timing: P50/P95/P99/P99.9/Max latency per block
- CPU budget usage at configurable sample rates and block sizes
- NaN/Inf/denormal occurrences
- Allocation tracking (zero expected post-warmup)

Measurement is performed via a headless environment (Node.js with a JS audio stub, or a browser automation harness). The bench does not require any non-standard runtime; deeper hardware counters can optionally be integrated where the executing environment exposes them (e.g., Node.js with `perf_hooks` or OS-level `perf` wrappers), but are not a prerequisite.

### 10.2 `unworklet analyze`

Static analysis without execution:

- Estimated instructions per sample
- Memory footprint
- Cycle count estimates
- Warnings on unbounded loops, unused parameters, potentially-expensive operations

### 10.3 Output Formats

- Human-readable terminal output
- JSON (for tooling)
- JUnit XML (for CI integration)

### 10.4 CI Integration

```yaml
- run: npm run build
- run: npm test
- run: npm run bench -- --baseline=main --fail-on-regression=5%
```

---

## 11. Design Decisions

### 11.1 Why Primitives, Not High-Level Nodes

Following TSL rather than Elementary. High-level DSL abstractions restrict expressive power and force library authors to predict every use case. Primitive-level expression lets users construct arbitrary DSP from first principles while the framework guarantees realtime safety.

High-level building blocks (filters, envelopes, oscillators) will be provided as separate, optional packages (`@unworklet/filters`, `@unworklet/oscillators`) that users can depend on or reimplement as needed.

### 11.2 Why WASM, Not Pure JS

Pure JS execution is supported for testing and debugging, but production performance demands WASM. V8's TurboFan output is close to WASM for hot numerical loops, but WASM offers:

- Deterministic codegen independent of V8 tiering state
- No risk of deoptimization
- Predictable memory layout
- Path to SIMD, threads, and future WASM features without rewriting user code

### 11.3 Why Separate `process` and `publish`

The audio thread cannot tolerate even microsecond-scale postMessage overhead. Decoupling notification from the sample-accurate path allows UI updates to happen at their natural rate without polluting the realtime path.

### 11.4 Why Fixed Memory

Dynamic allocation in the audio thread is prohibited. Declaring all memory at compile time enables:

- Static guarantees on memory usage
- Zero GC pressure
- Deterministic startup cost
- Plugin-host compatibility (DAWs want fixed memory)

Users needing "variable" sizing declare a maximum and manage usage via active-count patterns.

### 11.5 Why AudioParam for Parameters

Using standard `AudioParam` means:

- Full compatibility with Web Audio automation (`setValueAtTime`, ramps)
- Connection from other `AudioNode`s (LFO modulation) works naturally
- Existing Web Audio tooling/debugging applies

### 11.6 Why Typed Messaging

`postMessage` with untyped payloads is a source of runtime errors in Web Audio applications. Declaring schemas enables compile-time verification and auto-generated documentation.

### 11.7 Standards-Only Runtime

`unworklet` targets the W3C Web Audio API specification and nothing beyond it. All runtime behavior is defined in terms of spec-guaranteed primitives: `AudioWorkletProcessor`, `AudioWorkletGlobalScope`, `MessagePort`, `AudioParam`, and optionally `SharedArrayBuffer`/`Atomics` when cross-origin isolation is available. No part of the library requires a modified browser, a specific host application, or non-standard APIs. The library works in any spec-compliant Web Audio implementation.

---

## 12. Implementation Concerns

### 12.1 Proxy-Based Graph Capture

The `process` function is called at build time with proxy objects. Users may inadvertently write code that doesn't translate (e.g., JavaScript `if` on a `Node<bool>` instead of `select()`). The compiler must produce clear error messages for these cases. Consider:

- Lint rule / ESLint plugin detecting `if (someNode)` patterns
- Runtime errors during graph capture with helpful stack traces
- Optional strict mode that rejects any JavaScript control flow involving `Node` values

### 12.2 Source Maps

Generated WASM must carry source map information back to TypeScript source lines for meaningful error messages and profiler output. The TypeScript source → AST → WASM chain needs to preserve line/column data at each step.

### 12.3 WASM Binary Size

For each processor, the emitted WASM includes the core arithmetic ops. Small processors may pay disproportionate overhead. Mitigations:

- Tree-shake unused primitives
- Provide a shared "runtime" WASM module for processors in the same page
- Inline math functions vs. importing JS `Math.sin`

Decision: start with fully-inlined, self-contained WASM. Optimize later.

### 12.4 Math Function Precision

WASM lacks `sin`, `cos`, etc. as native instructions. Options:

- Import from JS (calls `Math.sin`)
- Inline polynomial approximations
- Use lookup tables

Users may have precision requirements incompatible with approximations. Provide multiple implementations; let user choose:

```typescript
import { sin } from "@unworklet/dsp"; // Default (approximation)
import { sin } from "@unworklet/dsp/precise"; // High precision, imported
import { sin } from "@unworklet/dsp/table"; // Table-based
```

### 12.5 SharedArrayBuffer Availability

SAB requires cross-origin isolation (`COOP`/`COEP` headers). Many deployment environments cannot satisfy this. The library must degrade gracefully:

- With SAB: full performance, lock-free queues, typed bulk transfers
- Without SAB: fall back to `postMessage` with structured clone, pre-allocated transfer regions to minimize per-call allocation, document the perf impact
- Detect at runtime; report the active mode via `onError`/diagnostic API
- **SAB-dependence must never be required for correctness**; it is a performance optimization only.

### 12.6 Pre-warm Correctness

Pre-warming by invoking `process` with zero input assumes:

- Code paths are exercised proportionally (not true for conditional branches)
- JIT tiering reaches TurboFan (requires enough iterations)

Mitigations:

- Emit pre-warm helpers that exercise both branches of every `select`
- Rely on WASM's own tiering (less V8-tiering-dependent than pure JS)
- Allow users to supply a "training input" pattern via processor config

### 12.7 GC Invocation Access

Explicit `gc()` invocation is unavailable in standard browser environments. The library must not depend on it. Instead:

- Rely on the invariant that `process()` performs zero allocations
- Use WASM for the hot path to minimize JIT-triggered allocations on the JS side of the worklet
- Document known allocation sources inside spec implementations (e.g., parameter array reallocation on automation rate change) and design around them

### 12.8 Message Queue Sizing

Fixed-size queues can overflow. Sizing policy:

- Default: 256 messages, 1024 events
- User-configurable via processor config
- Overflow emits structured error with queue name and recovery suggestion

### 12.9 Parameter Array Length

The Web Audio spec permits `parameters[name].length` to be 1 or `render quantum size`. Implementations may also return zero-length arrays if the parameter is unused. The generated code must handle all three cases; testing against multiple browsers is part of the validation matrix.

### 12.10 Worklet Scope Isolation

The AudioWorkletGlobalScope has its own global scope per spec, but implementations vary in whether this corresponds to a separate V8 Isolate or merely a separate Realm within a shared Isolate. The library does not rely on any specific isolation model:

- All claims of "no cross-thread interference" are scoped to what the spec guarantees.
- Performance characteristics may vary by implementation and are measured, not assumed.

### 12.11 AudioContext Sample Rate Handling

`AudioContext` sample rate is fixed per context but can differ across devices. Processors must handle this without recompilation:

- `ctx.sampleRate` is resolved as a runtime constant loaded at processor instantiation
- Expressions involving `ctx.sampleRate` used in buffer sizing are evaluated at instantiation and used to size linear memory accordingly
- For buffer sizes that depend on `ctx.sampleRate`, the declared `memory.maxDelaySeconds` (or equivalent) yields the worst-case size; actual memory is allocated to match the runtime sample rate up to that cap

### 12.12 Multi-Channel Generalization

Stereo processing is the common case, but users may need arbitrary channel configurations. Channel count handling:

- Declared in `audioInput`/`audioOutput`
- Generated code loops over channels when channel count is dynamic
- Compile-time specialization for common cases (mono, stereo)

### 12.13 Render Quantum Size

The current Web Audio spec fixes the render quantum at 128 samples, but this may change in future spec revisions and is already the subject of discussion. Generated code should parameterize over block size rather than hardcoding 128 unless the emitter has explicit confirmation that 128 is valid for the target environment.

### 12.14 Hot Reload Semantics

In development, rebuilding the processor should not require full application restart. Approach:

- Run old and new instances in parallel for a crossfade window
- Transfer state where types match; reset where schemas differ
- Document state-preservation guarantees

### 12.15 Denormal Handling

Denormal floats can cause order-of-magnitude slowdowns on some CPUs. The compiler should:

- Emit flush-to-zero patterns where possible within WASM constraints
- Add automatic DC bias injection for filters prone to denormals
- Warn in static analysis when filters without denormal protection are detected

WASM does not currently expose direct FTZ/DAZ control; mitigation is algorithmic rather than architectural.

### 12.16 Versioning and Compatibility

DSP processors may be distributed via npm and outlive the unworklet version they were built against. Policy:

- Processor bundles include compiled WASM (forward-compatible across browser versions as long as the WASM spec level is supported)
- Runtime client is pinned to the version that built the WASM
- Source-level compatibility across major versions is not guaranteed; recompilation required

### 12.17 Browser Compatibility Matrix

The library targets:

- Chrome/Edge (Chromium-based) — primary, Audio Worklet mature
- Firefox — Audio Worklet support present; parameter array edge cases must be validated
- Safari — Audio Worklet support present; historically lagged on AudioParam behaviors and SAB availability
- Other Chromium-based browsers — inherit Chrome behavior

Each release runs a compatibility test suite across the above in CI.

### 12.18 Bundler Integration

Users consume `unworklet` through standard JavaScript bundlers (Vite, Webpack, Rollup, esbuild, etc.). The library must:

- Export `.wasm` assets in a way bundlers can resolve and serve
- Emit Worklet module files referenceable via `new URL(..., import.meta.url)` or equivalent
- Provide framework-specific integration guides (Vite plugin, Webpack loader) where necessary

### 12.19 TypeScript Version Support

The library relies on advanced type features (conditional types, template literal types). Document the minimum supported TypeScript version and test against it in CI.

---

## 13. Open Questions

### 13.1 Variable-Rate Control Signals

Beyond a-rate (per-sample) and k-rate (per-block), some DSP algorithms use intermediate rates (e.g., every 16 samples). Should unworklet support this, or is oversampling k-rate to a-rate sufficient?

### 13.2 Multi-Block Lookahead

Some algorithms (lookahead limiters, FFT-based effects) require delays larger than one block with specific latency-compensation semantics. Should latency be declared explicitly?

### 13.3 Polymorphic Scalar Types

`Node<f32>` vs `Node<f64>`: most audio is f32, but some algorithms need f64. How is conversion expressed? Should numeric literals default to f32 or require explicit tagging?

### 13.4 User-Defined Macros

Should users be able to define reusable fragments? The simplest answer is "they're just TypeScript functions":

```typescript
const biquad = (input, a1, a2, b0, b1, b2) => {
  /* ... */
};
```

But this blurs the line between "framework primitives" and "user code." Clarify what's expressible and what's not.

### 13.5 Multi-Output Processors

Currently assumed single `outputs` mapping. Do we need explicit support for processors with multiple side-chain outputs, analysis outputs, etc.?

### 13.6 Cross-Processor Communication

Do two unworklet processors in the same graph need a faster path than `AudioNode.connect`? Likely no for v1, but worth noting.

### 13.7 Tempo/Transport Synchronization

Web Audio has no built-in transport concept. Applications that simulate one (sequencers, DAW-like tools) pass timing via parameters or messages. Should unworklet standardize a transport-metadata convention, or leave it to application layers?

### 13.8 AudioWorklet-Specific Quirks Across Browsers

Exact `parameters[name]` array semantics, the timing of `processorOptions` delivery, and module loading behavior differ subtly across browsers. How much of this does the library normalize vs. expose?

---

## 14. Roadmap

### v0.1 — Foundation

- Core primitive set (arithmetic, math, comparison, select)
- `state`, `buffer`, `param` declarations
- WASM compiler (binaryen.js based)
- Pure-JS backend
- Worklet JS codegen
- Client wrapper with typed params
- `renderOffline` for testing
- Vitest integration
- Basic CLI (`build`, `test`)

### v0.2 — Messaging and Events

- Typed `messages` and `events`
- SAB-backed queues with postMessage fallback
- `publish` phase
- Error handling and reporting

### v0.3 — Tooling

- `unworklet analyze` static analysis
- `unworklet bench` (browser-harness and Node.js stub backends)
- Source maps
- Dev server with hot reload

### v0.4 — Ecosystem

- `@unworklet/filters`, `@unworklet/oscillators`, `@unworklet/envelopes` reference packages
- Documentation site
- Examples gallery
- Migration guides from hand-written Audio Worklet processors

### v0.5 — Polish and Compatibility

- Full browser compatibility matrix
- Bundler integration packages (Vite, Webpack, Rollup plugins)
- Property-testing helpers
- Performance tuning

### v1.0 — Stabilization

- API freeze
- Compatibility guarantees
- Performance baseline across supported browsers
- Production adoption case studies

---

_End of specification draft._
