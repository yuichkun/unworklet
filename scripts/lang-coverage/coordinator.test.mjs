import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_WAIT_MS,
  SHARD_NAMES,
  readContext,
  validateRunMetadata,
  validateShardJobs,
  waitForShardJobs,
} from "./coordinator.mjs";

const env = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_API_URL: "https://api.github.com",
  GITHUB_REPOSITORY: "yuichkun/unworklet",
  GITHUB_RUN_ID: "37572358496",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_EVENT_NAME: "pull_request",
  EXPECTED_HEAD_SHA: "a".repeat(40),
  GITHUB_SHA: "b".repeat(40),
  GH_TOKEN: "ephemeral-test-token",
};
const context = () => readContext(env);
const run = (overrides = {}) => ({
  id: Number(env.GITHUB_RUN_ID),
  run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
  head_sha: env.EXPECTED_HEAD_SHA,
  event: env.GITHUB_EVENT_NAME,
  repository: { full_name: env.GITHUB_REPOSITORY },
  status: "in_progress",
  conclusion: null,
  ...overrides,
});
const job = (slot, overrides = {}) => ({
  id: 112633592660 + slot,
  name: `Lang coverage shard (${slot}/4)`,
  run_id: Number(env.GITHUB_RUN_ID),
  run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
  head_sha: env.EXPECTED_HEAD_SHA,
  status: "completed",
  conclusion: "success",
  ...overrides,
});
const allJobs = () => [1, 2, 3, 4].map((slot) => job(slot));
const response = (data, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  redirected: false,
  json: async () => data,
});

function harness(snapshots, overrides = {}) {
  let now = 0;
  let poll = -1;
  const requests = [];
  const sleeps = [];
  return {
    requests,
    sleeps,
    options: {
      fetch: async (url, options) => {
        requests.push({ url, options });
        const parsed = new URL(url);
        if (!parsed.pathname.endsWith("/jobs")) {
          poll++;
          return response(run());
        }
        const jobs = snapshots[Math.min(poll, snapshots.length - 1)];
        const page = Number(parsed.searchParams.get("page"));
        return response({
          total_count: jobs.length,
          jobs: jobs.slice((page - 1) * 100, page * 100),
        });
      },
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      maxWaitMs: 100,
      initialDelayMs: 5,
      maxDelayMs: 20,
      ...overrides,
    },
  };
}

void test("context pins GitHub endpoints and PR source head rather than checked-out merge SHA", () => {
  assert.equal(context().headSha, env.EXPECTED_HEAD_SHA);
  assert.equal(context().runId, env.GITHUB_RUN_ID);
  assert.equal(context().runAttempt, env.GITHUB_RUN_ATTEMPT);
  assert.equal(MAX_WAIT_MS, 85 * 60 * 1000);
  assert.deepEqual(
    SHARD_NAMES,
    [1, 2, 3, 4].map((slot) => `Lang coverage shard (${slot}/4)`),
  );
  assert.equal(readContext({ ...env, GITHUB_EVENT_NAME: "push" }).eventName, "push");
});

void test("manual workflow dispatch accepts its direct head and rejects another event or head", () => {
  const manual = readContext({
    ...env,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    EXPECTED_HEAD_SHA: env.GITHUB_SHA,
  });
  const metadata = run({ event: "workflow_dispatch", head_sha: env.GITHUB_SHA });
  assert.doesNotThrow(() => validateRunMetadata(metadata, manual));
  assert.equal(
    validateShardJobs(
      allJobs().map((value) => ({ ...value, head_sha: env.GITHUB_SHA })),
      manual,
    ).ready,
    true,
  );
  assert.throws(() => validateRunMetadata({ ...metadata, event: "push" }, manual), /event/);
  assert.throws(
    () => validateRunMetadata({ ...metadata, head_sha: env.EXPECTED_HEAD_SHA }, manual),
    /head/,
  );
  assert.throws(() => validateShardJobs(allJobs(), manual), /head/);
});

void test("untrusted endpoint, repository, ID, event, source head and token inputs fail closed", () => {
  for (const [key, values] of Object.entries({
    GITHUB_SERVER_URL: [undefined, "http://github.com", "https://github.com/", "https://evil.test"],
    GITHUB_API_URL: [undefined, "https://api.github.com/", "https://evil.test"],
    GITHUB_REPOSITORY: [undefined, "../unworklet", "user/..", "user/repo/extra", "user/repo?x=1"],
    GITHUB_RUN_ID: [undefined, "0", "-1", "01", "1/2", "9007199254740992"],
    GITHUB_RUN_ATTEMPT: [undefined, "0", "1?redirect=evil"],
    GITHUB_EVENT_NAME: [undefined, "pull_request_target", "workflow_run", "schedule"],
    EXPECTED_HEAD_SHA: [undefined, "", "a".repeat(39), "g".repeat(40)],
    GH_TOKEN: [undefined, "", "token\nheader"],
  })) {
    for (const value of values) {
      assert.throws(() => readContext({ ...env, [key]: value }), /Invalid|Missing/, key);
    }
  }
});

