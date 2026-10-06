import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
const workflow = readFileSync(new URL("../../.github/workflows/test.yml", import.meta.url), "utf8");
const candidate = workflow.slice(
  workflow.indexOf("  lang-coverage-equivalence:"),
  workflow.indexOf("  devtools-coverage:"),
);
test("validation retains the unsharded named package gate and all other jobs", () => {
  assert(workflow.includes("name: Branch coverage (${{ matrix.package }})"));
  assert(workflow.includes("package: [core, lang, offline, test, unplugin]"));
  assert.equal((workflow.match(/--coverage.thresholds.branches=0/g) ?? []).length, 1);
  assert(workflow.includes("name: Vitest (= node-side + browser SAB + browser postMessage)"));
  assert(workflow.includes("name: Branch coverage (DevTools UI)"));
  assert(workflow.includes("name: Packaging (publint + arethetypeswrong)"));
});
test("candidate merger rejects failed, skipped and cancelled producers before downloading", () => {
  assert(candidate.includes("needs: [coverage, lang-coverage-shards]"));
  assert(candidate.includes("if: ${{ always() }}"));
  assert(
    candidate.includes(
      'run: test "$REFERENCE_RESULT" = success && test "$SHARDS_RESULT" = success',
    ),
  );
  assert(candidate.indexOf("Reject unsuccessful") < candidate.indexOf("actions/checkout"));
  assert(!candidate.includes("continue-on-error"));
});
test("merge downloads exact current-attempt artifacts separately before verification", () => {
  for (const suffix of ["reference", "1-of-2", "2-of-2"])
    assert(
      candidate.includes(
        `name: lang-coverage-\${{ github.run_id }}-\${{ github.run_attempt }}-${suffix}`,
      ),
    );
  assert(!candidate.includes("merge-multiple"));
  assert(
    candidate.indexOf("verify.mjs prepare") < candidate.indexOf("--merge-reports=merge-blobs"),
  );
  assert(
    candidate.indexOf("--merge-reports=merge-blobs") < candidate.indexOf("verify.mjs compare"),
  );
  assert(!candidate.includes("thresholds.branches"));
});
