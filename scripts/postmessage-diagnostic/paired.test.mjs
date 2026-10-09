import assert from "node:assert/strict";
import { test } from "node:test";
import { runPair, requireTrigger, requireBrowser, readBrowserMetadata } from "./paired.mjs";
import { fileURLToPath } from "node:url";

await test("only the first push creating the exact diagnostic branch is accepted", () => {
  const env = {
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/diag/paired-counter-148",
    GITHUB_RUN_ATTEMPT: "1",
  };
  requireTrigger(env, { created: true });
  for (const changed of [
    { GITHUB_RUN_ATTEMPT: "2" },
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF: "refs/heads/main" },
  ])
    assert.throws(() => requireTrigger({ ...env, ...changed }, { created: true }));
  assert.throws(() => requireTrigger(env, { created: false }));
});

await test("browser metadata and executed binary must both match pinned Chromium", () => {
  const browsers = {
    browsers: ["chromium", "chromium-headless-shell"].map((name) => ({
      name,
      revision: "1223",
      browserVersion: "148.0.7778.96",
    })),
  };
  requireBrowser("1.60.0", browsers, "Chromium 148.0.7778.96");
  assert.throws(() => requireBrowser("1.61.0", browsers, "Chromium 148.0.7778.96"));
  assert.throws(() => requireBrowser("1.60.0", browsers, "Chromium 151.0.0.0"));
  assert.throws(() => requireBrowser("1.60.0", { browsers: [] }, "Chromium 148.0.7778.96"));
});

await test("installed Playwright browser definitions resolve through its exported package entry", () => {
  const info = readBrowserMetadata(fileURLToPath(new URL("../../", import.meta.url)));
  requireBrowser(info.version, info.metadata, "Chromium 148.0.7778.96");
});

for (const first of ["passed", "failed", "incomplete", "setup-failed"]) {
  await test(`paired orchestration: ${first}; no retries`, async () => {
    const calls = [];
    const saves = [];
    const result = await runPair({
      prepare: async (target) => {
        calls.push(`prepare:${target.name}`);
        if (first === "setup-failed") throw new Error("setup");
        return {};
      },
      execute: async (target) => {
        calls.push(`execute:${target.name}`);
        return {
          runId: target.name,
          complete: first !== "incomplete",
          testState: target.name === "old" ? first : "passed",
        };
      },
      save: (result) => saves.push(structuredClone(result)),
    });
    assert.equal(saves.length, 1);
    assert.deepEqual(
      calls,
      first === "setup-failed"
        ? ["prepare:old"]
        : [
            "prepare:old",
            "prepare:main",
            "execute:old",
            ...(first === "incomplete" ? [] : ["execute:main"]),
          ],
    );
    assert.equal(result.exitCode, first === "passed" ? 0 : 1);
    if (first === "failed") assert.equal(result.targets.main.testState, "passed");
  });
}

await test("duplicate run identity stops comparison despite passing tests", async () => {
  const result = await runPair({
    prepare: async () => ({}),
    execute: async () => ({ runId: "same", complete: true, testState: "passed" }),
    save() {},
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.status, "incomplete");
});
