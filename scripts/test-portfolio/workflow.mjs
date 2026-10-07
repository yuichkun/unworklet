import assert from "node:assert/strict";

const branchPolicy = (exclude, include = ["src/**/*.ts"]) => ({
  provider: "v8",
  include,
  exclude,
  thresholds: { branches: 98 },
});

export const COVERAGE_POLICIES = {
  "packages/core/vite.config.ts": branchPolicy([
    "src/**/*.test.ts",
    "src/types.ts",
    "src/index.ts",
    "src/__tests__/browser/fixtures/**",
    "src/__tests__/behavior/render.ts",
  ]),
  "packages/lang/vite.config.ts": branchPolicy([
    "src/**/*.test.ts",
    "src/index.ts",
    "src/golden/**",
    "src/unworklet-tsc.ts",
  ]),
  "packages/offline/vite.config.ts": branchPolicy(["src/**/*.test.ts", "src/golden/**"]),
  "packages/test/vite.config.ts": branchPolicy(["src/**/*.test.ts"]),
  "packages/unplugin/vite.config.ts": branchPolicy(["src/**/*.test.ts"]),
  "packages/unplugin/devtools-ui/vite.config.ts": branchPolicy(
    ["src/**/*.test.ts", "src/env.d.ts"],
    ["src/**/*.ts", "src/**/*.vue"],
  ),
};

export function validateCoveragePolicies(policies) {
  assert.deepEqual(
    Object.keys(policies).sort(),
    Object.keys(COVERAGE_POLICIES).sort(),
    "coverage policy owners",
  );
  for (const [config, expected] of Object.entries(COVERAGE_POLICIES)) {
    const actual = Object.fromEntries(
      Object.keys(expected).map((key) => [key, policies[config][key]]),
    );
    assert.deepEqual(actual, expected, `coverage policy ${config}`);
  }
}

function job(workflow, name) {
  const match = workflow.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, "m"),
  );
  assert(match, `missing workflow job ${name}`);
  return match[1];
}

function requireUnconditional(jobText) {
  const header = jobText.split(/^    steps:/m)[0];
  assert(
    !/^    (if|needs|continue-on-error):/m.test(header),
    "owner jobs must remain unconditional required gates",
  );
}

function steps(jobText) {
  return jobText.split(/(?=^      - )/m).slice(1);
}

function runText(step) {
  const match = step.match(/^(?:      - |        )run: ([^\n]+)(?:\n|$)/m);
  if (!match) return null;
  if (match[1] !== "|") return match[1].trim();
  return step
    .slice(match.index + match[0].length)
    .split("\n")
    .filter((line) => line.startsWith("          "))
    .map((line) => line.slice(10))
    .join("\n")
    .trim();
}

function requireRun(jobText, command, directory) {
  const step = steps(jobText).find((entry) => runText(entry) === command);
  assert(step, `missing exact CI command: ${command}`);
  assert(
    !/^(?:      - |        )(if|continue-on-error):/m.test(step),
    "owner execution must remain unconditional",
  );
  const cwd = step.match(/^        working-directory: (.*)$/m)?.[1];
  assert.equal(cwd, directory, `wrong command directory: ${command}`);
  return step;
}

export function validateWorkflow(workflow) {
  for (const [id, name] of Object.entries({
    check: "Lint + Format + Typecheck (= vp check)",
    vitest: "Vitest (= node-side + browser SAB + browser postMessage)",
    "devtools-coverage": "Branch coverage (DevTools UI)",
    e2e: "Playwright e2e (via dev server)",
    packaging: "Packaging (publint + arethetypeswrong)",
  })) {
    assert.equal(job(workflow, id).match(/^    name: (.*)$/m)?.[1], name, `check identity: ${id}`);
  }
  const triggers = workflow.match(/^on:\n([\s\S]*?)(?=^\S)/m)?.[1].trim();
  assert.equal(triggers, "push:\n  pull_request:\n  workflow_dispatch:", "test event triggers");
  const coverage = job(workflow, "coverage");
  const vitest = job(workflow, "vitest");
  const devtools = job(workflow, "devtools-coverage");
  const demoBrowser = job(workflow, "e2e");
  const check = job(workflow, "check");
  for (const owner of [coverage, vitest, devtools, demoBrowser, check]) requireUnconditional(owner);
  assert.match(coverage, /^    name: Branch coverage \(\$\{\{ matrix.package \}\}\)$/m);
  assert.match(coverage, /^        package: \[core, lang, offline, test, unplugin\]$/m);
  const matrix = coverage
    .split(/^    steps:/m)[0]
    .match(/^      matrix:\n([\s\S]*)/m)?.[1]
    .trim();
  assert.equal(
    matrix,
    "package: [core, lang, offline, test, unplugin]",
    "complete package matrix without filtering",
  );
  assert.match(coverage, /^      fail-fast: false$/m);
  const coverageStep = requireRun(
    coverage,
    `/usr/bin/time -v vp test run --coverage --maxWorkers=2 \\
  --reporter=default --reporter=json --outputFile.json=coverage/tests.json \\
  --coverage.reporter=text --coverage.reporter=html \\
  --coverage.reporter=json-summary --coverage.reporter=json`,
    "packages/${{ matrix.package }}",
  );
  assert.match(coverageStep, /^          UWK_DISTS_BUILT: "1"$/m);
  requireRun(devtools, "vp test run --coverage --maxWorkers=1", "packages/unplugin/devtools-ui");
  requireRun(vitest, "vp test run --config vite.ci.config.ts");
  requireRun(vitest, "vp test run", "examples/demo");
  requireRun(demoBrowser, "vp test run --config vite.browser.config.ts", "examples/demo");
  requireRun(check, "vp exec node --test scripts/test-portfolio/*.test.mjs");
  requireRun(vitest, "vp exec node scripts/test-portfolio/check.mjs");
  assert(
    vitest.indexOf("vp run --filter @unworklet/test build") <
      vitest.indexOf("vp exec node scripts/test-portfolio/check.mjs"),
    "file discovery needs built plugin imports",
  );
  assert(
    vitest.indexOf("vp exec node scripts/test-portfolio/check.mjs") <
      vitest.indexOf("vp test run --config vite.ci.config.ts"),
    "ownership is checked before residual execution",
  );
}
