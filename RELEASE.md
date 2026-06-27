# Releasing unworklet

unworklet ships five public packages from this monorepo:
`@unworklet/core`, `@unworklet/lang`, `@unworklet/offline`, `@unworklet/test`,
`@unworklet/unplugin`. They are versioned together.

## v1.0.0 acceptance criteria (`docs/10-roadmap.md` §1)

| ID  | Criterion                                                    | Status                                                                                                                                  |
| --- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 5 public packages `vp build` exit 0                          | ✅ each package builds via its `build` script (core/offline/test = `vp pack`; lang/unplugin = `node scripts/build.mjs`, incl. devtools UI) |
| A2  | Canonical Ex 1–8 WASM emit                                   | ✅ covered by `packages/offline/src/canonical.test.ts` + golden cases                                                                   |
| A3  | `vp check` (typecheck + oxlint + oxfmt) exit 0               | ✅ root `vp check` clean (0 errors, 0 warnings)                                                                                         |
| B1  | Canonical Ex 1–8 offline output bit-exact vs reference       | ✅ offline golden / canonical tests pass                                                                                                |
| C1  | Realtime-safety invariants enforced (layered)                | ✅ `packages/core/src/dsl/enforcement.test.ts`                                                                                          |
| D1  | Browser smoke: Chromium × Firefox × Safari × {isolated, not} | ⚠️ Chromium verified (devtools-proto + `packages/core/src/__tests__/browser/` Playwright); Firefox / Safari not yet run on this machine |
| E1  | `open-questions.md` empty                                    | ✅ all moved to `decisions-log.md`                                                                                                      |
| F1  | `.d.ts` public surface matches `decisions-log.md` Q1–Q77     | ✅ public exports stable; verified against the READMEs / Skill                                                                          |

The full unit + integration suite is green (~2000 tests across the six test
projects); `vp check` and `vp test run` both pass at the repo root.

## Cutting a release (manual)

Versions are currently `0.0.0` (unpublished). To cut a release:

1. Confirm the bar: `vp check` and `vp test run` clean in every package; the
   Chromium/Firefox/Safari smoke matrix (D1) green.
2. Bump all five public packages' `version` in lockstep — edit each
   `packages/*/package.json` `version` (or `vp dlx bumpp packages/*/package.json`).
   A bare `vp dlx bumpp` bumps only the private monorepo root, **not** the
   publishable packages, so name the package files explicitly. Keep the five identical.
3. Commit the bump and tag: `git tag vX.Y.Z`.
4. Publish from a clean `main` with **pnpm, recursively**: `vp pm publish -r`
   (`pnpm -r publish`) — **never `npm publish`**. The `-r` is required: `pnpm publish`
   (singular) at the repo root targets the private monorepo root and publishes none
   of the five packages. pnpm publishes in dependency (topological) order and rewrites
   **every** `workspace:^` (offline / test / lang / unplugin → core; test → offline;
   unplugin → lang) and `catalog:` (core → binaryen; offline → wavefile; lang →
   @volar/language-core + @volar/typescript + typescript; unplugin → unplugin)
   protocol specifier into a real range; `npm publish` ships them literally and every
   consumer install breaks. `prepublishOnly` runs `vp run build` for each of
   `@unworklet/core`, `@unworklet/lang`, `@unworklet/offline`, `@unworklet/test`,
   `@unworklet/unplugin`. pnpm runs git checks by default (clean tree + a `main` /
   `master` publish-branch), so release from `main` with the bump committed, or pass
   `--no-git-checks`.

There is no automated changeset/changelog pipeline yet; the cut is manual, so the
lockstep version bump (step 2) is the operator's responsibility — a missed package
ships an unsatisfiable peer range against the bumped siblings.

## What ships

Each package publishes its `dist/` plus its `README.md` and `LICENSE` (npm always
includes those). The root `llms.txt` and `.claude/skills/unworklet/` orient AI
agents working with the library from the repository / web.
