# Releasing unworklet

unworklet ships five public packages from this monorepo:
`@unworklet/core`, `@unworklet/lang`, `@unworklet/offline`, `@unworklet/test`,
`@unworklet/vite-plugin`. They are versioned together.

## v1.0.0 acceptance criteria (`docs/10-roadmap.md` §1)

| ID  | Criterion                                                    | Status                                                                                                                     |
| --- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| A1  | 4 public packages + internal module `vp build` exit 0        | ✅ `vp pack` builds each package; `vp run build` builds core + vite-plugin (incl. devtools UI)                             |
| A2  | Canonical Ex 1–8 WASM emit                                   | ✅ covered by `packages/offline/src/canonical.test.ts` + golden cases                                                      |
| A3  | `vp check` (typecheck + oxlint + oxfmt) exit 0               | ✅ root `vp check` clean (0 errors, 0 warnings)                                                                            |
| B1  | Canonical Ex 1–8 offline output bit-exact vs reference       | ✅ offline golden / canonical tests pass                                                                                   |
| C1  | Realtime-safety invariants enforced (layered)                | ✅ `packages/core/src/dsl/enforcement.test.ts`                                                                             |
| D1  | Browser smoke: Chromium × Firefox × Safari × {isolated, not} | ⚠️ Chromium verified (devtools-proto + `examples/01-stereo-gain` Playwright); Firefox / Safari not yet run on this machine |
| E1  | `open-questions.md` empty                                    | ✅ all moved to `decisions-log.md`                                                                                         |
| F1  | `.d.ts` public surface matches `decisions-log.md` Q1–Q77     | ✅ public exports stable; verified against the READMEs / Skill                                                             |

The full unit + integration suite is green (~2000 tests across the six test
projects); `vp check` and `vp test run` both pass at the repo root.

## Cutting a release (manual)

Versions are currently `0.0.0` (unpublished). To cut a release:

1. Confirm the bar: `vp check` and `vp test run` clean in every package; the
   Chromium/Firefox/Safari smoke matrix (D1) green.
2. Bump versions across the public packages (e.g. `vp dlx bumpp` or set each
   `packages/*/package.json` `version`), keeping them in lockstep.
3. Tag: `git tag vX.Y.Z`.
4. Publish each public package (`prepublishOnly` runs `vp run build`):
   `@unworklet/core`, `@unworklet/lang`, `@unworklet/offline`,
   `@unworklet/test`, `@unworklet/vite-plugin`.

There is no automated changeset/changelog pipeline yet; the cut is manual.

## What ships

Each package publishes its `dist/` plus its `README.md` (npm always includes
the README). The root `llms.txt` and `.claude/skills/unworklet/` orient AI
agents working with the library from the repository / web.
