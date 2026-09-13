import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "../../packages/core/node_modules/playwright/index.mjs";
import { startServer } from "./server.mjs";
import { validateReceipt } from "./integrity.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "vp exec node scripts/release-soak/run.mjs [--seconds 1800] [--out /absolute/report-directory] [--headed]",
  );
  process.exit(0);
}
let seconds = 1800;
let headed = false;
let output = join(
  tmpdir(),
  `unworklet-release-soak-${new Date().toISOString().replaceAll(":", "-")}`,
);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--seconds") seconds = Number(args[++i]);
  else if (args[i] === "--out") output = resolve(args[++i]);
  else if (args[i] === "--headed") headed = true;
  else throw new Error(`Unknown argument: ${args[i]}`);
}
if (!Number.isFinite(seconds) || seconds < 5 || seconds > 86400) {
  throw new Error("--seconds must be between 5 and 86400");
}
await mkdir(output, { recursive: true });
const cacheRoot = await mkdtemp(join(tmpdir(), "unworklet-soak-cache-"));
const repository = fileURLToPath(new URL("../../", import.meta.url));
const metadata = {
  startedAt: new Date().toISOString(),
  requestedSecondsPerTransport: seconds,
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim(),
  workingTree: execFileSync("git", ["status", "--short"], {
    cwd: repository,
    encoding: "utf8",
  }).trim(),
  browserMode: `${headed ? "headed" : "headless"} Chromium; audio muted; native tab visibility`,
  browserConnection:
    "CDP noDefaults; dedicated temporary profile; browser default focus and timer behavior",
  cadenceSamples: 8192,
  ringCapacity: 1024,
  midiSendIntervalMs: 250,
  publications: "Latest-value progress; skipped publications are permitted.",
  streams:
    "Normal rate; zero overflow and no missing, duplicate, reversed, or torn events required.",
};
const servers = [];
const runs = [];
let browser;
let browserProcess;
let browserClosed = Promise.resolve();
let interrupted = false;
const interrupt = () => {
  interrupted = true;
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

async function save(name, value) {
  await writeFile(join(output, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

async function launchBrowser() {
  const profile = await mkdtemp(join(cacheRoot, "chromium-profile-"));
  browserProcess = spawn(
    chromium.executablePath(),
    [
      ...(headed ? [] : ["--headless=new"]),
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--enable-automation",
      "--disable-extensions",
      "--password-store=basic",
      "--use-mock-keychain",
      "--no-service-autorun",
      "--mute-audio",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  browserClosed = new Promise((resolve) => browserProcess.once("close", () => resolve()));
  let launchError;
  let diagnostic = "";
  browserProcess.once("error", (error) => {
    launchError = error;
  });
  browserProcess.stderr.on("data", (chunk) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-8192);
  });
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) {
    if (launchError) throw launchError;
    if (browserProcess.exitCode !== null || browserProcess.signalCode !== null) {
      throw new Error(`Dedicated Chromium exited during startup: ${diagnostic}`);
    }
    try {
      const [port, target] = (await readFile(join(profile, "DevToolsActivePort"), "utf8"))
        .trim()
        .split("\n");
      const wsUrl = `ws://127.0.0.1:${port}${target}`;
      return await chromium.connectOverCDP(wsUrl, { noDefaults: true, timeout: 15000 });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(100);
  }
  throw new Error(`Dedicated Chromium did not expose a debugging endpoint: ${diagnostic}`);
}

async function receipt(run, final = false) {
  const current = await run.page.evaluate(
    (finish) => (finish ? window.soak.stop() : window.soak.snapshot()),
    final,
  );
  if (
    run.last &&
    current.elapsedSeconds - run.last.elapsedSeconds >= 2 &&
    current.quanta <= run.last.quanta
  ) {
    run.stalledIntervals++;
  }
  const result = {
    ...current,
    stalledIntervals: run.stalledIntervals,
    browserErrors: run.errors,
    wasm: run.wasm,
  };
  if (run.errors.total) {
    result.errors.total += run.errors.total;
    result.errors.first = [...result.errors.first, ...run.errors.first].slice(0, 16);
  }
  run.last = result;
  if (final) {
    result.failures = validateReceipt(result, run.transport, seconds);
    if (
      result.streams.midiEcho.received !== result.sentMidiPairs ||
      result.streams.sysexEcho.received !== result.sentMidiPairs
    ) {
      result.failures.push("MIDI round-trip did not return every sent pair");
    }
    if (interrupted) result.failures.push("run interrupted");
    result.passed = result.failures.length === 0;
    await save(run.transport, result);
  } else {
    await save(`${run.transport}.progress`, result);
  }
  console.log(
    JSON.stringify({
      kind: final ? "final" : "progress",
      transport: run.transport,
      elapsedSeconds: Math.round(result.elapsedSeconds),
      audioSeconds: result.audioSeconds,
      quanta: result.quanta,
      visibility: result.visibilityState,
      hiddenSeconds: Math.round(result.hiddenSeconds),
      visibleSeconds: Math.round(result.visibleSeconds),
      received: Object.fromEntries(
        Object.entries(result.streams).map(([name, stream]) => [name, stream.received]),
      ),
      overflow: result.overflow,
      errors: result.errors.total,
      failures: result.failures,
    }),
  );
  return result;
}

async function show(index) {
  await runs[index].page.bringToFront();
  try {
    await Promise.all(
      runs.map((run, at) =>
        run.page.waitForFunction(
          (state) => document.visibilityState === state,
          at === index ? "visible" : "hidden",
          { timeout: 10000, polling: 100 },
        ),
      ),
    );
  } catch (error) {
    const states = await Promise.all(
      runs.map((run) =>
        run.page.evaluate(() => ({
          visibility: document.visibilityState,
          focus: document.hasFocus(),
        })),
      ),
    );
    throw new Error(`Tab visibility did not follow selection ${index}: ${JSON.stringify(states)}`, {
      cause: error,
    });
  }
}

try {
  await save("metadata", metadata);
  browser = await launchBrowser();
  metadata.browserVersion = browser.version();
  const context = browser.contexts()[0];
  context.setDefaultTimeout(15000);
  for (const transport of ["sab", "postMessage"]) {
    const endpoint = await startServer(transport, join(cacheRoot, transport));
    servers.push(endpoint.server);
    const page = await context.newPage();
    const run = {
      transport,
      page,
      last: null,
      stalledIntervals: 0,
      errors: { total: 0, first: [] },
      wasm: null,
      navigations: 0,
    };
    runs.push(run);
    const browserError = (error) => {
      run.errors.total++;
      if (run.errors.first.length < 16) run.errors.first.push(String(error));
    };
    page.on("pageerror", browserError);
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      run.navigations++;
      if (run.navigations > 1) browserError("Soak page navigated again during the run");
    });
    page.on("crash", () => browserError("browser page crashed"));
    page.on("console", (message) => {
      if (message.type() === "error") browserError(message.text());
    });
    page.on("response", async (response) => {
      const pathname = new URL(response.url()).pathname;
      if (pathname.endsWith(".wasm") || pathname.endsWith("/wasm")) {
        try {
          run.wasm = {
            url: response.url(),
            sha256: createHash("sha256")
              .update(await response.body())
              .digest("hex"),
          };
        } catch (error) {
          browserError(error);
        }
      }
    });
    await page.goto(endpoint.url);
    await page.waitForFunction(() => Boolean(window.soak));
    await page.locator("#start").click();
    await page.waitForFunction(() => window.soak.ready || window.soak.failed, undefined, {
      timeout: 30000,
    });
    if (await page.evaluate(() => window.soak.failed)) {
      throw new Error(
        `${transport} failed to start: ${JSON.stringify(await page.evaluate(() => window.soak.snapshot()))}`,
      );
    }
  }
  await show(0);
  await Promise.all(runs.map((run) => receipt(run)));
  await save("metadata", metadata);
  console.log(JSON.stringify({ kind: "started", output, secondsPerTransport: seconds }));
  const start = performance.now();
  const switchEvery = Math.min(60000, (seconds * 1000) / 3);
  let nextSwitch = switchEvery;
  let nextProgress = 30000;
  let foreground = 0;
  while (!interrupted && performance.now() - start < seconds * 1000) {
    await delay(Math.min(1000, Math.max(1, seconds * 1000 - (performance.now() - start))));
    const elapsed = performance.now() - start;
    if (elapsed >= nextSwitch) {
      foreground = 1 - foreground;
      await show(foreground);
      nextSwitch += switchEvery;
    }
    if (elapsed >= nextProgress) {
      await Promise.all(runs.map((run) => receipt(run)));
      nextProgress += 30000;
    }
  }
  const results = await Promise.all(runs.map((run) => receipt(run, true)));
  await save("summary", {
    ...metadata,
    finishedAt: new Date().toISOString(),
    passed: results.every((result) => result.passed),
    results,
  });
  process.exitCode = results.every((result) => result.passed) ? 0 : 1;
} catch (error) {
  process.exitCode = 1;
  await save("failure", {
    ...metadata,
    failedAt: new Date().toISOString(),
    error: String(error?.stack ?? error),
    receipts: runs.map((run) => run.last),
  });
  console.error(error);
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      console.error("Browser disconnect failed:", error);
    }
  }
  if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
    browserProcess.kill("SIGTERM");
    await Promise.race([browserClosed, delay(5000)]);
    if (browserProcess.exitCode === null && browserProcess.signalCode === null) {
      browserProcess.kill("SIGKILL");
      await browserClosed;
    }
  }
  await Promise.all(servers.map((server) => server.close()));
  await rm(cacheRoot, { recursive: true, force: true });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
