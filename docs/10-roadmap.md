# 10 — Roadmap

Milestone scoping for v1.0.0, with the smallest possible footprint of forward-looking commitments.

This doc is independent of the component docs and can be picked up at any time.

## Status

partial (§1 written at Q62; §3.1 mandatory deferred mitigations written; §2, §3.2 placeholder)

## 1. v1.0.0 acceptance criteria

「v1.0.0 ship 可 能」 を impl AI agent が 1 意 判 定 で き る checklist。 1 項 目 で も 落 ち た ら ship 不 可、 全 項 目 OK で ship。 Q62 (`decisions-log.md`)。

### A. Build / compile

- **A1** — 公 開 4 package + 内 部 module の `vp build` 通 過 (= exit 0)。
- **A2** — canonical Ex 1〜8 の WASM emit 通 過 (= 各 Ex の `defineProcessor` body の graph capture + WASM 生 成 成 功)。
- **A3** — `vp check` (= tsgo typecheck + oxlint + oxfmt) 通 過 (= exit 0)。

### B. Functional

- **B1** — canonical Ex 1〜8 の 期 待 output が `@unworklet/offline` で 再 現 (= reference audio / event sequence と bit-exact、 documented FP diff は 不 在)。
- **B2** — `@unworklet/offline` の pure JS interpreter と WASM backend が 同 一 入 力 で 同 一 出 力 (= bit-exact、 Q17 polynomial approximation を 両 backend 共 通 実 装 = documented FP diff は 不 在)。

### C. Safety

- **C1** — realtime-safety invariants 5 件 (= no heap alloc / no unbounded loops / no throw / no blocking I/O / no GC、 `00-foundations.md` §5.1) を `00-foundations.md` §5.2 規 定 通 り の layered enforcement (= L1 / L2 / L3 / Emission / Runtime guard) で 検 出。 各 invariant に 対 す る 違 反 test を 仕 込 ん で 各 enforcement layer が 規 定 通 り に 弾 く こ と を 確 認。

### D. Browser matrix

- **D1** — browser smoke pass、 matrix = `Chromium × Firefox × Safari` × `{COOP/COEP cross-origin isolated, not isolated}` = 6 セ ル 全 て で canonical Ex 1〜3 が 起 動 + 出 音。

  **smoke test 仕 様**: `connectFromWebMIDI` (= Web MIDI 標 準 wrapper) は test 対 象 外 (= emission boundary 外 側、 consumer 責 任、 `08-deployment.md` §2 B1)。 全 browser セ ル で `node.midi.<name>.send(event)` source-agnostic injection (= `11-midi.md` §3) 経 由 で MIDI 動 作 を 統 一 検 証。

### E. Integrity

- **E1** — `open-questions.md` が 空 (= 全 質 問 が `decisions-log.md` に 移 さ れ て こ の file の 質 問 リ ス ト が 0 件 に な っ た 状 態)。

### F. Public surface integrity

- **F1** — `.d.ts` 公 開 surface が `decisions-log.md` Q1〜Q68 全 entry (Q28 は unassigned numbering artifact で 対 象 外) と 整 合 (= 各 ratify が 公 開 surface に 反 映)。

## 2. Later milestones (sketch only)

<!-- Bullet list of v0.2 / v0.3 / v0.4 / v0.5 / v1.0 themes, no commitments.
     Stated only to scope what v1.0.0 deliberately leaves out. -->

## 3. Explicitly deferred

The following items are intentionally postponed past v1.0.0. Each has a forward-compatible API surface — consumer code does not change when the upgrade lands.

### 3.1 Mandatory mitigations (must ship in v1.x.0)

- **Double-buffered `buffer.publish` regions** — eliminates torn reads on multi-byte published regions and variable-length `event<T>` / `message<T>` payloads. v1.0.0 ships single-buffered (acknowledged limitation in `decisions-log.md` Q27-f and `02-messaging.md` §5.4). v1.x.0 introduces 2× region per published slot with atomic index switch from the audio thread; main-side readers consume the most-recent-completed region. **Mandatory, not optional** — the v1.0.0 surface explicitly promises this upgrade.

### 3.2 Additive surface extensions (no v1.0.0 promise; rolled out as demand surfaces)

<!-- Will be filled in as additional resolutions settle in decisions-log.md. Candidates include:
       - Variable-rate iteration (`forSampleRange(start, end, callback)`)
       - rAF-driven `state.publish` rate variants
       - SIMD f64x2 / i32x4 / shuffle / gather-scatter
       - Time-unit sub-rate primitives (`everyTimeMs`)
     -->
