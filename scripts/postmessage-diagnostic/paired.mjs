import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  closeSync,
  constants,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeFile } from "./decode.mjs";
import { instrumentTest, instrumentClient, instrumentWorklet, testPath } from "./instrument.mjs";

export const targets = [
  { name: "old", sha: "0c4c889f4898197009cfc8879a1aedd1509246e2" },
  { name: "main", sha: "febd2a1684d92fc4a9fb86e55e9b6a1af989ec9e" },
];
const files = [
  "instrument.mjs",
  "retention.mjs",
  "decode.mjs",
  "artifacts.mjs",
  "session.mjs",
  "vite.config.mts",
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const save = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

export function requireTrigger(env, event) {
  assert.equal(env.GITHUB_EVENT_NAME, "push");
  assert.equal(env.GITHUB_REF, "refs/heads/diag/paired-counter-148");
  assert.equal(env.GITHUB_RUN_ATTEMPT, "1");
  assert.equal(event.created, true);
}

export function requireBrowser(version, metadata, actual) {
  assert.equal(version, "1.60.0");
  for (const name of ["chromium", "chromium-headless-shell"]) {
    const browser = metadata.browsers.find((browser) => browser.name === name);
    assert.equal(browser?.revision, "1223");
    assert.equal(browser?.browserVersion, "148.0.7778.96");
  }
  assert.match(
    actual.trim(),
    /^(?:Chromium|Google Chrome for Testing|HeadlessChrome) 148\.0\.7778\.96$/,
  );
}

export function readBrowserMetadata(root) {
  const require = createRequire(path.join(root, "examples/demo/package.json"));
  const playwright = require("playwright/package.json");
  const core = createRequire(require.resolve("playwright/package.json")).resolve(
    "playwright-core/package.json",
  );
  return {
    version: playwright.version,
    metadata: json(path.join(path.dirname(core), "browsers.json")),
  };
}

export async function runPair({ prepare, execute, save }) {
  const result = {
    status: "incomplete",
    exitCode: 1,
    targets: Object.fromEntries(
      targets.map((target) => [target.name, { setup: "not-started", execution: "not-started" }]),
    ),
  };
  const prepared = {};
  let active;
  let phase = "setup";
  try {
    for (const target of targets) {
      active = target.name;
      result.targets[active] = { setup: "started", execution: "not-started" };
      prepared[active] = await prepare(target);
      result.targets[active].setup = "passed";
    }
    phase = "execution";
    const ids = new Set();
    for (const target of targets) {
      active = target.name;
      const execution = await execute(target, prepared[active]);
      Object.assign(result.targets[active], execution);
      if (!execution.complete || !execution.runId || ids.has(execution.runId)) return result;
      ids.add(execution.runId);
    }
    result.status = "complete";
    result.exitCode = targets.every((t) => result.targets[t.name].testState === "passed") ? 0 : 1;
  } catch (error) {
    result.targets[active][phase] = "failed";
    result.failure = { target: active, phase, name: String(error?.name ?? "Error").slice(0, 64) };
  } finally {
    save(result);
  }
  return result;
}

function command(cwd, executable, args, log, env = process.env) {
  const fd = openSync(log, "ax");
  try {
    const result = spawnSync(executable, args, { cwd, env, stdio: ["ignore", fd, fd] });
    return { exit: result.status, signal: result.signal, error: result.error?.code ?? null };
  } finally {
    closeSync(fd);
  }
}

export async function main(workspace, output) {
  requireTrigger(process.env, json(process.env.GITHUB_EVENT_PATH));
  assert.equal(process.version, "v24.21.0");
  assert.ok(path.isAbsolute(workspace) && path.isAbsolute(output));
  const publicRoot = path.join(output, "public");
  const privateRoot = path.join(output, "private");
  mkdirSync(publicRoot, { recursive: true });
  mkdirSync(privateRoot);
  const source = fileURLToPath(new URL(".", import.meta.url));
  const diagnosticHashes = Object.fromEntries(
    [...files, "paired.mjs"].map((file) => [file, hash(readFileSync(path.join(source, file)))]),
  );
  save(path.join(publicRoot, "pair-start.json"), {
    diagnosticCommit: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    imageOS: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    node: process.version,
    diagnosticHashes,
    targets,
    historicalFailure: {
      run: "37854889394",
      job: "113576587144",
      head: "8b7abf7f109a99b347ec7a0e53f8cb9d1f7f9faa",
    },
  });
  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: path.join(privateRoot, "browsers"),
    UWK_DIAG_RECORD: "1",
  };
  const checked = (cwd, executable, args, log) => {
    const status = command(cwd, executable, args, log, env);
    if (status.exit !== 0)
      throw Object.assign(new Error("Setup command failed"), { commandStatus: status });
    return readFileSync(log, "utf8").trim();
  };
  return runPair({
    prepare: async (target) => {
      const root = path.join(workspace, "subjects", target.name);
      const out = path.join(publicRoot, target.name);
      mkdirSync(out);
      save(path.join(out, "setup-start.json"), { sha: target.sha });
      const log = (name) => path.join(privateRoot, `${target.name}-${name}.log`);
      let stage = "identity";
      try {
        assert.equal(checked(root, "git", ["rev-parse", "HEAD"], log("head")), target.sha);
        assert.equal(
          checked(root, "git", ["status", "--porcelain", "--untracked-files=no"], log("clean")),
          "",
        );
        const fixture = "packages/core/src/__tests__/browser/fixtures/message-counter.processor.ts";
        const scenarioHash = hash(readFileSync(path.join(root, "packages/core", testPath)));
        const fixtureHash = hash(readFileSync(path.join(root, fixture)));
        const lockHash = hash(readFileSync(path.join(root, "pnpm-lock.yaml")));
        save(path.join(out, "source.json"), {
          sha: target.sha,
          scenarioHash,
          fixtureHash,
          lockHash,
        });
        const destination = path.join(root, "scripts/postmessage-diagnostic");
        mkdirSync(destination, { recursive: true });
        for (const file of files)
          copyFileSync(
            path.join(source, file),
            path.join(destination, file),
            constants.COPYFILE_EXCL,
          );
        stage = "install";
        checked(root, "vp", ["install", "--frozen-lockfile"], log("install"));
        assert.equal(hash(readFileSync(path.join(root, "pnpm-lock.yaml"))), lockHash);
        const toolchain = checked(root, "vp", ["--version"], log("toolchain"));
        save(path.join(out, "toolchain.json"), { toolchain });
        assert.match(toolchain, /^vp v0\.1\.24\b/);
        assert.match(toolchain, /vite-plus\s+v0\.1\.24\b/);
        stage = "build";
        for (const pkg of ["unplugin", "core", "lang", "offline", "test"])
          checked(
            root,
            "vp",
            ["run", "--filter", `@unworklet/${pkg}`, "build"],
            log(`build-${pkg}`),
          );
        stage = "browser";
        checked(
          path.join(root, "examples/demo"),
          "vp",
          ["exec", "playwright", "install", "--with-deps", "chromium"],
          log("browser-install"),
        );
        const { version, metadata } = readBrowserMetadata(root);
        const browser = path.join(
          env.PLAYWRIGHT_BROWSERS_PATH,
          "chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell",
        );
        const browserVersion = checked(root, browser, ["--version"], log("browser-version"));
        save(path.join(out, "browser.json"), {
          playwright: version,
          browserVersion,
          browserHash: hash(readFileSync(browser)),
          definitions: metadata.browsers.filter((item) =>
            ["chromium", "chromium-headless-shell"].includes(item.name),
          ),
        });
        requireBrowser(version, metadata, browserVersion);
        const identity = {
          sha: target.sha,
          scenarioHash,
          fixtureHash,
          lockHash,
          toolchain,
          playwright: version,
          browserVersion,
          browserHash: hash(readFileSync(browser)),
        };
        save(path.join(out, "identity.json"), identity);
        save(path.join(out, "setup.json"), { status: "passed" });
        return { root, out, browser, identity };
      } catch (error) {
        save(path.join(out, "setup.json"), {
          status: "failed",
          stage,
          name: String(error?.name ?? "Error").slice(0, 64),
          commandStatus: error.commandStatus ?? null,
        });
        throw error;
      }
    },
    execute: async (target, prepared) => {
      const { root, out, browser, identity } = prepared;
      const other = json(
        path.join(publicRoot, target.name === "old" ? "main" : "old", "identity.json"),
      );
      for (const key of [
        "scenarioHash",
        "fixtureHash",
        "browserHash",
        "browserVersion",
        "playwright",
        "toolchain",
      ])
        assert.equal(identity[key], other[key], `Paired ${key} mismatch`);
      const trace = path.join(out, "trace.json");
      save(path.join(out, "execution-start.json"), { sha: target.sha, invocations: 1 });
      const status = command(
        root,
        "vp",
        ["test", "run", "--config", "scripts/postmessage-diagnostic/vite.config.mts"],
        path.join(out, "test.log"),
        { ...env, UWK_DIAG_OUTPUT: trace, UWK_DIAG_CHROMIUM: browser },
      );
      const decoded = decodeFile(trace);
      save(path.join(out, "decoded.json"), decoded);
      let complete = false;
      let runner = null;
      let manifest = null;
      let identityError = null;
      try {
        runner = json(trace + ".runner.json");
        manifest = json(trace + ".manifest.json");
        assert.equal(decoded.status, "complete");
        assert.equal(manifest.commit, target.sha);
        assert.equal(manifest.runId, runner.runId);
        assert.equal(manifest.recording, true);
        assert.equal(runner.traceStatus, "complete");
        assert.deepEqual(runner.collection, { modules: 1, tests: 8, target: 1, results: 1 });
        assert.equal(runner.secondaryExportFailure, null);
        assert.deepEqual(runner.errors, []);
        assert.ok(["passed", "failed"].includes(runner.caseResult?.state));
        const failures = json(trace).failures;
        assert.equal(failures.capture, null);
        assert.equal(failures.dispose, null);
        if (runner.caseResult.state === "passed") assert.equal(failures.primary, null);
        else assert.equal(failures.primary?.name, "AssertionError");
        assert.equal(status.exit, runner.caseResult.state === "passed" ? 0 : 1);
        assert.equal(status.signal, null);
        assert.equal(status.error, null);
        for (const file of files) assert.equal(manifest.hashes[file], diagnosticHashes[file]);
        for (const [role, transform] of [
          ["test", instrumentTest],
          ["client", instrumentClient],
          ["worklet", instrumentWorklet],
        ]) {
          const record = manifest.transforms[role];
          const input = readFileSync(path.join(root, "packages/core", record.sourcePath), "utf8");
          assert.equal(hash(input), record.sourceHash);
          const output =
            role === "test"
              ? transform(input, manifest.runId)
              : transform(input, true, manifest.runId);
          assert.equal(hash(output), record.transformedHash);
        }
        complete = true;
      } catch (error) {
        identityError = String(error?.name ?? "Error").slice(0, 64);
      }
      const result = {
        execution: "finished",
        ...status,
        collection: runner?.collection ?? null,
        testState: runner?.caseResult?.state ?? "unknown",
        traceStatus: decoded.status,
        complete,
        runId: manifest?.runId ?? null,
        identityError,
      };
      save(path.join(out, "execution.json"), result);
      return result;
    },
    save: (result) => save(path.join(publicRoot, "pair.json"), result),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2], process.argv[3])
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      console.error(`Paired diagnostic stopped: ${error.name}`);
      process.exitCode = 1;
    });
}
