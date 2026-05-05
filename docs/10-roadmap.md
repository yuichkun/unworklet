# 10 — Roadmap

Milestone scoping for v1.0.0, with the smallest possible footprint of forward-looking commitments.

This doc is independent of the component docs and can be picked up at any time.

## Status

skeleton

## 1. v1.0.0 acceptance criteria

<!-- Q14 — concrete deliverables that gate "v1.0.0 ships":
       - which primitives, declarations, phases must work
       - which tests must pass (renderOffline parity, browser smoke)
       - what the demo / acceptance run looks like
     Lands here. The acceptance list double-acts as the v1.0.0 launch checklist. -->

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
