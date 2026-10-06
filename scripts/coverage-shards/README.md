# Lang coverage shard validation

Lang coverage is a long critical-path check. This validation prototype measures
whether two file shards can reproduce the complete unsharded result safely.
The existing `Branch coverage (lang)` matrix check remains the required,
unsharded V8 98% package gate. No required-check cutover is part of this change.
The candidate runs additional work and can increase total runner minutes.

Each candidate shard uses two workers, the unchanged package configuration and
60-second per-test budget. It defers only its partial branch threshold to zero.
After both shards and the unsharded reference succeed, a complete native merge
uses the package's unchanged 98% threshold. Percentages are never averaged.
The comparison checks test-file partitions and test-case multisets, complete
source inventories, branch structures, and per-alternative covered-bit unions.
The source and test inventories come from the exact checkout, not fixed counts.

Artifacts are sealed only after the runner exits successfully. The verifier
checks run and attempt, SHA and tree, dirty tracked inputs, config/lock/helper
hashes, exact runtime versions, absolute roots, shard identities, output hashes,
and completed test results. Untested zero-hit sources remain in the denominator.
Only two verified blobs enter native merge; final coverage and merged test
results must match both their union and the unsharded reference. Incompatible or
ambiguous branch structures fail closed rather than being reconciled by guess.

A partial rerun cannot reuse an earlier attempt's counterpart artifacts. Use
**Re-run all jobs**. Failed, cancelled or skipped producer jobs explicitly fail
the candidate merger through a job-level `always()` condition and status checks.
A cancelled workflow is never evidence of a passing gate.

Run the small contract checks with:

    vp exec node --test scripts/coverage-shards/*.test.mjs

The fixture checks actual installed Vite+ sharding, blob merge, report paths,
untested-source inclusion, native 98% failure, and same-source branch union.
Unit tests inject missing/corrupt/stale/incomplete evidence. These tests do not
prove hosted Actions cancellation behavior or full lang equivalence.

Before any cutover, CI must establish full same-SHA unsharded/sharded equivalence,
actual wall time and runner cost, fixed-seed file-order robustness, failure and
cancellation behavior, and the repository's required-check settings. Retain the
exact `Branch coverage (lang)` identity only after those checks pass. Browser,
type, packaging, soak, other coverage jobs and the default local full suite stay
in place. No dependency/provider upgrade is included.
