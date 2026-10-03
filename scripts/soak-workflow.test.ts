import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vite-plus/test";

const workflow = readFileSync(new URL("../.github/workflows/soak.yml", import.meta.url), "utf8");
const paths = [...workflow.matchAll(/^      - "([^"]+)"$/gm)].map((m) => m[1]!);
const included = (file: string) =>
  paths.reduce(
    (match, pattern) =>
      matchesGlob(file, pattern.replace(/^!/, "")) ? !pattern.startsWith("!") : match,
    false,
  );

test("runtime layout changes trigger the soak while compiler-only changes do not", () => {
  expect(included("packages/core/src/compile/layout.ts")).toBe(true);
  expect(included("packages/core/src/compile/emit.ts")).toBe(false);
  expect(included("packages/core/src/client.ts")).toBe(true);
  expect(included("packages/core/src/compile/layout.test.ts")).toBe(false);
});

test.each(["5", "120", "1800", "3600"])("CI accepts duration %s", (seconds) => {
  const result = spawnSync(
    process.execPath,
    [new URL("release-soak/validate-ci-seconds.mjs", import.meta.url).pathname],
    { env: { ...process.env, SOAK_SECONDS: seconds } },
  );
  expect(result.status, result.stderr.toString()).toBe(0);
});

test.each(["", "NaN", "Infinity", "-1", "4", "3601", "86400"])(
  "CI rejects duration %s before browser setup",
  (seconds) => {
    const result = spawnSync(
      process.execPath,
      [new URL("release-soak/validate-ci-seconds.mjs", import.meta.url).pathname],
      { env: { ...process.env, SOAK_SECONDS: seconds } },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain("SOAK_SECONDS must be between 5 and 3600");
  },
);

test("duration validation precedes dependency installation and reports always upload", () => {
  expect(
    workflow.indexOf("run: node scripts/release-soak/validate-ci-seconds.mjs"),
  ).toBeGreaterThan(0);
  expect(workflow.indexOf("run: node scripts/release-soak/validate-ci-seconds.mjs")).toBeLessThan(
    workflow.indexOf("run: vp install"),
  );
  expect(workflow).toContain("if: always()");
});
