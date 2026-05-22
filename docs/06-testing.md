# 06 — Testing (`@unworklet/test`)

Vitest matchers for unworklet processors. Wraps `@unworklet/offline` (= `13-offline-render.md`) with audio-domain assertions so processors can be tested deterministically in Node, without a browser or audio thread.

## Status

skeleton (scope-level shape fixed per Q23 + Q24 + Q25; per-section detail filled incrementally)

## 1. Relationship to `@unworklet/offline`

`@unworklet/test` does **not** re-implement rendering. It depends on `@unworklet/offline`'s `renderOffline` (= `13-offline-render.md` §2) and adds matchers that assert on the returned PCM, events, and state. This split keeps offline rendering usable outside testing (= server-side render, batch processing, preset preview UI — see `13-offline-render.md` §1) while testing-specific concerns (matcher ergonomics, golden-file comparison, property-based patterns) stay in this package.

## 2. Matchers

Vitest `expect.extend(...)` registration。 Surface:

- **`expectAudioMatches(actual: RenderResult, expected: RenderResult | Float32Array[], opts?: { tolerance?: number })`** — channel ご と に sample 単 位 で 比 較。 `tolerance` の 単 位 は **sample abs diff** (= `Math.abs(actual[ch][i] - expected[ch][i]) <= tolerance` を 全 sample で 満 た す こ と)。 **default = `0`** (= bit-exact、 Q17 polynomial 共 通 実 装 の た め pure-JS / WASM 両 backend で 不 在 と し て 動 く)。 多 channel は `Float32Array[]` を channel ご と に 同 tolerance で 比 較、 channel 数 mismatch は 即 fail。
- **`expectNoNaN(result)`** — `result.outputs` に NaN / ±Infinity が 含 ま れ な い こ と を assert。
- **`expectPeakUnder(result, dbfs)`** — peak amplitude が dBFS threshold 未 満。
- **`expectRmsUnder(result, dbfs)`** — RMS が dBFS threshold 未 満。
- **`expectEventsEqual(result, expectedEvents)`** — emit さ れ た event 列 (= name + payload + atSample) と 比 較。
- **`expectStateMatches(result, expectedSnapshot)`** — end-of-render snapshot blob (= Q5 format) を 比 較。 `'persistent'` slot 限 定 (= transient slot は audio 出 力 経 由 で 観 測)。
- **`expectBitExactAcrossBackends(processor, config: RenderOfflineConfig, opts?: { tolerance?: number })`** — 内 部 で `renderOffline` を `backend: 'js'` と `backend: 'wasm'` で 2 回 呼 び、 audio output が `tolerance` 以 内 (default 0) で 一 致 す る こ と を assert。 acceptance B2 用。

## 3. Golden file / bit-exact reference patterns

<!-- - `renderOffline` determinism guarantee (= 13-offline-render.md §2) makes golden .wav comparison reliable.
     - Tolerance policy: bit-exact across both backends (= pure-JS と WASM 両 方
       が Q17 の 同 一 polynomial approximation を 共 有、 documented FP diff は
       不 在)。 `tolerance` は default 0 (= sample abs diff)、 alternative path で
       小 さ い 帯 を 許 容 す る 用 途 で の み 0 以 外。
     - Helper: `expectAudioMatchesGolden(result, './fixtures/expected.wav', { tolerance })`. -->

## 4. Property-based testing patterns

<!-- fast-check examples: bounded gain, stable feedback under random input, monotonicity invariants under parameter sweeps.
     The library does not bundle fast-check; the patterns are documented for users to wire up. -->

## 5. Vitest integration notes

<!-- Vite+ wraps Vitest; tests import from `vite-plus/test`, not `vitest`.
     See AGENTS.md for the Vite+ command surface. -->
