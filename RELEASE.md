# Releasing unworklet

unworklet ships five public packages from this monorepo: `@unworklet/core`,
`@unworklet/lang`, `@unworklet/offline`, `@unworklet/test`, `@unworklet/unplugin`.
They are versioned together, and `scripts/release-versions.test.ts` fails the
suite if they ever disagree.

A release is one run of the **Release** workflow. It builds the five tarballs
once, lets a person listen to the demo built from exactly those tarballs, and
after approval publishes those same files and promotes that same demo
deployment. Nobody publishes from their own machine.

## What a person does

1. **Start.** In the repository's Actions tab, open **Release** and choose
   **Run workflow** on `main`.
2. **Listen.** When the run reaches **Publish the listened-to tarballs to npm**,
   it waits for the `release` environment's reviewer. The run page shows:
   - the candidate demo's URL (open it while signed in to Vercel; the header
     reads "release candidate" with the tarballs' fingerprint on hover),
   - how every demo example sounds compared with the current release, sample
     by sample, with the examples that changed listed first,
   - the public API difference,
   - the soak result, once it finishes (it takes about an hour and does not
     hold up the approval).

   Compare the examples that changed on the candidate and on
   <https://unworklet.vercel.app>, which always serves the latest release.
   Each example page can play the example compiled in the browser or at build
   time through the Vite plugin; CI has already checked that both produce the
   same WASM.

3. **Approve or reject.** Use **Review deployments** on the run page.
   - **Approve**: the rest of the run publishes and promotes.
   - **Reject**: nothing reaches npm, `main` or the production demo. Fix the
     problem on `main` and run the workflow again; the version stays the same
     unless new changesets change it.

A run waits for approval for at most 30 days. Starting a new run while one is
waiting queues it until the first one finishes.

## What the Release workflow does

| Job                                  | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prepare the release commit           | Refuses to start unless the `release` environment requires a reviewer. Derives the version and the CHANGELOG.md section from the pending changesets (`scripts/release/version.ts`) and refuses a version npm already has. Commits them to `release/vX.Y.Z` with the consumed changesets removed, and opens or updates the release pull request.                                                                                                                                                                                                                                                                         |
| Test the release commit              | The full Test workflow on that commit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Build and deploy the candidate       | Packs the five tarballs once with `vp pm pack`, which turns the `workspace:` and `catalog:` ranges into real ones, and records their integrity (`scripts/release/tarballs.ts`). Builds the demo outside the monorepo from those tarballs (`scripts/release/demo.ts`), checks both compile paths produce the same WASM, renders every example with the candidate and with the latest release from npm and reports the difference (`scripts/release/sound-diff.ts`), compares the public API (`scripts/release/api-surface.ts`), and deploys the demo to Vercel as a production deployment without the production domain. |
| Soak both transports                 | 30 minutes each on SharedArrayBuffer and postMessage, with real hidden/visible transitions. Its result is shown with the approval; it does not block publishing.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Publish the listened-to tarballs     | After approval: publishes the same tarballs with `vp pm publish <tarball> --provenance` through npm trusted publishing, in dependency order, waiting for npm's publish-time scan to finish on each layer before the next (`scripts/release/publish.ts`), then installs the release back from npm into an empty project.                                                                                                                                                                                                                                                                                                 |
| Promote the demo and tag the release | Promotes the same Vercel deployment to the production domain without a rebuild and checks production serves it. Tags the release commit, creates the GitHub Release with the notes, attaches the deployment URL as `demo-deployment.txt`, comments "Released in vX.Y.Z" on every issue a pull request in the release closed, and merges the release pull request once its checks pass.                                                                                                                                                                                                                                  |

Every job can be rerun after a failure. Publishing skips the packages npm already
has with the same integrity and stops if npm has a version with other contents;
promoting skips when production already serves the candidate; tagging, the
GitHub Release and the issue comments are created only when missing. Once a
version is on npm, a new run refuses to start until that version's release pull
request has merged, because until then `main` would release the same version
again; rerun the promote job that stopped.

## Versions and changesets

Pre-1.0, **the minor is the breaking-change axis**, because that is what npm's
range semantics enforce: `^0.3.0` resolves `0.3.x` and refuses `0.4.0`.

