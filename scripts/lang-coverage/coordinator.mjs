import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const SHARD_NAMES = Object.freeze(
  [1, 2, 3, 4].map((slot) => `Lang coverage shard (${slot}/4)`),
);
export const MAX_WAIT_MS = 85 * 60 * 1000;
const API_URL = "https://api.github.com";
const PAGE_SIZE = 100;
const MAX_JOBS = 1000;
const ACTIVE_STATUSES = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

class CoordinatorError extends Error {}

function requireCondition(condition, message) {
  if (!condition) throw new CoordinatorError(message);
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function environmentId(value) {
  return typeof value === "string" && /^[1-9]\d*$/.test(value) && positiveId(Number(value));
}

export function readContext(env) {
  requireCondition(env.GITHUB_SERVER_URL === "https://github.com", "Invalid GITHUB_SERVER_URL");
  requireCondition(env.GITHUB_API_URL === API_URL, "Invalid GITHUB_API_URL");
  requireCondition(
    typeof env.GITHUB_REPOSITORY === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}$/.test(
        env.GITHUB_REPOSITORY,
      ),
    "Invalid GITHUB_REPOSITORY",
  );
  requireCondition(environmentId(env.GITHUB_RUN_ID), "Invalid GITHUB_RUN_ID");
  requireCondition(environmentId(env.GITHUB_RUN_ATTEMPT), "Invalid GITHUB_RUN_ATTEMPT");
  requireCondition(
    ["push", "pull_request", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME),
    "Invalid GITHUB_EVENT_NAME",
  );
  requireCondition(
    typeof env.EXPECTED_HEAD_SHA === "string" && /^[a-f0-9]{40}$/.test(env.EXPECTED_HEAD_SHA),
    "Invalid EXPECTED_HEAD_SHA",
  );
  requireCondition(
    typeof env.GH_TOKEN === "string" && env.GH_TOKEN.length > 0 && !/\s/.test(env.GH_TOKEN),
    "Missing or Invalid GH_TOKEN",
  );
  return Object.freeze({
    repository: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    eventName: env.GITHUB_EVENT_NAME,
    headSha: env.EXPECTED_HEAD_SHA,
    token: env.GH_TOKEN,
  });
}

export function validateRunMetadata(run, context) {
  requireCondition(
    run &&
      run.id === Number(context.runId) &&
      run.run_attempt === Number(context.runAttempt) &&
      run.head_sha === context.headSha,
    "Unexpected workflow run/attempt/head identity",
  );
  requireCondition(run.event === context.eventName, "Unexpected workflow event");
  requireCondition(
    run.repository?.full_name === context.repository,
    "Unexpected workflow repository",
  );
  requireCondition(
    ACTIVE_STATUSES.has(run.status) && run.conclusion === null,
    "Workflow run is no longer active or has an invalid state",
  );
}

export function validateShardJobs(jobs, context, observed = {}) {
  requireCondition(Array.isArray(jobs), "Invalid GitHub job inventory");
  const ids = new Set();
  const shards = new Map();
  const nextObserved = { ...observed };
  for (const job of jobs) {
    requireCondition(
      job && positiveId(job.id) && typeof job.name === "string",
      "Invalid GitHub job metadata",
    );
    requireCondition(!ids.has(job.id), "Duplicate job ID in GitHub inventory");
    ids.add(job.id);
    if (!job.name.startsWith("Lang coverage shard")) continue;
    requireCondition(SHARD_NAMES.includes(job.name), "Unexpected lang coverage shard name");
    requireCondition(!shards.has(job.name), "Duplicate lang coverage shard name");
    requireCondition(
      job.run_id === Number(context.runId) &&
        job.run_attempt === Number(context.runAttempt) &&
        job.head_sha === context.headSha,
      "Unexpected shard run/attempt/head identity",
    );
    requireCondition(
      observed[job.name] === undefined || observed[job.name] === job.id,
      "Shard job ID changed during the current attempt",
    );
    if (job.status === "completed") {
      requireCondition(job.conclusion === "success", `${job.name} completed without success`);
    } else {
      requireCondition(
        ACTIVE_STATUSES.has(job.status) && job.conclusion === null,
        "Invalid lang coverage shard state",
      );
    }
    nextObserved[job.name] = job.id;
    shards.set(job.name, job);
  }
  for (const name of Object.keys(observed)) {
    requireCondition(shards.has(name), "Previously observed shard disappeared from the inventory");
  }
  return {
    ready: SHARD_NAMES.every((name) => shards.get(name)?.status === "completed"),
    observed: nextObserved,
  };
}