void test("run metadata rejects stale attempts, foreign repositories/events and terminal runs", () => {
  assert.doesNotThrow(() => validateRunMetadata(run(), context()));
  for (const changed of [
    { id: 1 },
    { run_attempt: 1 },
    { head_sha: env.GITHUB_SHA },
    { event: "push" },
    { repository: { full_name: "other/unworklet" } },
    { repository: null },
    { status: "completed", conclusion: "success" },
    { status: "completed", conclusion: "cancelled" },
    { status: "unexpected" },
    { conclusion: "failure" },
  ]) {
    assert.throws(() => validateRunMetadata(run(changed), context()));
  }
  assert.throws(() => validateRunMetadata(null, context()));
});

void test("only the exact four successful producer identities establish readiness", () => {
  const input = [job(9, { name: "Branch coverage (lang)" }), ...allJobs()];
  const result = validateShardJobs(input, context());
  assert.equal(result.ready, true);
  assert.deepEqual(
    result.observed,
    Object.fromEntries(allJobs().map(({ name, id }) => [name, id])),
  );
  assert.equal(validateShardJobs([], context()).ready, false);
  assert.equal(validateShardJobs(allJobs().slice(0, 3), context()).ready, false);
  assert.equal(
    validateShardJobs(
      [job(1, { status: "queued", conclusion: null }), ...allJobs().slice(1)],
      context(),
    ).ready,
    false,
  );
});

void test("duplicate names, duplicate IDs and extra shard-shaped jobs fail closed", () => {
  for (const jobs of [
    [...allJobs(), job(1, { id: 99 })],
    [job(1), job(2, { id: job(1).id }), ...allJobs().slice(2)],
    [...allJobs(), job(5)],
    [...allJobs(), job(5, { name: "Lang coverage shard (1/5)" })],
    [...allJobs(), job(5, { name: "Lang coverage shard (1/4) duplicate" })],
    [...allJobs(), { id: job(1).id, name: "Other job" }],
  ]) {
    assert.throws(() => validateShardJobs(jobs, context()), /Duplicate|Unexpected/);
  }
});

void test("jobs from a stale run, attempt or source cannot satisfy this coordinator", () => {
  for (const changed of [
    { run_id: 1 },
    { run_attempt: 1 },
    { head_sha: env.GITHUB_SHA },
    { id: 0 },
    { id: "112633592661" },
    { id: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => validateShardJobs([job(1, changed), ...allJobs().slice(1)], context()));
  }
});

void test("every non-success terminal producer and malformed state fails immediately", () => {
  for (const conclusion of [
    "failure",
    "cancelled",
    "skipped",
    "timed_out",
    "neutral",
    "action_required",
    "stale",
    null,
  ]) {
    assert.throws(
      () => validateShardJobs([job(1, { conclusion }), ...allJobs().slice(1)], context()),
      /success/,
    );
  }
  for (const changed of [
    { status: "in_progress", conclusion: "failure" },
    { status: "queued", conclusion: "success" },
    { status: "not-a-status", conclusion: null },
  ]) {
    assert.throws(() => validateShardJobs([job(1, changed)], context()), /state/);
  }
  for (const jobs of [null, {}, [null], [{ name: 5, id: 1 }]]) {
    assert.throws(() => validateShardJobs(jobs, context()), /inventory|metadata/);
  }
});

void test("observed job IDs are immutable across polls and validation does not mutate prior state", () => {
  const first = validateShardJobs([job(1)], context());
  const prior = structuredClone(first.observed);
  assert.throws(
    () => validateShardJobs([job(1, { id: 99 })], context(), first.observed),
    /ID changed/,
  );
  const second = validateShardJobs(allJobs(), context(), first.observed);
  assert.equal(second.ready, true);
  assert.deepEqual(first.observed, prior);
  assert.throws(
    () => validateShardJobs(allJobs().slice(1), context(), second.observed),
    /disappeared/,
  );
});

void test("polling waits for partial discovery and completion with capped exponential backoff", async () => {
  const pending = allJobs().map((value) => ({ ...value, status: "in_progress", conclusion: null }));
  const fixture = harness([[], [pending[0]], pending, pending, pending, allJobs()]);
  const result = await waitForShardJobs(context(), fixture.options);
  assert.equal(result.ready, true);
  assert.deepEqual(fixture.sleeps, [5, 10, 20, 20, 20]);
  for (const { url, options } of fixture.requests) {
    assert.equal(new URL(url).origin, "https://api.github.com");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${env.GH_TOKEN}`);
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(
    fixture.requests[1].url,
    `https://api.github.com/repos/yuichkun/unworklet/actions/runs/${env.GITHUB_RUN_ID}/attempts/2/jobs?per_page=100&page=1`,
  );
});

void test("more than 100 jobs are inspected, including producer failures and duplicates on later pages", async () => {
  const others = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    name: `Other ${index}`,
  }));
  const fixture = harness([[...others, ...allJobs()]]);
  assert.equal((await waitForShardJobs(context(), fixture.options)).ready, true);
  assert.ok(fixture.requests.some(({ url }) => url.endsWith("page=2")));
  for (const tail of [job(4, { conclusion: "failure" }), job(1, { id: 99_999 })]) {
    const bad = harness([[...allJobs(), ...others, tail]]);
    await assert.rejects(waitForShardJobs(context(), bad.options));
  }
});

