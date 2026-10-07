# Native lang coverage shards

Four independent runners execute native Vitest file shards, with two workers per
runner. `Branch coverage (lang)` starts independently and is normally cancellable.
It has no job dependency or `always()` condition: a cancelled workflow must not
leave a successful required check behind.

The owner uses its ephemeral GitHub token with job-scoped Actions read access to
wait for exactly four successful producer jobs from the same event, metadata
head, run and attempt. It pins observed job IDs, bounds API requests and polling,
and rejects failures, missing producers and redirects. No token is logged or sent
to another host. Producer jobs have an 80-minute limit, polling is bounded at 85
minutes, and the required owner at 90 minutes.

The metadata head of a pull request is distinct from its synthetic merge checkout.
Both identities matter: job polling checks the event head, while every artifact
records the actual checkout SHA/tree and event/run/attempt alongside the toolchain,
configuration and input inventories. Bundles remain in separate directories.
Missing, duplicate, stale, corrupt or unsuccessful reports fail closed.

Partial shards use a zero local branch threshold. They cannot satisfy the package
gate alone. The owner verifies the complete native-discovered file partition,
all passing test identities, the full source denominator and structural branch
union before merging native blob reports. The merge uses the unchanged package
V8 98% branch policy. Its test multiset and covered branch identities must match
the validated shard union. Uncovered files stay in the denominator; percentages
are never averaged. EOL and implicit-else locations preserve native identities.

Use a complete workflow rerun when retrying this gate. A failed-job-only rerun can
lack producers from the current attempt and is intentionally rejected; old
artifacts cannot silently satisfy a new attempt.

Local controls run with:

```sh
vp exec node --test scripts/lang-coverage/*.test.mjs
```

The installed-runner fixture exercises four native shards, a real native merge,
artifact sealing/identity checks, and an uncovered source that makes the full
98% gate fail. It is a small correctness fixture, not a benchmark of the lang
suite. Keep the normal local `vp test` aggregate unchanged.
