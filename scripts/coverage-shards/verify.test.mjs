import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalCoverage,
  combineCoverage,
  compareCoverage,
  partition,
  validateReports,
  validateIdentity,
} from "./verify.mjs";

const root = "/checkout/packages/lang";
const source = "src/subject.ts";
const point = (line, column) => ({ line, column });
const loc = (line, start = 0, end = 10) => ({ start: point(line, start), end: point(line, end) });
function coverage(bits = [1, 0], id = "0") {
  return {
    [`${root}/${source}`]: {
      path: `${root}/${source}`,
      branchMap: {
        [id]: { type: "cond-expr", line: 1, loc: loc(1), locations: [loc(1, 0, 4), loc(1, 6, 10)] },
      },
      b: { [id]: bits },
      statementMap: {},
      fnMap: {},
      s: {},
      f: {},
    },
  };
}
const canonical = (map) => canonicalCoverage(map, root, [source]);
test("union uses branch identities and OR bits, ignoring IDs and hit-count magnitude", () => {
  const union = combineCoverage([canonical(coverage([8, 0])), canonical(coverage([0, 4], "3"))]);
  compareCoverage(union, canonical(coverage([1, 1], "9")));
  assert.throws(() => compareCoverage(union, canonical(coverage([1, 0]))), /coverage/);
});
test("preserves uncovered alternatives rather than averaging percentages", () => {
  const map = canonical(coverage([0, 0]));
  assert.equal(map[0].branches.length, 1);
  assert.deepEqual(map[0].branches[0].covered, [false, false]);
});
for (const [label, mutate] of [
  [
    "empty denominator",
    (map) => {
      delete map[`${root}/${source}`];
    },
  ],
  [
    "wrong root",
    (map) => {
      map[`${root}/${source}`].path = `/other/${source}`;
    },
  ],
  [
    "missing alternative",
    (map) => {
      map[`${root}/${source}`].b[0].pop();
    },
  ],
  [
    "negative counter",
    (map) => {
      map[`${root}/${source}`].b[0][0] = -1;
    },
  ],
  [
    "invalid location",
    (map) => {
      map[`${root}/${source}`].branchMap[0].loc.start.line = 0;
    },
  ],
])
  test(`rejects ${String(label)}`, () => {
    const map = coverage();
    mutate(map);
    assert.throws(() => canonical(map));
  });
