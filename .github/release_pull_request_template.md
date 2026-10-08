## Problem / motivation

<!-- Release summary and why this version is needed. This body becomes the GitHub
Release. Copy this template explicitly; ordinary PRs use pull_request_template.md. -->

## Changes

### Scope and CHANGELOG accounting

<!-- After all intended PRs merge and release files are committed, generate:
vp exec node scripts/release-inventory.ts generate vPREVIOUS FULL_CANDIDATE_SHA
Paste its entire generated region here (readable linked lists + collapsed JSON).
Keep the short release summary above; do not put the raw commit list ahead of it.
For EVERY decisions key in the collapsed JSON provide
ONE of:
{"changelog":"https://github.com/yuichkun/unworklet/blob/FULL_CANDIDATE_SHA/CHANGELOG.md#L12-L14","excerpt":"exact text of those lines"}
{"reason":"specific explanation of why this change needs no consumer release note"}
Do not delete commits or PRs, including test/CI-only work. Empty PR associations
are explicit direct commits and require their own decision. Multiple PRs can
point to the same entry. Do not commit this SHA-bearing inventory to the candidate.
Regenerate after any candidate change and review every carried-over decision.
After editing decisions, run:
vp exec node scripts/release-inventory.ts render /tmp/release-notes.md > /tmp/release-notes-rendered.md
The visible lists must match the JSON. Check the complete rendered body; its
60,000 UTF-8 byte budget fails explicitly on overflow and never truncates. -->

### Upgrading from the previous release

<!-- Breaking changes first, concrete consumer migrations, and version rationale. -->

## Validation

Candidate SHA:
Previous tag and resolved SHA:

| Check                                           | Candidate SHA / tested tree | Command or evidence link                                        | Actual result / gaps |
| ----------------------------------------------- | --------------------------- | --------------------------------------------------------------- | -------------------- |
| Lint, format, types                             |                             | `vp check`                                                      |                      |
| Existing tests and 98% per-package branch gates |                             |                                                                 |                      |
| Five-package build and packaging                |                             | `vp run build`                                                  |                      |
| Preview identity and maintainer listening       |                             | `/build-info.json` and preview URL                              |                      |
| CHANGELOG accounting                            |                             | Inventory workflow / local check                                |                      |
| Previous-version comparison                     |                             | Same inputs, environment and observed behavior on both versions |                      |

### Known issues and unverified behavior

<!-- Record failures honestly, including existing native restore assertions.
An issue being closed is not proof of a production fix. Do not retry a known
failure until green or weaken its assertion. Identify checks not run and why.
Firefox and Safari are outside current automated browser coverage. Record the
mandatory post-merge 1800-second both-transport soak as pending until its actual
report exists; PR/manual runs do not substitute for that release evidence. -->

### Human review

- [ ] Each PR and direct commit was reviewed for consumer impact, including migrations.
- [ ] CHANGELOG excerpts describe all relevant changes; omission reasons are justified.
- [ ] Previous-version comparisons, known issues and unverified scope are accurate.
- [ ] Evidence belongs to this candidate, or an explicitly verified identical tree.

<!-- Automated accounting detects missing decisions and stale references, not
semantic completeness or absence of regressions. Changed candidates need fresh
validation. Deployment success alone does not prove listening or correctness. -->

## Related issues

<!-- Links and unresolved issues; use Closes only for proven resolutions. -->
