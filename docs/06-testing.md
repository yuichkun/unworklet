# 06 — Testing (`@unworklet/test`)

Vitest/Jest-friendly offline rendering. Lets every processor be tested without a browser, deterministically.

## Status

skeleton

## 1. `renderOffline`

<!-- renderOffline<C>(processor, config) → Promise<{
       output: Float32Array[],
       events: Array<{ at, name, payload }>,
       peak: number,
       rms: number,
       hasNaN: boolean,
     }>
     config: sampleRate, duration, params, paramAutomation, input(sampleOffset), messages[]. -->

## 2. Backend choice and cross-validation

<!-- Default: pure-JS interpreter (no WASM dependency at test time).
     Optional: WASM backend, cross-validated for bit-identity (modulo documented FP differences). -->

## 3. Property-based testing patterns

<!-- fast-check examples: bounded gain, stable feedback, monotonicity invariants.
     The library does not bundle fast-check; the patterns are documented for users to wire up. -->

## 4. Bit-exact reference / golden files

<!-- renderOffline determinism guarantee; golden .wav comparison; tolerance policy. -->

## 5. Vitest integration notes

<!-- Vite+ wraps Vitest; tests import from `vite-plus/test`, not `vitest`.
     See AGENTS.md for the Vite+ command surface. -->
