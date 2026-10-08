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

## Release review and CHANGELOG accounting

Copy `.github/release_pull_request_template.md` for a release PR. It retains the
ordinary four headings and adds scope, migrations, candidate-specific validation,
previous-version comparison, known issues and unverified behavior.

After all intended changes have merged, prepare and commit the release files,
then fetch full history and tags. Resolve the previous published tag and the full
candidate SHA explicitly. Do not declare a final candidate while an intended PR
is still pending. Generate the inventory using authenticated GitHub CLI access:

```sh
vp exec node scripts/release-inventory.ts generate vPREVIOUS FULL_CANDIDATE_SHA > /tmp/release-inventory.md
```

Keep a short human summary at the beginning of the PR. Paste the entire generated
region into the release PR body under Changes: it includes base/candidate/compare
links, counts, linked PR titles and decisions, and a separate direct-commit list.
Complete machine metadata is inside a collapsed details section. Keep it
in the body, not a candidate file: committing a file containing its own commit
SHA would change that SHA. The inventory records the resolved base tag/SHA, full
candidate SHA, every commit in `base..candidate` (including side-branch commits),
and associated merged PRs whose merge commits are in that range. The previous
release must be the greatest plain-semver published stable release below the
candidate package version, using all pages of official GitHub release metadata.
Drafts and prereleases are excluded. Its release ID, publication timestamp, tag
and resolved SHA are pinned in the inventory. An arbitrary existing tag cannot
replace the published release. The candidate itself is excluded after publication,
so rechecks do not compare a release to itself. Missing metadata, a changed base,
or a base outside the candidate ancestry fails rather than selecting a fallback.
This policy targets this repository's single release line: a subsequently published
backport below the candidate can invalidate an older PR's inventory. Reassess its
range explicitly; maintenance-branch history is not automatically reconstructed.
PR associations
are fetched page by page with total-count and cursor checks. A shallow clone,
missing/moved tag, API failure, malformed response or incomplete page sequence
stops generation; nothing is silently dropped. A commit without an included PR
stays in the list and gets its own decision.

Complete every `decisions` entry with either a candidate-pinned CHANGELOG line
link and exact `excerpt`, or a specific `reason` why a consumer note is unnecessary.
Links must target content inside the first, dated release section. Multiple PRs
can share a CHANGELOG entry. Test/CI-only PRs remain in the inventory but can use
an omission reason instead of cluttering the consumer notes. Review all changes
within each PR; one entry is not proof that every behavior in that PR is described.

Edit the decisions in the collapsed JSON, then regenerate the readable region.
`render` preserves the opening summary and all text outside its marked region.
It is a local presentation update, not an API verification. `check` rejects
missing/changed visible rows or counts as well as stale machine metadata.
Titles, subjects, reasons and excerpts are escaped for Markdown/HTML; JSON is
compact and escapes characters that could break its code fence or HTML container.

```sh
vp exec node scripts/release-inventory.ts render /tmp/release-notes.md > /tmp/release-notes-rendered.md
```

The complete PR body, including human prose, must fit the conservative 60,000
UTF-8 byte budget. Generation, rendering and checking fail explicitly if it is
exceeded. Nothing is truncated. Shorten prose or reviewed explanations, never
remove commits/PRs to fit. UTF-8 bytes also bound the number of characters, with
additional headroom for GitHub's body limits. This budget does not promise that
arbitrarily large release ranges fit in a PR body.

Verify the complete rendered PR body:

```sh
LISTENED=FULL_CANDIDATE_SHA vp exec node scripts/release-inventory.ts check /tmp/release-notes-rendered.md
```

The Release inventory PR workflow checks on open, body edits and head changes.
Its separate API contract job also runs for ordinary PRs (excluding body edits),
using only the read-only workflow token and public repository metadata. It checks
the published range from `v0.4.1` (`fff85f19d2a24032a962479143ab3657fffb8e14`)
to `v0.5.0` (`0c4c889f4898197009cfc8879a1aedd1509246e2`) against an independent
`git rev-list`, including the known merge associations for PRs #107 and #130.
Only the verified public inventory JSON is uploaded; credentials, headers and
raw API responses are excluded. API failures fail the job. This tests the live
API contract, not CHANGELOG disposition semantics or a future release candidate.
The publishing workflow repeats the same check against the listened-to SHA before
building, soaking or publishing. Any new candidate requires regeneration and
review of its decisions and validation evidence; do not reuse stale results.
The existing candidate tree identity, build, 1800-second both-transport release
soak and 98% package branch gates remain required.

These checks prove structural accounting against Git and GitHub metadata, not
that a linked sentence correctly or exhaustively describes the change. Reviewers
must check meaning, migrations, omission reasons, the chosen previous release,
and candidate-specific evidence. Record actual previous-version comparisons,
known failures and untested scope. A closed issue is not proof of a production
fix. Do not weaken native restore assertions or retry known failures into green.
No inventory, test result or comparison guarantees absence of regressions.

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
`scripts/vercel-build.sh` invokes the demo build, whose Vite config rebuilds the
five workspace packages before loading the plugin and bundling the app. Core is
built before lang because the browser compiler embeds the worklet runtime.

The demo footer identifies a **workspace build**, not a claim about npm publication:
its lockstep package version, checked-out revision, and a fingerprint of the freshly
built package artifacts. Vercel previews explicitly say "Preview workspace"; local
modified checkouts say "dirty". The same verified metadata is available at
`/build-info.json`, including full revision, source and artifact SHA-256 hashes.
The build fails on mismatched versions or deployment revision, unexpected package
resolution, or source/artifact changes during bundling. Development mode displays
"version unavailable" because its live source and compiler dist can differ.

To check a preview, compare its footer revision with the PR head and the full
`revision` in `/build-info.json`, then exercise the examples. The footer and report
are emitted together from the build; neither queries GitHub or npm for a version.

Only the `production` branch is deployed to production, and only
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
