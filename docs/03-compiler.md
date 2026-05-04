# 03 — Compiler (`@unworklet/compiler`)

The build-time pipeline that turns a `defineProcessor` definition into the artifacts consumed by the worklet runtime, the main-thread client, and the test backend.

## Status

skeleton

## 1. Pipeline overview

<!-- processor.ts → AST (DAG of primitive calls) → static analysis → multi-target emission:
       - WASM binary (production)
       - pure-JS interpreter (testing)
       - worklet JS template
       - typed client TS .d.ts
       - metadata JSON. -->

## 2. Graph capture phase

<!-- The user's `process` is invoked at build time with proxy objects. Each primitive call
     constructs an AST node; the result is a DAG rooted at output assignments.
     Q19 (graph-capture error UX: how to detect and report JS control flow over Node values).
     Lands here. -->

## 3. Static analysis phase

<!-- - Allocation check (verify by-construction invariant)
     - Loop boundedness (all loops statically bounded)
     - Memory sizing (sum of state + buffer declarations)
     - Type inference and consistency check
     - Parameter reachability
     - Cycle / instruction-count estimation -->

## 4. WASM emission phase

<!-- binaryen.js (or custom emitter):
     - exported function `process(blockPtr, paramPtrs, messagePtr) -> void`
     - linear memory layout (state | buffers | I/O scratch | queue regions)
     - no memory.grow
     - math intrinsics inlined or imported per Q14 (resolution lives in 01-dsl.md §2). -->

## 5. Worklet JS codegen

<!-- AudioWorkletProcessor subclass + parameterDescriptors + queue wiring + registerProcessor. -->

## 6. Client TS codegen

<!-- Typed node wrapper with .params / .messages / .events; .d.ts emission for end-user consumption. -->

## 7. Source maps

<!-- Q22 — TS source → AST → WASM line/column propagation; sidecar vs embedded;
     consumed by error diagnostics and bench / analyze tooling. Lands here. -->

## 8. Pure-JS backend

<!-- Same AST interpreted in JS for the test backend (06-testing.md). Cross-validation rules
     (bit-identical output modulo documented FP differences). -->
