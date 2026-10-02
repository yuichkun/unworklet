# Releasing unworklet

unworklet ships five public packages from this monorepo: `@unworklet/core`,
`@unworklet/lang`, `@unworklet/offline`, `@unworklet/test`, `@unworklet/unplugin`.
They are versioned together, and `scripts/release-versions.test.ts` fails the
suite if they ever disagree.

A release is a pull request. You listen to its Vercel preview, and merging it
publishes exactly the commit you listened to.

## Steps

1. **Open the release pull request** from a branch named `release/vX.Y.Z`, with
   numbers only (no prerelease versions):
   - Set `"version"` to `X.Y.Z` in the five `packages/*/package.json`.
   - Add a `## X.Y.Z — YYYY-MM-DD` section at the top of `CHANGELOG.md`, breaking
     changes first, each with the migration a consumer has to perform.
   - Title the pull request `vX.Y.Z — <headline>` and write the release notes as
     its description: a summary, an "Upgrading from …" paragraph when something
     breaks, and a link to `CHANGELOG.md` at the tag
     (`https://github.com/yuichkun/unworklet/blob/vX.Y.Z/CHANGELOG.md`). The title
     and description become the GitHub Release as written.
2. **Wait for CI to pass**, and run the soak if the release needs it (below).
3. **Listen** to the Vercel preview of the pull request's latest commit. Vercel
   links it on the pull request; open it while signed in to Vercel. If a commit
   is pushed after you listened, listen to its preview again.
4. **Merge** when it sounds right, with the pull request up to date with `main`.
   If GitHub offers "Update branch", update it and listen to the new preview
   first. If it does not sound right, push fixes to the branch and go back to
   step 2.

Merging runs the Release workflow (`.github/workflows/release.yml`) on the commit
the merge creates on `main`. It checks that this commit has exactly the files of
the pull request's last commit, the one you listened to, that the five versions
match the branch name, and that no newer version is already tagged. Then it:

- tags the commit `vX.Y.Z`;
- publishes the five packages to npm through trusted publishing;
- creates the GitHub Release;
- moves the `production` branch forward to the commit, which Vercel deploys to
  https://unworklet.vercel.app.

Merge release pull requests one at a time. Release runs never overlap; if a newer
release is merged while an older one is still waiting, GitHub cancels the older
run, and the newer release, which includes its changes, is the one published. A
version older than the newest tag is never published, so a rerun of an old run
moves nothing back.

If the workflow fails, rerun it. The tag, versions npm already has and the
GitHub Release are skipped when they exist. If it stops because `main` differs
from what you listened to, nothing was published: push an empty commit to
`release/vX.Y.Z` from the current `main`, open a new pull request, listen to its
preview and merge it.

## Version numbers

Pre-1.0, **the minor is the breaking-change axis**, because that is what npm's
range semantics enforce: `^0.3.0` resolves `0.3.x` and refuses `0.4.0`.

- A change that breaks existing code is a **minor** release: a removed or
  narrowed public type or export, a peer-dependency requirement that moves, or a
  check that starts failing builds it used to pass.
- Everything else, including new features, is a **patch** release.

## The soak

Run the soak when the release changes the core runtime, that is, when this
prints anything (`vPREV` is the previous release's tag):

```sh
git diff --name-only vPREV..HEAD -- packages/core/src ':!**/*.test.ts' ':!**/__tests__/**'
```

```sh
vp exec node scripts/release-soak/run.mjs
```

It plays 30 minutes on each transport (SharedArrayBuffer and postMessage) with
real hidden and visible transitions, about an hour in total, and needs no
attention while it runs. Put its result in the pull request. A shorter run is
not a substitute.

Firefox and Safari are not run anywhere. A release carries that gap knowingly,
and it is worth closing before 1.0.

## The production demo

Vercel builds every pushed commit as a preview from that commit's own source:
`scripts/vercel-build.sh` builds the five packages, and the demo uses them from
the workspace. Only the `production` branch is deployed to production, and only
the Release workflow moves it, so the production demo always runs the latest
release. Merging to `main` does not change it.

## Always release through the workflow

Publish only through the Release workflow. A version published from a machine
has no provenance, and installs that refuse a drop in provenance (pnpm's
`trustPolicy: no-downgrade`) reject it. A published version can never be
replaced, so a bad release is fixed by the next release.

## One-time setup

- **npm:** for each of the five packages, add a trusted publisher for the
  repository `yuichkun/unworklet` and the workflow `release.yml`, allowing
  `npm publish`.
- **The `production` branch**, at the current release:
  `git push origin 'v0.3.0^{commit}:refs/heads/production'`
- **Vercel:** set the project's Production Branch to `production`.

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
