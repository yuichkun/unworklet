# Releasing unworklet

unworklet ships five public packages from this monorepo: `@unworklet/core`,
`@unworklet/lang`, `@unworklet/offline`, `@unworklet/test`, `@unworklet/unplugin`.
They are versioned together, and `scripts/release-versions.test.ts` fails the
suite if they ever disagree.

A release is a pull request. You listen to its Vercel preview, and merging it
publishes exactly what you listened to.

## Steps

1. **Open the release pull request** from a branch named `release/vX.Y.Z`, with
   plain numbers (no leading zeros, no prerelease versions):
   - Set `"version"` to `X.Y.Z` in the five `packages/*/package.json`.
   - Add a `## X.Y.Z — YYYY-MM-DD` section at the top of `CHANGELOG.md`, breaking
     changes first, each with the migration a consumer has to perform.
   - Title the pull request `vX.Y.Z — <headline>` and write the release notes as
     its description: a summary, an "Upgrading from …" paragraph when something
     breaks, and a link to `CHANGELOG.md` at the tag
     (`https://github.com/yuichkun/unworklet/blob/vX.Y.Z/CHANGELOG.md`). The title
     and description become the GitHub Release as written.
2. **Wait for CI to pass.**
3. **Listen** to the Vercel preview of the pull request's latest commit. Vercel
   links it on the pull request; open it while signed in to Vercel. Every pushed
   commit gets its own preview, and the latest one is what a merge publishes.
4. **Merge** when it sounds right, with the pull request up to date with `main`.
   If GitHub offers "Update branch", update it and listen to the resulting
   preview. If it does not sound right, push fixes to the branch and go back to
   step 2.

Merging runs the Release workflow (`.github/workflows/release.yml`) on the commit
the merge creates on `main`. `scripts/release-check.ts` checks that this commit
has exactly the files of the pull request's last commit, the one you listened
to, that the five versions match the branch name, and that no higher version is
already tagged. The workflow builds the release and runs the full 1800-second
soak on both transports concurrently, on this exact checkout. It verifies the
report against the release SHA and unchanged tracked source, and rejects failed,
interrupted, incomplete or short runs before any tag or publication. Reports
upload on success and failure; hard cancellation can prevent upload. The workflow
then confirms that npm lets it publish all five packages. Only when every check
passes does it:

- tags the commit `vX.Y.Z`;
- publishes the five packages to npm through trusted publishing;
- creates the GitHub Release;
- moves the `production` branch forward to the commit, which Vercel deploys to
  https://unworklet.vercel.app.

Merge release pull requests one at a time. Release runs never overlap, and GitHub
keeps a single waiting run: when a second release is merged while one is
waiting, the waiting run is canceled, and the release that runs includes its
changes. A version lower than the highest tag is never published, so rerunning a
superseded run moves nothing back.

If the workflow fails, rerun it. The tag, versions npm already has and the
GitHub Release are skipped when they exist. If publishing stops partway, npm's
`latest` mixes the packages already published with the rest at their last
release, so fix the cause and rerun straight away. If it stops because `main`
differs from what you listened to, nothing was tagged or published. Start the
release again from the current `main`, listen to that pull request's preview and
merge it:

```sh
git switch -C release/vX.Y.Z origin/main
git commit --allow-empty -m "release: vX.Y.Z"
git push --force origin release/vX.Y.Z
```

## Version numbers

Pre-1.0, **the minor is the breaking-change axis**, because that is what npm's
range semantics enforce: `^0.3.0` resolves `0.3.x` and refuses `0.4.0`.

- A change that breaks existing code is a **minor** release: a removed or
  narrowed public type or export, a peer-dependency requirement that moves, or a
  check that rejects code the last release accepts.
- Everything else, including added features, is a **patch** release.

## The soak

The soak keeps the real audio-thread runtime running in headless Chromium on
both transports (SharedArrayBuffer and postMessage), switching the tab
between hidden and visible, and requires every event and MIDI message to
arrive without loss, duplication, reordering or tearing. It runs in CI
through the Release and Soak workflows:

- the Release workflow runs 1800 seconds per transport concurrently after the
  listened-head identity check and build, before tagging, npm publication, GitHub
  Release creation or the production push. Its attempt-specific
  `release-soak-report-<run>-<attempt>` artifact is the evidence for the checked runtime/source. Package prepublish hooks rebuild
  the published tarballs;
- the Soak workflow runs 120 seconds per transport on pull requests that change
  runtime paths. If the cumulative PR diff changes `.github/workflows/release.yml`,
  `.github/workflows/soak.yml` or `scripts/release-soak/verify-release.mjs`, it instead
  runs 1800 seconds per transport concurrently and verifies the full report against
  the exact PR head SHA. This validates the release gate; ordinary runtime PRs
  retain the short early-warning run. Neither replaces release evidence;
- from the Actions tab (**Soak** → **Run workflow**), for 5–3600 seconds per transport
  (default 1800 seconds), when a change reworks the transport
  and deserves a long run.

Manual Soak runs upload `soak-report` artifacts for diagnosis. They do not replace
the Release workflow's mandatory run. No local long soak or manual result
transcription is required.

Firefox and Safari are not run anywhere. A release carries that gap knowingly,
and it is worth closing ahead of 1.0.

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