async function requestJson(url, context, options, deadline) {
  const remaining = deadline - options.now();
  requireCondition(remaining > 0, "Timed out waiting for all four lang coverage shards");
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => {
          reject(new CoordinatorError("GitHub API request timed out"));
          controller.abort();
        },
        Math.min(options.requestTimeoutMs, remaining),
      );
    });
    const request = async () => {
      const response = await options.fetch(url, {
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${context.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      requireCondition(!response.redirected, "GitHub API returned an unexpected redirect");
      requireCondition(
        Number.isInteger(response.status) && response.status >= 100 && response.status <= 599,
        "GitHub API returned an invalid HTTP status",
      );
      requireCondition(
        response.ok && response.status === 200,
        `GitHub API request failed (HTTP ${response.status}); verify Actions read permission and API availability`,
      );
      return response.json();
    };
    const result = await Promise.race([request(), timeout]);
    requireCondition(
      options.now() < deadline,
      "Timed out waiting for all four lang coverage shards",
    );
    return result;
  } catch (error) {
    if (error instanceof CoordinatorError) throw error;
    throw new CoordinatorError("GitHub API request or JSON response failed; cannot verify shards");
  } finally {
    clearTimeout(timer);
  }
}

async function listAttemptJobs(base, context, options, deadline) {
  const jobs = [];
  let total;
  for (let page = 1; page <= MAX_JOBS / PAGE_SIZE; page++) {
    const data = await requestJson(
      `${base}/attempts/${context.runAttempt}/jobs?per_page=${PAGE_SIZE}&page=${page}`,
      context,
      options,
      deadline,
    );
    requireCondition(
      data &&
        Number.isSafeInteger(data.total_count) &&
        data.total_count >= 0 &&
        data.total_count <= MAX_JOBS &&
        Array.isArray(data.jobs),
      "Invalid or excessive GitHub job inventory (maximum 1000 jobs)",
    );
    total ??= data.total_count;
    requireCondition(data.total_count === total, "GitHub job inventory changed during pagination");
    requireCondition(
      data.jobs.length === Math.min(PAGE_SIZE, total - jobs.length),
      "Incomplete GitHub job inventory during pagination",
    );
    jobs.push(...data.jobs);
    if (jobs.length === total) return jobs;
  }
  throw new CoordinatorError("GitHub job inventory exceeded the pagination bound");
}

export async function waitForShardJobs(context, overrides = {}) {
  const options = {
    fetch: globalThis.fetch,
    now: () => performance.now(),
    sleep,
    maxWaitMs: MAX_WAIT_MS,
    requestTimeoutMs: 30_000,
    initialDelayMs: 5_000,
    maxDelayMs: 30_000,
    ...overrides,
  };
  for (const [value, maximum] of [
    [options.maxWaitMs, MAX_WAIT_MS],
    [options.requestTimeoutMs, 30_000],
    [options.initialDelayMs, options.maxDelayMs],
    [options.maxDelayMs, 60_000],
  ]) {
    requireCondition(
      Number.isSafeInteger(value) && value > 0 && value <= maximum,
      "Invalid coordinator timing bound",
    );
  }
  const base = `${API_URL}/repos/${context.repository}/actions/runs/${context.runId}`;
  const deadline = options.now() + options.maxWaitMs;
  let delay = options.initialDelayMs;
  let observed = {};
  while (options.now() < deadline) {
    validateRunMetadata(await requestJson(base, context, options, deadline), context);
    const jobs = await listAttemptJobs(base, context, options, deadline);
    const result = validateShardJobs(jobs, context, observed);
    if (result.ready) return result;
    observed = result.observed;
    await options.sleep(Math.min(delay, Math.max(0, deadline - options.now())));
    delay = Math.min(options.maxDelayMs, delay * 2);
  }
  throw new CoordinatorError("Timed out waiting for all four lang coverage shards");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await waitForShardJobs(readContext(process.env));
    console.log("All four lang coverage shard jobs succeeded for the current run and attempt.");
  } catch (error) {
    console.error(error instanceof CoordinatorError ? error.message : "Lang coordinator failed");
    process.exitCode = 1;
  }
}
