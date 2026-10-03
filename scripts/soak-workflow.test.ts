import { readFileSync } from "node:fs";
import { dirname, matchesGlob, relative, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
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

test("all value imports reachable from runtime entry points trigger the soak", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = stripTypeScriptTypes(readFileSync(file, "utf8"));
    for (const match of source.matchAll(/(?:from|import)\s+["'](\.[^"']+)["']/g)) {
      visit(resolve(dirname(file), match[1]!));
    }
  };
  for (const entry of [
    "client.ts",
    "worklet-entry.ts",
    "replaceProcessor.ts",
    "worklet-module.ts",
  ]) {
    visit(resolve(root, "packages/core/src", entry));
  }
  const excluded = [...seen].map((file) => relative(root, file)).filter((file) => !included(file));
  expect(excluded).toEqual([]);
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
    workflow.indexOf("run: vp exec node scripts/release-soak/validate-ci-seconds.mjs"),
  ).toBeGreaterThan(0);
  expect(
    workflow.indexOf("run: vp exec node scripts/release-soak/validate-ci-seconds.mjs"),
  ).toBeLessThan(workflow.indexOf("run: vp install"));
  expect(workflow).toContain("if: always()");
});
