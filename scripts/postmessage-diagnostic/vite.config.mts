import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineConfig } from "vite-plus";

import base from "../../packages/core/vite.browser-postmessage.config.ts";
import { diagnosticPlugin, testPath, title } from "./instrument.mjs";
import { getDiagnosticSession } from "./session.mjs";

const root = fileURLToPath(new URL("../../packages/core", import.meta.url));
const files = [
  "instrument.mjs",
  "retention.mjs",
  "decode.mjs",
  "artifacts.mjs",
  "session.mjs",
  "vite.config.mts",
];
const { runId, sink } = getDiagnosticSession(process.env.UWK_DIAG_OUTPUT, {
  root,
  chromium: process.env.UWK_DIAG_CHROMIUM ?? null,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  node: process.version,
  recording: process.env.UWK_DIAG_RECORD !== "0",
  hashes: Object.fromEntries(
    files.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(new URL(file, import.meta.url)))
        .digest("hex"),
    ]),
  ),
});
let caseResult: { state: string; errors?: readonly unknown[] } | null = null;
let secondaryExportFailure: unknown = null;
const collection = { modules: 0, tests: 0, target: 0, results: 0 };

export default defineConfig({
  ...base,
  root,
  plugins: [
    diagnosticPlugin(root, process.env.UWK_DIAG_RECORD !== "0", runId, (record) =>
      sink.recordTransform(record),
    ),
    ...base.plugins!,
  ],
  test: {
    ...base.test,
    include: [testPath],
    testNamePattern: `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    retry: 0,
    reporters: [
      "default",
      {
        onInit() {
          sink.start();
        },
        onTestModuleCollected(module) {
          collection.modules++;
          for (const test of module.children.allTests()) {
            collection.tests++;
            if (test.name === title) collection.target++;
          }
        },
        onTestCaseResult(testCase) {
          if (testCase.name === title) {
            collection.results++;
            caseResult = testCase.result();
            secondaryExportFailure =
              (testCase.meta() as { uwkDiagnosticExportFailure?: unknown })
                .uwkDiagnosticExportFailure ?? null;
          }
        },
        onTestRunEnd(modules, errors, reason) {
          const diagnostic = sink.finish({
            reason,
            errors,
            caseResult,
            collection,
            secondaryExportFailure,
            moduleStates: modules.slice(0, 2).map((m) => m.state()),
          });
          if (diagnostic.traceStatus !== "complete") process.exitCode = 1;
        },
      },
    ],
    browser: {
      ...base.test!.browser,
      commands: {
        writePostmessageDiagnostic: (_context, result) => sink.write(result),
      },
      provider: playwright({
        launchOptions: process.env.UWK_DIAG_CHROMIUM
          ? { executablePath: process.env.UWK_DIAG_CHROMIUM }
          : {},
      }),
    },
  },
});