- A change that breaks existing code — a removed or narrowed public type or
  export, a peer-dependency requirement that moves, a check that starts failing
  builds it used to pass — is a **minor** changeset.
- Everything else, including new features, is a **patch** changeset, so it
  reaches everyone on `^0.x.0` automatically.
- A **major** changeset is refused until 1.0.

Every pull request that changes a package adds a changeset with
`vp exec changeset`; the Test workflow's Changeset job fails without one. A
change that does not ship (tests only, internal tooling) adds an empty one with
`vp exec changeset --empty`. The changeset's text is the CHANGELOG.md entry: its
first line is the headline the GitHub Release lists, and a breaking entry says
what a consumer has to change.

## Checks on every pull request

- **Test**: lint, format and types; the Vitest suites in Node and in Chromium on
  both transports; per-package branch coverage of at least 98%; the demo's
  end-to-end tests; publint and arethetypeswrong on every package; and the
  Changeset job.
- **Candidate check**: builds the candidate from the pull request the way a
  release would, checks both compile paths, compares how every demo example
  sounds against the base commit — commenting on the pull request when an
  example changes — and compares the public API. A removed export fails unless
  one of the pull request's changesets is minor.

Firefox and Safari are not run anywhere; a release carries that gap knowingly,
and it is worth closing before 1.0.

## Keeping the production demo on the latest release

The production demo changes only when the Release workflow promotes a candidate;
merges to `main` do not deploy it. Pull requests still get Vercel preview
deployments, which the header labels "development build".

The **Release watch** workflow checks once a day that the production demo's
`/release.json`, npm's `latest` tarballs and the latest GitHub Release name the
same version and bytes. While they disagree it keeps one issue open, adds to it
when the disagreement changes, and closes it when they agree again. The usual
causes:

- **The production demo has no `/release.json`**: it was not deployed by the
  Release workflow. The next release replaces it.
- **One of the three is behind the others**: a Release run stopped after
  publishing. Rerun its failed jobs.
- **After withdrawing a release**: rerun `scripts/release/rollback.ts` if it
  stopped partway, or the Rollback workflow if the demo did not follow.

A check that cannot reach one of the three fails the run without opening an
issue.

## Withdrawing a bad release

The usual answer is a fixed release through the Release workflow. When that
cannot wait:

```sh
vp exec node scripts/release/rollback.ts <version to restore> <version to withdraw> "<reason>"
```

It moves `latest` back to the restored version for every package, deprecates
the withdrawn version with the reason, marks the restored version as the latest
GitHub Release, and starts the **Rollback** workflow, which puts the restored
version's demo back on the production domain. npm only lets a person with 2FA
move `latest` or deprecate a version, which is why this runs on a maintainer's
machine. A published version number can never be reused, so the fix is
released as a new version.

The Rollback workflow restores the deployment recorded on the version's GitHub
Release. Versions released before the Release workflow have none; for those it
stops and leaves the production demo as it is.

## One-time setup

- **npm**: for each of the five packages, add a trusted publisher for
  repository `yuichkun/unworklet`, workflow `release.yml` and environment
  `release`, allowing `npm publish`; then set Publishing access to "Require
  two-factor authentication and disallow tokens".
- **GitHub environment** `release`: required reviewer set to the maintainer,
  with "Prevent self-review" left off and "Allow administrators to bypass
  configured protection rules" turned off, so that nothing is published
  without the review, and deployment branches limited to `main`.
- **GitHub App** installed on the repository with read and write access to
  contents, pull requests and workflows, and read access to checks and commit
  statuses. Workflows is needed when `main` has changed a workflow by the time
  the release branch is updated. Store its client ID as the repository variable
  `RELEASE_APP_CLIENT_ID` and its private key as the secret
  `RELEASE_APP_PRIVATE_KEY`. The release branch is pushed, and its pull request
  opened and merged, with the App's token, because what the workflow's own
  token pushes starts no checks.
- **Vercel**: a token for the `unworklet` project stored as the secret
  `VERCEL_TOKEN`.
- **`main` protection**: require the Test workflow's jobs and the Candidate
  check to pass before merging, without requiring branches to be up to date.
  If approving reviews are required too, add the App to the bypass list so the
  workflow can merge the release pull request.

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
Keep it honest at merge time rather than at release time, and re-run the
`guidance-dogfood` skill when a change touches the authoring surface.
