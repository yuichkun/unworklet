# 08 — Deployment

How users ship unworklet processors in real applications: bundler integration, browser support, and degradation paths when the runtime environment is constrained.

## Status

skeleton

## 1. Bundler integration

<!-- Q21 — which bundlers ship a first-party plugin (Vite first?), generic ESM strategy
     for the rest. .wasm asset resolution, Worklet module URL via
     `new URL(..., import.meta.url)` or equivalent. Lands here. -->

## 2. Browser compatibility matrix

<!-- Q8 — how much of cross-browser variance unworklet normalizes vs surfaces:
     - parameters[name] length 0/1/128 normalization
     - processorOptions delivery timing
     - module loading order quirks
     Per-browser validation (Chromium / Firefox / Safari) in CI. -->

## 3. SharedArrayBuffer graceful degradation

<!-- - With SAB (cross-origin isolated): lock-free ring buffers, typed bulk transfers.
     - Without SAB: postMessage with structured clone, pre-allocated transfer regions.
     - Detection at runtime, mode reported via UnworkletNode.onError diagnostic.
     - SAB is a performance optimization only — never a correctness requirement. -->

## 4. WASM binary distribution

<!-- Compiled WASM ships with the processor bundle. Forward-compatible across browser
     versions as long as the WASM spec level is supported. The runtime client is
     pinned to the version that built the WASM. -->
