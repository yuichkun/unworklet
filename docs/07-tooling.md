# 07 — Tooling (`@unworklet/cli`, `@unworklet/bench`)

CLI surface that wraps the compiler, test backend, benchmarking harness, and dev-server for the end-user developer experience.

## Status

skeleton

## 1. Commands

<!-- - `unworklet build`     — compile to .wasm + .js + .d.ts + meta.json
     - `unworklet test`      — proxy to Vitest with renderOffline pre-loaded
     - `unworklet bench`     — measure P50/P95/P99/Max latency, allocation, NaN/Inf
     - `unworklet analyze`   — static report (cycles, memory, warnings)
     - `unworklet dev`       — dev server with hot reload
     These commands are end-user developer-facing. They are NOT the same as `vp` (Vite+) commands;
     see AGENTS.md for the repository's own build commands. -->

## 2. Bench

<!-- - Measurement harness: Node.js with audio-API stub, or browser automation.
     - Output formats: human-readable / JSON / JUnit XML.
     - CI integration pattern (baseline + regression threshold). -->

## 3. Analyze

<!-- Static-only report:
     - estimated instructions / sample
     - memory footprint
     - cycle estimate
     - warnings (unbounded loops, unused params, expensive ops, denormal-prone filters). -->

## 4. Dev server

<!-- Hot reload semantics: parallel old/new instance with crossfade, state-type-match transfer rule.
     (Resolved details to be slotted in after Q on hot reload semantics, if reached.) -->
