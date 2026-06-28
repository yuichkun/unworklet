# WI-9 — v1.0.0 acceptance (A1–F1) status, with evidence

Honest status of the `docs/10-roadmap.md` §1 ship checklist, each item paired with
the command/test that proves it. ✓ = verified green; ◐ = partial (rest needs
the maintainer's hardware). Run from the repo root.

| item   | what                                                    | status | evidence                                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1** | 4 packages + internal modules `vp build` exit 0         | ✓      | CI "Build packages" step (`vp run --filter @unworklet/{unplugin,core,lang,offline,test} build`) — green on the PR                                                                                                                      |
| **A2** | canonical Ex WASM emit                                  | ✓      | `vp test run packages/offline/src/canonical.test.ts` (7 tests) + `vp test run packages/offline/src/docs-examples.test.ts` (every documented `defineProcessor` compiles to WASM)                                                        |
| **A3** | `vp check` exit 0                                       | ✓      | `vp check` — manifest FINAL gate green                                                                                                                                                                                                 |
| **B1** | canonical Ex offline bit-exact                          | ✓      | `vp test run packages/offline/src/canonical.test.ts` (reference audio / event sequence)                                                                                                                                                |
| **C1** | realtime-safety 5 invariants, layered enforcement       | ✓      | `vp test run packages/core/src/dsl/enforcement.test.ts` (10 tests) + the `reject` suites in `declarations.test.ts` / `worklet.test.ts` (no-heap-alloc / scope-violation / bounded-loop / etc.)                                         |
| **D1** | browser matrix Chromium × FF × Safari × {isolated, not} | ◐      | **Chromium ✓** — CI "Vitest (browser SAB + postMessage)" + "Playwright e2e" green; **Firefox / Safari pending** — needs the maintainer's hardware (no webkit/gecko runner in CI; `packages/core/vite.browser*.config.ts` are Chromium) |
| **E1** | `open-questions.md` empty                               | ✓      | `docs/open-questions.md` carries 0 open Q entries (all moved to decisions-log)                                                                                                                                                         |
| **F1** | `.d.ts` public surface ⟺ decisions Q1–Q77               | ✓      | type surface exported (`09-repo-structure.md` §2.1); the event-family unification is reflected (Q87/Q88, `types.ts`). `vp check` typechecks the surface.                                                                               |

## Summary

All CI-checkable items (A1–A3, B1, C1, E1, F1) are green. The single remaining gap
is **D1's Firefox + Safari cells**, which are deliberately out of CI (they need
real browsers on the maintainer's machine) — Chromium is fully covered. v1.0.0 is
release-ready modulo that manual cross-browser pass.
