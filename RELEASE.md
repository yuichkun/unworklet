# Releasing unworklet

unworklet ships five public packages from this monorepo: `@unworklet/core`,
`@unworklet/lang`, `@unworklet/offline`, `@unworklet/test`, `@unworklet/unplugin`.
They are versioned together, and `scripts/release-versions.test.ts` fails the
suite if they ever disagree.

## The bar

- `vp check` clean at the repo root and `vp test run` green.
- The browser suites pass. `packages/core/src/__tests__/browser/` covers the real
  worklet thread on Chromium in CI, and `examples/demo` covers the plugin pipeline.
  **Firefox and Safari are not run anywhere yet** — a release carries that gap
  knowingly, and it is worth closing before 1.0.
- The agent guide matches reality. `skills/unworklet/` is what consumers' agents
  read; if the release changes behaviour, the guide changed with it. Re-run the
  `guidance-dogfood` skill when a release touches the authoring surface.

## Cutting a release (manual)

The published line starts at `v0.1.0` (2026-06-28). Pre-1.0, **the minor is the
breaking-change axis**, because that is what npm's range semantics enforce:
`^0.1.0` resolves `0.1.x` and refuses `0.2.0`. Anything a consumer on `^0.<minor>.0`
would receive automatically must therefore be non-breaking. A peer-dependency
requirement that moves, a public type that narrows, or a check that starts failing
builds it used to pass, all force the minor. To cut a release:

1. Confirm the bar above.
2. Decide the number against the previous tag, not against intent: read
   `git log v<prev>..HEAD` and diff the public surface (each package's
   `peerDependencies`, each `src/index.ts` export list, the client-facing types in
   `packages/core/src/types.ts`). Removals, narrowings, and peer moves are
   breaking. Record the outcome in `CHANGELOG.md` — breaking items first, each
   with the migration a consumer has to perform.
3. Bump the five `packages/*/package.json` versions in lockstep, then run
   `vp test run` so the guard confirms it. `vp dlx bumpp packages/*/package.json`
   does it; a bare `vp dlx bumpp` bumps only the private monorepo root and none of
   the publishable packages, so name the files explicitly.
4. Commit the bump and tag: `git tag vX.Y.Z`.
5. Publish from a clean `main` with **pnpm, recursively**: `vp pm publish -r`
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
6. Create the GitHub Release from the tag. The Releases page is the first place a
   consumer who does not read npm looks, and a release carrying breaking changes is
   where that matters most. Write a summary and link to `CHANGELOG.md` **at the
   tag** rather than pasting the section in: nothing propagates a CHANGELOG
   correction to a release body, and CHANGELOG entries do get corrected. Pin
   `--latest` rather than letting GitHub infer it, so the page cannot advertise an
   older version as current, and pass `--verify-tag` so a tag that was never pushed
   fails the command instead of being created for you against the default branch.

   ```sh
   gh release create vX.Y.Z --verify-tag --latest \
     --title "vX.Y.Z — <the headline>" --notes-file <notes.md>
   ```

There is no automated changeset pipeline. Choosing the number (step 2) and writing
`CHANGELOG.md` are the operator's judgement; the mechanical half — a version left
behind, which would ship an unsatisfiable peer range against the bumped siblings —
is what the guard catches.

## What ships

Each package publishes its `dist/` plus its `README.md` and `LICENSE` (npm always
includes those).

`skills/unworklet/` is not published to npm. It is installed straight from this
repository into whichever coding agents a consumer has:

```sh
npx skills add https://github.com/yuichkun/unworklet/tree/main/skills/unworklet
```

That means the guide a consumer installs is whatever sits on the default branch,
with no release step of its own — so a guide fix reaches people as soon as it
merges, and a guide that contradicts the published packages is visible immediately.
Keep it honest at merge time rather than at release time.