void test("missing producers reach the bounded deadline without starting another request", async () => {
  const fixture = harness([allJobs().slice(0, 3)], { maxWaitMs: 24 });
  await assert.rejects(waitForShardJobs(context(), fixture.options), /Timed out/);
  assert.deepEqual(fixture.sleeps, [5, 10, 9]);
  assert.equal(fixture.requests.length, 6);
});

void test("identity changes and producer failures stop polling immediately", async () => {
  const fixture = harness([[job(1)], [job(1, { id: 99 })]]);
  await assert.rejects(waitForShardJobs(context(), fixture.options), /ID changed/);
  assert.equal(fixture.requests.length, 4);
  const failed = harness([[job(1, { conclusion: "cancelled" })]]);
  await assert.rejects(waitForShardJobs(context(), failed.options), /success/);
  assert.deepEqual(failed.sleeps, []);
});

void test("run identity is revalidated on every poll before successful producer acceptance", async () => {
  const fixture = harness([[], allJobs()]);
  const fetch = fixture.options.fetch;
  let runRequests = 0;
  fixture.options.fetch = async (url, options) => {
    if (!url.includes("/jobs?") && ++runRequests === 2) return response(run({ run_attempt: 3 }));
    return fetch(url, options);
  };
  await assert.rejects(waitForShardJobs(context(), fixture.options), /run\/attempt\/head/);
  assert.equal(runRequests, 2);
});

void test("HTTP failures, redirects and network errors are bounded and never echo token or response text", async () => {
  for (const status of [301, 401, 403, 404, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(
      waitForShardJobs(context(), {
        fetch: async () => {
          calls++;
          return response({ message: env.GH_TOKEN }, status);
        },
      }),
      (error) => error.message.includes(`HTTP ${status}`) && !error.message.includes(env.GH_TOKEN),
    );
    assert.equal(calls, 1);
  }
  for (const fetch of [
    async () => {
      throw new Error(env.GH_TOKEN);
    },
    async () => ({ ...response(run()), redirected: true }),
    async () => ({
      ...response(run()),
      json: async () => {
        throw new Error(env.GH_TOKEN);
      },
    }),
  ]) {
    await assert.rejects(
      waitForShardJobs(context(), { fetch }),
      (error) => /GitHub API/.test(error.message) && !error.message.includes(env.GH_TOKEN),
    );
  }
});

void test("a stalled API request and stalled body each time out and abort", async () => {
  for (const stallBody of [false, true]) {
    let signal;
    const fetch = async (_url, options) => {
      signal = options.signal;
      const stalled = new Promise(() => {});
      return stallBody ? { ...response(run()), json: () => stalled } : stalled;
    };
    await assert.rejects(waitForShardJobs(context(), { fetch, requestTimeoutMs: 5 }), /timed out/);
    assert.equal(signal.aborted, true);
  }
});

void test("late API success cannot exceed the overall coordinator deadline", async () => {
  let now = 0;
  const fixture = harness([allJobs()], { now: () => now, maxWaitMs: 10 });
  const fetch = fixture.options.fetch;
  fixture.options.fetch = async (url, options) => {
    const value = await fetch(url, options);
    if (url.includes("/jobs?")) now = 11;
    return value;
  };
  await assert.rejects(waitForShardJobs(context(), fixture.options), /Timed out/);
});

void test("malformed, incomplete, changing and excessive paginated inventories fail closed", async () => {
  const others = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    name: `Other ${index}`,
  }));
  const pages = [
    [null],
    [{ total_count: -1, jobs: [] }],
    [{ total_count: 4, jobs: null }],
    [{ total_count: 1001, jobs: others }],
    [{ total_count: 5, jobs: allJobs() }],
    [{ total_count: 4, jobs: [...allJobs(), job(5)] }],
    [
      { total_count: 101, jobs: others },
      { total_count: 102, jobs: [job(1)] },
    ],
    [
      { total_count: 101, jobs: others },
      { total_count: 101, jobs: [] },
    ],
    [
      { total_count: 101, jobs: others },
      { total_count: 101, jobs: [others[0]] },
    ],
  ];
  for (const inventory of pages) {
    let page = 0;
    await assert.rejects(
      waitForShardJobs(context(), {
        fetch: async (url) => response(url.includes("/jobs?") ? inventory[page++] : run()),
      }),
      /inventory|pagination|Duplicate/,
    );
  }
});

void test("callers cannot disable timing bounds", async () => {
  for (const options of [
    { maxWaitMs: MAX_WAIT_MS + 1 },
    { maxWaitMs: Infinity },
    { maxWaitMs: 0 },
    { requestTimeoutMs: 30_001 },
    { requestTimeoutMs: 0 },
    { initialDelayMs: 0 },
    { initialDelayMs: 100, maxDelayMs: 50 },
    { maxDelayMs: 60_001 },
  ]) {
    await assert.rejects(waitForShardJobs(context(), options), /Invalid.*bound/);
  }
});
