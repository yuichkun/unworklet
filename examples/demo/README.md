# Playground

Run `vp dev` in this directory. `vp build` builds the workspace packages and the
production app from the same checkout; `vp preview` serves that output.

The editor offers DSL globals and local/member completion (Ctrl+Space), inferred
sugar types on hover, and call signatures while typing. A dedicated worker runs
TypeScript and the existing Volar virtual-code mappings against a bundled type
snapshot. No server or external type CDN is needed. Editing diagnostics never
evaluate the source or compile/swap an audio processor. Recompile (Cmd/Ctrl+Enter)
is still the explicit apply step.

Source diagnostics identify their phase, severity and code. Select a located
issue to reveal its original source range. Runtime failures and compiler failures
without a proven source range stay document-level. Results from an older model or
source version cannot place markers on current text. A worker failure leaves the
editor and Recompile available.

API reference and Sugar help can be opened from the editor bar. Search by name or
purpose, filter by category, and explicitly copy a complete processor example.
Closing help restores editor focus without replacing source or its undo history.
Signatures come from the same ambient/core types used by the worker; the examples
and sugar transformations are exercised by the test suite.

## Validation

- `vp check` at the repository root
- `vp test` at the repository root for package and integration gates
- `vp test run` here for demo/offline and editor unit tests
- `vp test run --config vite.browser.config.ts` here for real Chromium worker,
  Monaco, dialog and runtime-compile regressions
- `vp build` and verify the resulting preview's `build-info.json` commit before
  manual testing

The editor worker browser test records cold startup on the largest bundled source
and a warm hover round trip. Production worker transfer sizes appear in the Vite
build report. Treat a successful static check separately from a successful audio
compilation or a listening check.