test("rejects changed branch structure even when both maps would be 100 percent", () => {
  const map = coverage([1, 1]);
  map[`${root}/${source}`].branchMap[0].type = "if";
  assert.throws(() => combineCoverage([canonical(coverage([1, 1])), canonical(map)]), /structure/);
});
test("rejects ambiguous duplicate structural branch locations", () => {
  const map = coverage();
  const file = map[`${root}/${source}`];
  file.branchMap[1] = structuredClone(file.branchMap[0]);
  file.b[1] = [0, 1];
  assert.throws(() => canonical(map), /ambiguous/);
});
const identity = {
  schema: 1,
  package: "lang",
  sha: "a".repeat(40),
  tree: "b".repeat(40),
  run: "1",
  attempt: "2",
  root,
  fingerprint: "c".repeat(64),
  runtime: { node: "v24", v8: "1", vitePlus: "0.1.24", runner: "4.1.8", provider: "4.1.8" },
};
for (const key of [
  "schema",
  "package",
  "sha",
  "tree",
  "run",
  "attempt",
  "root",
  "fingerprint",
  "runtime",
]) {
  test(`rejects mismatched ${key}`, () => {
    const other = structuredClone(identity);
    other[key] = "wrong";
    assert.throws(() => validateIdentity(other, identity), /identity/);
  });
}
const tests = ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts", "src/d.test.ts"];
function report(files) {
  return {
    success: true,
    numTotalTests: files.length,
    numPassedTests: files.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: files.length,
    numPassedTestSuites: files.length,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    testResults: files.map((name) => ({
      name: `${root}/${name}`,
      status: "passed",
      assertionResults: [
        { ancestorTitles: ["suite"], title: "works", fullName: "suite works", status: "passed" },
      ],
    })),
  };
}
test("accepts complete disjoint default-hash partitions", () => {
  validateReports([report(partition(tests, 1)), report(partition(tests, 2))], root, tests);
});
for (const [label, mutate] of [
  [
    "duplicate file",
    (reports) => {
      reports[1] = structuredClone(reports[0]);
    },
  ],
  [
    "missing file",
    (reports) => {
      reports[0].testResults.pop();
    },
  ],
  [
    "wrong partition",
    (reports) => {
      reports.reverse();
    },
  ],
  [
    "failed test",
    (reports) => {
      reports[0].testResults[0].assertionResults[0].status = "failed";
    },
  ],
  [
    "incomplete test",
    (reports) => {
      reports[0].testResults[0].assertionResults[0].status = "pending";
    },
  ],
  [
    "unsuccessful run",
    (reports) => {
      reports[0].success = false;
    },
  ],
  [
    "wrong test count",
    (reports) => {
      reports[0].numTotalTests++;
    },
  ],
])
  test(`rejects ${String(label)}`, () => {
    const reports = [report(partition(tests, 1)), report(partition(tests, 2))];
    mutate(reports);
    assert.throws(() => validateReports(reports, root, tests));
  });

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readBundle } from "./verify.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function bundleFixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "coverage-bundle-"));
  const expected = { ...identity, sources: [source] };
  mkdirSync(resolve(directory, "coverage"));
  const outputs = {
    "blob.json": ["runner-version", "serialized fixture"],
    "tests.json": { ...report(["src/b.test.ts"]), coverageMap: coverage() },
    "coverage/coverage-final.json": coverage(),
    "coverage/coverage-summary.json": { total: { branches: { total: 2, covered: 1, pct: 50 } } },
  };
  for (const [file, value] of Object.entries(outputs))
    writeFileSync(resolve(directory, file), JSON.stringify(value));
  const manifest = {
    ...expected,
    complete: true,
    shard: 1,
    shards: 2,
    outputs: Object.fromEntries(
      Object.keys(outputs).map((file) => [file, hash(readFileSync(resolve(directory, file)))]),
    ),
  };
  writeFileSync(resolve(directory, "manifest.json"), JSON.stringify(manifest));
  return { directory, expected, manifest };
}
test("accepts a sealed complete artifact", () => {
  const { directory, expected } = bundleFixture();
  try {
    readBundle(directory, expected, 1);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
for (const file of [
  "manifest.json",
  "blob.json",
  "tests.json",
  "coverage/coverage-final.json",
  "coverage/coverage-summary.json",
]) {
  test(`rejects missing artifact output ${file}`, () => {
    const { directory, expected } = bundleFixture();
    try {
      rmSync(resolve(directory, file));
      assert.throws(() => readBundle(directory, expected, 1));
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
}
for (const [label, mutate] of [
  [
    "wrong shard",
    (manifest) => {
      manifest.shard = 2;
    },
  ],
  [
    "wrong shard count",
    (manifest) => {
      manifest.shards = 3;
    },
  ],
  [
    "missing completion",
    (manifest) => {
      delete manifest.complete;
    },
  ],
  [
    "stale attempt",
    (manifest) => {
      manifest.attempt = "1";
    },
  ],
  [
    "wrong checksum",
    (manifest) => {
      manifest.outputs["blob.json"] = "wrong";
    },
  ],
  [
    "missing checksum",
    (manifest) => {
      delete manifest.outputs["tests.json"];
    },
  ],
])
  test(`rejects artifact ${String(label)}`, () => {
    const { directory, expected, manifest } = bundleFixture();
    try {
      mutate(manifest);
      writeFileSync(resolve(directory, "manifest.json"), JSON.stringify(manifest));
      assert.throws(() => readBundle(directory, expected, 1));
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
for (const content of ["", "{", "corrupt", "[]garbage"])
  test(`rejects corrupt blob ${JSON.stringify(content)}`, () => {
    const { directory, expected, manifest } = bundleFixture();
    try {
      writeFileSync(resolve(directory, "blob.json"), content);
      manifest.outputs["blob.json"] = hash(content);
      writeFileSync(resolve(directory, "manifest.json"), JSON.stringify(manifest));
      assert.throws(() => readBundle(directory, expected, 1));
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
test("rejects a checksummed but incomplete source denominator", () => {
  const { directory, expected, manifest } = bundleFixture();
  try {
    const path = "coverage/coverage-final.json";
    writeFileSync(resolve(directory, path), "{}");
    manifest.outputs[path] = hash("{}");
    writeFileSync(resolve(directory, "manifest.json"), JSON.stringify(manifest));
    assert.throws(() => readBundle(directory, expected, 1), /denominator/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
test("duplicate test names remain a multiset during reference comparison", () => {
  const shards = [report(partition(tests, 1)), report(partition(tests, 2))];
  const reference = report(tests);
  reference.testResults[0].assertionResults.push(
    structuredClone(reference.testResults[0].assertionResults[0]),
  );
  reference.numTotalTests++;
  reference.numPassedTests++;
  assert.throws(() => validateReports(shards, root, tests, reference), /multiset/);
});

function implicitElseCoverage() {
  const map = coverage();
  const branch = map[`${root}/${source}`].branchMap[0];
  branch.type = "if";
  branch.loc.end.column = null;
  branch.locations = [structuredClone(branch.loc), { start: {}, end: {} }];
  return map;
}
test("preserves native implicit-else and explicit end-of-line branch identities", () => {
  const map = canonical(implicitElseCoverage());
  const branch = JSON.parse(map[0].branches[0].key);
  assert.equal(branch.loc.end.column, "end-of-line");
  assert.equal(branch.locations[0].end.column, "end-of-line");
  assert.deepEqual(branch.locations[1], { implicitElse: true });
  assert.deepEqual(map[0].branches[0].covered, [true, false]);
  const finite = implicitElseCoverage();
  finite[`${root}/${source}`].branchMap[0].loc.end.column = 10;
  assert.throws(() => compareCoverage(map, canonical(finite)), /coverage/);
});
test("preserves explicit end-of-line on ordinary ternary alternatives", () => {
  const map = coverage();
  map[`${root}/${source}`].branchMap[0].locations[1].end.column = null;
  const branch = JSON.parse(canonical(map)[0].branches[0].key);
  assert.equal(branch.locations[1].end.column, "end-of-line");
});
for (const [label, mutate] of [
  [
    "null start column",
    (branch) => {
      branch.loc.start.column = null;
    },
  ],
  [
    "missing end column",
    (branch) => {
      delete branch.loc.end.column;
    },
  ],
  [
    "missing end line",
    (branch) => {
      delete branch.loc.end.line;
    },
  ],
  [
    "partial implicit start",
    (branch) => {
      branch.locations[1].start.line = 1;
    },
  ],
  [
    "partial implicit end",
    (branch) => {
      branch.locations[1].end.column = null;
    },
  ],
  [
    "missing implicit endpoint",
    (branch) => {
      delete branch.locations[1].end;
    },
  ],
  [
    "array implicit endpoint",
    (branch) => {
      branch.locations[1].end = [];
    },
  ],
  [
    "extra implicit field",
    (branch) => {
      branch.locations[1].extra = true;
    },
  ],
  [
    "implicit first alternative",
    (branch) => {
      branch.locations.reverse();
    },
  ],
  [
    "implicit non-if alternative",
    (branch) => {
      branch.type = "cond-expr";
    },
  ],
  [
    "implicit third alternative",
    (branch) => {
      branch.locations.unshift(structuredClone(branch.loc));
    },
  ],
  [
    "string end column",
    (branch) => {
      branch.loc.end.column = "end-of-line";
    },
  ],
])
  test(`rejects malformed native location: ${String(label)}`, () => {
    const map = implicitElseCoverage();
    mutate(map[`${root}/${source}`].branchMap[0]);
    if (map[`${root}/${source}`].branchMap[0].locations.length === 3)
      map[`${root}/${source}`].b[0].push(0);
    assert.throws(() => canonical(map));
  });
