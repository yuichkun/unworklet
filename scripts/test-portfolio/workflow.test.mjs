import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { validateWorkflow, validateCoveragePolicies, COVERAGE_POLICIES } from "./workflow.mjs";

const workflow = readFileSync(new URL("../../.github/workflows/test.yml", import.meta.url), "utf8");

void test("the complete CI ownership routing is active and all package gates remain required", () => {
  assert.doesNotThrow(() => validateWorkflow(workflow));
});

void test("missing owners, worker-policy changes and conditional package gates fail", () => {
  for (const change of [
    (text) =>
      text.replace(
        "package: [core, lang, offline, test, unplugin]",
        "package: [core, lang, offline, test]",
      ),
    (text) =>
      text.replace(
        "package: [core, lang, offline, test, unplugin]",
        "package: [core, lang, offline, test, unplugin]\n        exclude: [{package: lang}]",
      ),
    (text) =>
      text.replace("  pull_request:\n", "  pull_request:\n    paths: ['packages/core/**']\n"),
    (text) => text.replace("--maxWorkers=2", "--maxWorkers=4"),
    (text) => text.replace("--maxWorkers=2", "--maxWorkers=1"),
    (text) => text.replace("  coverage:\n", "  coverage:\n    needs: vitest\n"),
    (text) => text.replace("  coverage:\n", "  coverage:\n    if: github.event_name == 'push'\n"),
    (text) => text.replace("  coverage:\n", "  coverage:\n    continue-on-error: true\n"),
    (text) =>
      text.replace(
        "      - name: Measure package branches and enforce its threshold\n",
        "      - name: Measure package branches and enforce its threshold\n        if: matrix.package != 'lang'\n",
      ),
    (text) =>
      text.replace(
        "vp test run --config vite.ci.config.ts",
        "vp test run --config vite.ci.config.ts --project core-browser-sab",
      ),
    (text) => text.replace("vp exec node scripts/test-portfolio/check.mjs", "echo skipped"),
    (text) =>
      text.replace(
        "vp test run --coverage --maxWorkers=1",
        "vp test run --coverage --maxWorkers=1 --testNamePattern smoke",
      ),
  ]) {
    const changed = change(workflow);
    assert.notEqual(changed, workflow, "the mutation must hit the actual workflow");
    assert.throws(() => validateWorkflow(changed));
  }
});

void test("each package retains the exact V8 98% branch-only denominator policy", async () => {
  const policies = {};
  for (const config of Object.keys(COVERAGE_POLICIES)) {
    const { default: value } = await import(new URL(`../../${config}`, import.meta.url));
    policies[config] = value.test.coverage;
  }
  assert.doesNotThrow(() => validateCoveragePolicies(policies));
  for (const config of Object.keys(policies)) {
    const changed = structuredClone(policies);
    changed[config].thresholds.branches = 97;
    assert.throws(() => validateCoveragePolicies(changed), /coverage policy/);
    const omitted = structuredClone(policies);
    omitted[config].exclude.push("src/unmeasured.ts");
    assert.throws(() => validateCoveragePolicies(omitted), /coverage policy/);
  }
});

void test("first-key YAML conditions and ignored failures cannot bypass an owner", () => {
  for (const field of ["if: false", "continue-on-error: true"]) {
    const changed = workflow.replace(
      "      - name: Measure package branches and enforce its threshold\n",
      `      - ${field}\n        name: Measure package branches and enforce its threshold\n`,
    );
    assert.notEqual(changed, workflow);
    assert.throws(() => validateWorkflow(changed), /unconditional/);
  }
});

void test("every retained CI check identity remains stable", () => {
  for (const name of [
    "Lint + Format + Typecheck (= vp check)",
    "Vitest (= node-side + browser SAB + browser postMessage)",
    "Branch coverage (DevTools UI)",
    "Playwright e2e (via dev server)",
    "Packaging (publint + arethetypeswrong)",
  ]) {
    const changed = workflow.replace(`    name: ${name}\n`, `    name: Renamed ${name}\n`);
    assert.notEqual(changed, workflow);
    assert.throws(() => validateWorkflow(changed), /check identity/);
  }
});

void test("every retained job rejects conditional, dependency and ignored-failure bypasses", () => {
  for (const id of ["coverage", "vitest", "devtools-coverage", "e2e", "check", "packaging"]) {
    for (const field of ["if: false", "needs: check", "continue-on-error: true"]) {
      const changed = workflow.replace(`  ${id}:\n`, `  ${id}:\n    ${field}\n`);
      assert.notEqual(changed, workflow, `mutation must hit ${id}`);
      assert.throws(() => validateWorkflow(changed), /unconditional/, `${id}: ${field}`);
    }
  }
});
