import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const gatePaths = [
  ".github/workflows/release.yml",
  ".github/workflows/soak.yml",
  "scripts/release-soak/verify-release.mjs",
];

function selectDuration(change: string, mode = "modify") {
  const root = mkdtempSync(resolve(tmpdir(), "soak-duration-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const write = (path: string, value: string) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), value);
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    for (const path of [...gatePaths, "runtime.ts"]) write(path, "baseline\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    if (mode === "delete") rmSync(resolve(root, change));
    else if (mode === "rename") git("mv", change, "renamed.txt");
    else write(change, "changed\n");
    git("add", ".");
    git("commit", "-qm", "change");
    if (mode === "cumulative") {
      write("runtime.ts", "later unrelated change\n");
      git("add", ".");
      git("commit", "-qm", "later");
    }
    const output = resolve(root, "duration.env");
    const script = workflow.match(
      /name: Select PR soak duration[\s\S]*?        run: \|\n([\s\S]*?)(?=      -)/,
    )?.[1];
    expect(script).toBeDefined();
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script!], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        BASE_SHA: mode === "error" ? "invalid" : base,
        HEAD_SHA: git("rev-parse", "HEAD"),
        GITHUB_ENV: output,
      },
    });
    if (mode === "error") {
      expect(result.status).not.toBe(0);
      expect(() => readFileSync(output)).toThrow();
    } else {
      expect(result.status, result.stderr).toBe(0);
      return readFileSync(output, "utf8").trim();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test.each(gatePaths)("gate change %s selects the full run", (path) => {
  expect(included(path)).toBe(true);
  expect(selectDuration(path)).toBe("SOAK_SECONDS=1800");
});
test.each(["modify", "cumulative", "delete", "rename"])("cumulative gate diff handles %s", (mode) =>
  expect(selectDuration(gatePaths[0]!, mode)).toBe("SOAK_SECONDS=1800"),
);
test.each(["runtime.ts", "scripts/release-soak/run.mjs", "RELEASE.md"])(
  "ordinary change %s retains the short run",
  (path) => expect(selectDuration(path)).toBe("SOAK_SECONDS=120"),
);
test("diff errors cannot silently select a short run", () => {
  selectDuration("runtime.ts", "error");
});
test("full PR evidence is checked against the actual head without publication privileges", () => {
  expect(workflow).toContain("ref: ${{ github.event.pull_request.head.sha || github.sha }}");
  expect(workflow).toContain("fetch-depth: 0");
  expect(workflow).toContain("SOAK_SHA: ${{ github.event.pull_request.head.sha || github.sha }}");
  expect(workflow).toContain("if: github.event_name == 'pull_request'");
  expect(workflow).toContain("BASE_SHA: ${{ github.event.pull_request.base.sha }}");
  expect(workflow).toContain("HEAD_SHA: ${{ github.event.pull_request.head.sha }}");
  expect(workflow).toContain("SOAK_SECONDS: ${{ inputs.seconds || '120' }}");
  expect(workflow).toContain('default: "1800"');
  expect(workflow).toContain("if: success() && env.SOAK_SECONDS == '1800'");
  const verify = workflow.indexOf(
    'run: vp exec node scripts/release-soak/verify-release.mjs "$RUNNER_TEMP/soak/summary.json" "$SOAK_SHA"',
  );
  expect(verify).toBeGreaterThan(workflow.indexOf("name: Run the soak"));
  expect(verify).toBeLessThan(workflow.indexOf("name: Upload the soak report"));
  expect(workflow.indexOf("name: Select PR soak duration")).toBeLessThan(
    workflow.indexOf("name: Validate soak duration"),
  );
  expect(workflow).toContain("contents: read");
  expect(workflow).not.toMatch(/contents: write|id-token:|continue-on-error:|no-sandbox/);
});
