import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { validateWorkflow } from "../test-portfolio/workflow.mjs";
const workflow = readFileSync(new URL("../../.github/workflows/test.yml", import.meta.url), "utf8");
void test("four shard producers and the independently cancellable required owner are wired", () =>
  assert.doesNotThrow(() => validateWorkflow(workflow)));
for (const [label, change] of [
  ["missing shard", (s) => s.replace("shard: [1, 2, 3, 4]", "shard: [1, 2, 3]")],
  [
    "owner dependency",
    (s) => s.replace("  lang-coverage:\n", "  lang-coverage:\n    needs: lang-shards\n"),
  ],
  [
    "owner always immunity",
    (s) => s.replace("  lang-coverage:\n", "  lang-coverage:\n    if: always()\n"),
  ],
  [
    "renamed required owner",
    (s) => s.replace("    name: Branch coverage (lang)", "    name: Not required"),
  ],
  [
    "missing polling",
    (s) => s.replace("vp exec node scripts/lang-coverage/coordinator.mjs", "echo bypass"),
  ],
  [
    "missing native merge",
    (s) => s.replace("vp test run --merge-reports=merge-blobs --coverage", "echo merge-skipped"),
  ],
  [
    "lowered merged threshold",
    (s) =>
      s.replace(
        "vp test run --merge-reports=merge-blobs --coverage",
        "vp test run --merge-reports=merge-blobs --coverage --coverage.thresholds.branches=0",
      ),
  ],
  [
    "skipped union comparison",
    (s) => s.replace("vp exec node scripts/lang-coverage/verify.mjs compare", "echo compare"),
  ],
  [
    "ignored producer failure",
    (s) => s.replace("  lang-shards:\n", "  lang-shards:\n    continue-on-error: true\n"),
  ],
  [
    "partial shard selection",
    (s) => s.replace("--shard=${{ matrix.shard }}/4 --maxWorkers=2", "--shard=1/4 --maxWorkers=2"),
  ],
  [
    "missing artifact sealing",
    (s) => s.replace("vp exec node scripts/lang-coverage/verify.mjs record", "echo seal"),
  ],
])
  void test(`rejects ${String(label)}`, () => {
    const changed = change(workflow);
    assert.notEqual(changed, workflow);
    assert.throws(() => validateWorkflow(changed));
  });
