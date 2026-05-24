# 06 — Testing (`@unworklet/test`)

Vitest matchers for unworklet processors. Wraps `@unworklet/offline` (= `13-offline-render.md`) with audio-domain assertions so processors can be tested deterministically in Node, without a browser or audio thread.

## Status

skeleton (scope-level shape fixed per Q23 + Q24 + Q25; per-section detail filled incrementally)

## 1. Relationship to `@unworklet/offline`

`@unworklet/test` does **not** re-implement rendering. It depends on `@unworklet/offline`'s `renderOffline` (= `13-offline-render.md` §2) and adds matchers that assert on the returned PCM, events, and state. This split keeps offline rendering usable outside testing (= server-side render, batch processing, preset preview UI — see `13-offline-render.md` §1) while testing-specific concerns (matcher ergonomics, golden-file comparison, property-based patterns) stay in this package.

## 2. Matchers

Vitest `expect.extend(...)` registration。 Surface:

- **`expectAudioMatches(actual: RenderResult, expected: RenderResult | Float32Array[], opts?: { tolerance?: number })`** — channel ご と に sample 単 位 で 比 較。 `tolerance` の 単 位 は **sample abs diff** (= `Math.abs(actual[ch][i] - expected[ch][i]) <= tolerance` を 全 sample で 満 た す こ と)。 **default = `0`** (= bit-exact、 `renderOffline` は processor の WASM emit を そ の ま ま runtime で instantiate し て 走 ら せ る 設 計 の た め、 同 入 力 に 対 し 同 output が 自 然 に 成 立)。 多 channel は `Float32Array[]` を channel ご と に 同 tolerance で 比 較、 channel 数 mismatch は 即 fail。
- **`expectNoNaN(result)`** — `result.outputs` に NaN / ±Infinity が 含 ま れ な い こ と を assert。
- **`expectPeakUnder(result, dbfs)`** — peak amplitude が dBFS threshold 未 満。
- **`expectRmsUnder(result, dbfs)`** — RMS が dBFS threshold 未 満。
- **`expectEventsEqual(result, expectedEvents)`** — emit さ れ た event 列 (= name + payload + atSample) と 比 較。
- **`expectStateMatches(result, expectedSnapshot)`** — end-of-render snapshot blob (= Q5 format) を 比 較。 `'persistent'` slot 限 定 (= transient slot は audio 出 力 経 由 で 観 測)。

#### 役 割 分 担: audio 出 力 と state snapshot

`expectAudioMatches` と `expectStateMatches` は **役 割 が 直 交**:

- **`expectAudioMatches`** = render 全 体 の audio 出 力 = DSP 計 算 path 全 体 を sample 単 位 で 担 保。 transient slot (= filter coefficient、 phase accumulator 等 内 部 状 態) の bug も audio output に 現 れ る た め こ ち ら で 検 出。
- **`expectStateMatches`** = end-of-render snapshot blob (= `'persistent'` slot 限 定、 Q5 format) = migration / restore round-trip 経 路 を 担 保。 transient slot は blob に 載 ら な い 設 計 だ が、 audio 出 力 で 既 担 保 さ れ て いる た め 二 重 化 不 要。

つ ま り 「audio で DSP 全 体、 persistent で migration 経 路」 の 二 軸 構 成 で 全 bug を cover。 canonical Ex の offline 再 現 は audio 比 較 が 主、 state 比 較 は migration test 専 用。

## 3. Golden file / bit-exact reference patterns

<!-- - `renderOffline` determinism guarantee (= 13-offline-render.md §2) makes golden .wav comparison reliable.
     - Tolerance policy: `renderOffline` は processor の WASM emit を そ の ま ま
       WebAssembly runtime (Node.js / Bun / Deno 等) で instantiate し て 走 ら せ る
       た め、 同 入 力 に 対 し bit-exact な output が 自 然 に 成 立。 `tolerance` は
       default 0 (= sample abs diff)、 alternative path で 小 さ い 帯 を 許 容 す る
       用 途 で の み 0 以 外。
     - Helper: `expectAudioMatchesGolden(result, './fixtures/expected.wav', { tolerance })`. -->

## 4. Property-based testing patterns

<!-- fast-check examples: bounded gain, stable feedback under random input, monotonicity invariants under parameter sweeps.
     The library does not bundle fast-check; the patterns are documented for users to wire up. -->

## 5. Vitest integration notes

<!-- Vite+ wraps Vitest; tests import from `vite-plus/test`, not `vitest`.
     See AGENTS.md for the Vite+ command surface. -->
