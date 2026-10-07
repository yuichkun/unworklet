# Test ownership guard

`vp test` at the repository root remains the complete local aggregate. CI runs
`vp test run --config vite.ci.config.ts`; the five package coverage jobs and the
DevTools coverage job execute the ordinary Node/happy-dom assertions. DevTools
also stays in the required Vitest job because its separate coverage check is not
required by branch protection.

The CI config retains core SAB, core postMessage, live-browser HMR, repository
invariants, the required DevTools UI witness and the root build barrier. The MIDI property project deliberately
runs once more without coverage: its fast-check inputs are unseeded, so the
coverage invocation and this invocation preserve two sampling opportunities.
This is not a promise of identical random vectors, scheduling, or incidental
race exposure between the former aggregate and standalone coverage executions.

## Commands

```sh
vp exec node --test scripts/test-portfolio/*.test.mjs
# Package dist outputs must already exist: browser configs import the plugin.
vp exec node scripts/test-portfolio/check.mjs
```

The first command is an independent Node test runner. Its fixture uses the
installed Vite+ collector with throwing suite and global-setup modules, proving
file discovery does not import test suites, run global setup, or launch browsers.
It also exercises live include/exclude changes and distinct browser instances.

The second command resolves the real local aggregate, CI aggregate, six coverage
configs and two demo configs with the same `globTestSpecifications` operation as
`vp test list --filesOnly`. It closes every context. It compares live discovered
files and execution settings, including the config identity, browser, pool,
environment and setup files. In particular, a postMessage wrapper is not folded
into its imported SAB body: its separate project must survive.

The required DevTools witness must have exactly the same collection, happy-dom
environment and execution settings as its coverage owner. Removing it fails even
if the optional coverage job still discovers all UI files. Its live file count
plus the one MIDI resample is the explicitly permitted repeated execution budget.
At the reviewed inventory, the local aggregate has 207 direct file executions and
the residual has 47: the reduction is 160, not 175. Coverage retains 176 files,
the demo retains 17, and the three native guard files run independently.

The checkout inventory includes tracked and non-ignored untracked `.test.*` and
`.spec.*` files. New matching tests enter their owner automatically; tests that
no actual collector owns fail. There is no frozen list of individual test paths.
The native guard directory has an explicit owner whose exact workflow command is
tested. Unknown native test directories fail until a real owner is wired up.

Workflow contracts retain the trigger set, complete package matrix, unconditional
owner jobs, lang's four workers, other packages' two workers, DevTools' one worker,
unfiltered residual/demo commands and guard ordering. The package config contract
pins the V8 provider, 98% branch-only gates and existing include/exclude policies.
An intentional change to these policies must update the contract and its proof.

Collection proves ownership of files and execution settings, not assertion
success or equivalent timing. Full CI still has to execute every owner. The
guard cannot prove that future edits preserve every assertion inside a file.

## Performance comparison

Compare the original Test workflow and candidate on the same product source,
lockfile, Vite+/Node versions and runner class. Record exact workflow/source SHAs,
run IDs, attempts, event/ref context and cache state. A push head and PR synthetic
merge are distinct baselines. Keep full local root execution as a separate
compatibility check; do not add it to every measured candidate run.

Run paired original/candidate workflows on hosted runners. Use at least three
successful pairs, alternating order. Retain failures, cancellations and memory
pressure as outcomes; do not report only the fastest successful result. If a
complete baseline does not finish, report that limitation rather than derive a
speedup from partial timings.

For each attempt report:

- Whole elapsed time: workflow creation to the latest required job completion,
  including queue delay. Also report first-job start to last-job completion to
  separate queued latency from execution critical path.
- Runner sum: sum of `completed_at - started_at` for **every** job attempt in that
  workflow, including builds, installation, artifact transfer, guards and any
  experimental jobs present in the baseline. This is not the sum of test timers.
- Per-job and per-test-step wall time; lang peak process RSS and cgroup memory
  peak/events; worker count; failures/retries; all owner file/case counts; skips;
  coverage source/branch identities and six package branch percentages.

Report original versus candidate medians and each raw pair. Attribute the removal
of duplicate aggregate work separately from lang worker tuning and removal of
experimental shard jobs. A diagnostic intermediate configuration can isolate
each contribution, but only full-workflow timings answer the end-to-end question.
The two acceptance axes are whole elapsed time and runner sum; reducing one does
not establish a reduction in the other. Keep every existing coverage denominator,
branch threshold, browser transport, demo, packaging, compatibility and soak lane.
