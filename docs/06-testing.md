# 06 — Testing (`@unworklet/test`)

Vitest matchers for unworklet processors. Wraps `@unworklet/offline` (= `13-offline-render.md`) with audio-domain assertions so processors can be tested deterministically in Node, without a browser or audio thread.

## Status

skeleton (scope-level shape fixed per Q23 + Q24 + Q25; per-section detail filled incrementally)

## 1. Relationship to `@unworklet/offline`

`@unworklet/test` does **not** re-implement rendering. It depends on `@unworklet/offline`'s `renderOffline` (= `13-offline-render.md` §2) and adds matchers that assert on the returned PCM, events, and state. This split keeps offline rendering usable outside testing (= server-side render, batch processing, preset preview UI — see `13-offline-render.md` §1) while testing-specific concerns (matcher ergonomics, golden-file comparison, property-based patterns) stay in this package.

## 2. Matchers

<!-- Vitest `expect.extend(...)` registration. Surface:

     - expectAudioMatches(actual, expected, { tolerance })
         Bit-identical or within-tolerance comparison of Float32Array channels.
     - expectNoNaN(result)
         Asserts result.outputs contains no NaN / ±Infinity.
     - expectPeakUnder(result, dbfs)
         Asserts peak amplitude under a dBFS threshold.
     - expectRmsUnder(result, dbfs)
     - expectEventsEqual(result, expectedEvents)
         Compares emitted events (name + payload + atSample).
     - expectStateMatches(result, expectedSnapshot)
         Compares end-of-render snapshot blob (Q5 format). -->

## 3. Golden file / bit-exact reference patterns

<!-- - `renderOffline` determinism guarantee (= 13-offline-render.md §2) makes golden .wav comparison reliable.
     - Tolerance policy: bit-exact for pure-JS backend; documented FP tolerance bands for WASM backend cross-validation.
     - Helper: `expectAudioMatchesGolden(result, './fixtures/expected.wav', { tolerance })`. -->

## 4. Property-based testing patterns

<!-- fast-check examples: bounded gain, stable feedback under random input, monotonicity invariants under parameter sweeps.
     The library does not bundle fast-check; the patterns are documented for users to wire up. -->

## 5. Vitest integration notes

<!-- Vite+ wraps Vitest; tests import from `vite-plus/test`, not `vitest`.
     See AGENTS.md for the Vite+ command surface. -->
