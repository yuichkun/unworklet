import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, matchesGlob, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const equal = (actual, expected, message) => assert.deepEqual(actual, expected, message);
const sorted = (items) => [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
function packagePath(path, root) {
  assert.equal(typeof path, "string", "invalid report path");
  assert(isAbsolute(path), "report paths must be absolute");
  const name = relative(root, path);
  assert(name && !name.startsWith("..") && !isAbsolute(name), "wrong package root");
  return name.replaceAll("\\", "/");
}
export function partition(files, index) {
  assert(index === 1 || index === 2, "invalid shard index");
  const ordered = [...files]
    .map((file) => ({ file, hash: createHash("sha1").update(`/${file}`).digest("hex") }))
    .sort((a, b) => a.hash.localeCompare(b.hash));
  const size = Math.ceil(files.length / 2);
  return ordered.slice((index - 1) * size, index * size).map(({ file }) => file);
}
function location(value) {
  for (const key of ["start", "end"]) {
    assert(Number.isInteger(value?.[key]?.line) && value[key].line >= 1, "invalid branch location");
    assert(
      Number.isInteger(value[key].column) && value[key].column >= 0,
      "invalid branch location",
    );
  }
  return {
    start: { line: value.start.line, column: value.start.column },
    end: { line: value.end.line, column: value.end.column },
  };
}
export function canonicalCoverage(map, root, sources) {
  assert(map && typeof map === "object" && !Array.isArray(map), "missing coverage map");
  equal(
    sorted(Object.keys(map).map((file) => packagePath(file, root))),
    sorted(sources),
    "incomplete coverage source denominator",
  );
  return Object.entries(map)
    .map(([path, file]) => {
      assert.equal(file.path, path, "wrong coverage root");
      assert(file.branchMap && file.b, "missing branch map");
      equal(
        sorted(Object.keys(file.branchMap)),
        sorted(Object.keys(file.b)),
        "missing branch counters",
      );
      const branches = Object.entries(file.branchMap)
        .map(([id, branch]) => {
          assert(typeof branch.type === "string" && branch.type, "invalid branch type");
          assert(
            Array.isArray(branch.locations) && branch.locations.length > 0,
            "missing branch alternatives",
          );
          const counts = file.b[id];
          assert(
            Array.isArray(counts) && counts.length === branch.locations.length,
            "missing branch alternative counters",
          );
          assert(
            counts.every((count) => Number.isSafeInteger(count) && count >= 0),
            "invalid branch counters",
          );
          const key = JSON.stringify({
            type: branch.type,
            loc: location(branch.loc),
            locations: branch.locations.map(location),
          });
          return { key, covered: counts.map((count) => count > 0) };
        })
        .sort((a, b) => a.key.localeCompare(b.key));
      assert.equal(
        new Set(branches.map(({ key }) => key)).size,
        branches.length,
        "ambiguous duplicate branch structure",
      );
      return { file: packagePath(path, root), branches };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}
const structure = (map) =>
  map.map(({ file, branches }) => ({ file, branches: branches.map(({ key }) => key) }));
export function combineCoverage(maps) {
  assert(maps.length > 0, "missing coverage maps");
  const union = structuredClone(maps[0]);
  for (const map of maps.slice(1)) {
    equal(structure(map), structure(union), "incompatible coverage branch structure");
    map.forEach(({ branches }, file) =>
      branches.forEach(({ covered }, branch) =>
        covered.forEach((bit, index) => {
          union[file].branches[branch].covered[index] ||= bit;
        }),
      ),
    );
  }
  return union;
}
export function compareCoverage(actual, expected) {
  equal(actual, expected, "coverage structure or covered branch identity differs");
}
export function validateIdentity(actual, expected) {
  for (const key of Object.keys(expected))
    equal(actual[key], expected[key], `identity mismatch: ${key}`);
}
function testIdentities(report, root) {
  assert.equal(report.success, true, "test process did not succeed");
  for (const key of [
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
    "numFailedTestSuites",
    "numPendingTestSuites",
  ])
    assert.equal(report[key], 0, `incomplete tests: ${key}`);
  assert(
    Array.isArray(report.testResults) && report.testResults.length > 0,
    "missing test results",
  );
  const identities = [];
  const files = report.testResults.map((file) => {
    const path = packagePath(file.name, root);
    assert.equal(file.status, "passed", "test file did not pass");
    assert(
      Array.isArray(file.assertionResults) && file.assertionResults.length > 0,
      "empty test file",
    );
    for (const assertion of file.assertionResults) {
      assert.equal(assertion.status, "passed", "test did not pass");
      assert(
        Array.isArray(assertion.ancestorTitles) && typeof assertion.title === "string",
        "invalid test identity",
      );
      identities.push(JSON.stringify([path, assertion.ancestorTitles, assertion.title]));
    }
    return path;
  });
  assert.equal(new Set(files).size, files.length, "duplicate test files");
  assert.equal(report.numTotalTests, identities.length, "wrong test count");
  assert.equal(report.numPassedTests, identities.length, "incomplete test count");
  assert.equal(report.numTotalTestSuites, report.numPassedTestSuites, "incomplete test suites");
  return { files, identities: sorted(identities) };
}
export function validateReports(reports, root, tests, reference) {
  assert.equal(reports.length, 2, "missing shard reports");
  const parsed = reports.map((report, index) => {
    const parsed = testIdentities(report, root);
    equal(
      sorted(parsed.files),
      sorted(partition(tests, index + 1)),
      "wrong shard partition or test inventory",
    );
    return parsed;
  });
  equal(sorted(parsed.flatMap(({ files }) => files)), sorted(tests), "test-file union mismatch");
  if (reference) {
    const baseline = testIdentities(reference, root);
    equal(sorted(baseline.files), sorted(tests), "reference test inventory mismatch");
    equal(
      sorted(parsed.flatMap(({ identities }) => identities)),
      baseline.identities,
      "test-case multiset mismatch",
    );
  }
}

const outputs = [
  "blob.json",
  "tests.json",
  "coverage/coverage-final.json",
  "coverage/coverage-summary.json",
];
export function readBundle(directory, expected, shard) {
  const manifest = json(resolve(directory, "manifest.json"));
  validateIdentity(manifest, expected);
  assert.equal(manifest.complete, true, "incomplete artifact");
  assert.equal(manifest.shard, shard, "wrong or duplicate shard");
  assert.equal(manifest.shards, shard === 0 ? 1 : 2, "wrong shard count");
  equal(sorted(Object.keys(manifest.outputs)), sorted(outputs), "missing output checksums");
  for (const output of outputs) {
    const bytes = readFileSync(resolve(directory, output));
    assert(bytes.length > 0, "empty output");
    assert.equal(digest(bytes), manifest.outputs[output], `corrupt output: ${output}`);
    JSON.parse(bytes.toString());
  }
  const tests = json(resolve(directory, "tests.json"));
  const coverage = json(resolve(directory, "coverage/coverage-final.json"));
  compareCoverage(
    canonicalCoverage(tests.coverageMap, expected.root, expected.sources),
    canonicalCoverage(coverage, expected.root, expected.sources),
  );
  return { tests, coverage };
}
async function context(repository, inventory) {
  const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  git("diff", "--exit-code", "HEAD", "--");
  const root = resolve(repository, "packages/lang");
  const config = (await import(pathToFileURL(resolve(root, "vite.config.ts")))).default.test;
  assert.equal(config.coverage.provider, "v8", "provider must remain v8");
  assert.equal(config.coverage.thresholds.branches, 98, "package branch threshold must remain 98");
  assert.equal(config.testTimeout, 60000, "per-test timeout changed");
  assert.equal(config.isolate ?? true, true, "file isolation changed");
  equal(config.include, ["src/**/*.test.ts"], "unexpected test include");
  const files = git("ls-files", "--", "packages/lang/src")
    .split("\n")
    .map((file) => relative(root, resolve(repository, file)));
  const sources = files.filter(
    (file) =>
      config.coverage.include.some((pattern) => matchesGlob(file, pattern)) &&
      !config.coverage.exclude.some((pattern) => matchesGlob(file, pattern)),
  );
  assert(sources.length > 0, "empty source inventory");
  const tests = files.filter((file) =>
    config.include.some((pattern) => matchesGlob(file, pattern)),
  );
  const listed = json(inventory).map((entry) =>
    packagePath(typeof entry === "string" ? entry : entry.file, root),
  );
  equal(sorted(listed), sorted(tests), "native test collection differs from tracked inventory");
  const dependencyRoot = dirname(fileURLToPath(import.meta.resolve("vite-plus/package.json")));
  const vp = json(resolve(dependencyRoot, "package.json"));
  const runner = json(
    createRequire(resolve(dependencyRoot, "package.json")).resolve(
      "@voidzero-dev/vite-plus-test/package.json",
    ),
  );
  const provider = json(fileURLToPath(import.meta.resolve("@vitest/coverage-v8/package.json")));
  const fingerprint = digest(
    [
      "packages/lang/vite.config.ts",
      "pnpm-lock.yaml",
      "package.json",
      ".github/workflows/test.yml",
      "scripts/coverage-shards/verify.mjs",
    ]
      .map((file) => `${file}\0${readFileSync(resolve(repository, file))}`)
      .join("\0"),
  );
  const sha = git("rev-parse", "HEAD");
  assert.equal(sha, process.env.GITHUB_SHA, "checkout SHA differs from workflow SHA");
  assert(/^\d+$/.test(process.env.GITHUB_RUN_ID ?? ""), "missing workflow run");
  assert(/^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? ""), "missing workflow attempt");
  return {
    schema: 1,
    package: "lang",
    sha,
    tree: git("rev-parse", "HEAD^{tree}"),
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    root,
    fingerprint,
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      vitePlus: vp.version,
      runner: runner.version,
      provider: provider.version,
    },
    sources: sorted(sources),
    tests: sorted(tests),
    policy: {
      include: config.include,
      coverageInclude: config.coverage.include,
      coverageExclude: config.coverage.exclude,
      globalSetup: config.globalSetup,
      testTimeout: config.testTimeout,
      isolate: true,
      maxWorkers: 2,
      provider: "v8",
      branches: 98,
      shardBranches: 0,
    },
  };
}
async function main() {
  const [mode, directory, inventory] = process.argv.slice(2);
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const expected = await context(repository, resolve(inventory));
  if (mode === "record") {
    const shard = Number(process.env.COVERAGE_SHARD);
    assert([0, 1, 2].includes(shard), "invalid shard");
    const report = json(resolve(directory, "tests.json"));
    const parsed = testIdentities(report, expected.root);
    equal(
      sorted(parsed.files),
      sorted(shard === 0 ? expected.tests : partition(expected.tests, shard)),
      "wrong shard partition",
    );
    compareCoverage(
      canonicalCoverage(report.coverageMap, expected.root, expected.sources),
      canonicalCoverage(
        json(resolve(directory, "coverage/coverage-final.json")),
        expected.root,
        expected.sources,
      ),
    );
    const hashes = Object.fromEntries(
      outputs.map((file) => {
        const bytes = readFileSync(resolve(directory, file));
        assert(bytes.length > 0, "empty output");
        JSON.parse(bytes.toString());
        return [file, digest(bytes)];
      }),
    );
    writeFileSync(
      resolve(directory, "manifest.json"),
      JSON.stringify(
        { ...expected, shard, shards: shard === 0 ? 1 : 2, complete: true, outputs: hashes },
        null,
        2,
      ),
    );
    return;
  }
  assert(mode === "prepare" || mode === "compare", "unknown verifier mode");
  equal(
    sorted(readdirSync(directory)),
    ["reference", "shard-1", "shard-2"],
    "missing or unexpected artifact directories",
  );
  const shards = [1, 2].map((shard) =>
    readBundle(resolve(directory, `shard-${shard}`), expected, shard),
  );
  const reference = readBundle(resolve(directory, "reference"), expected, 0);
  validateReports(
    shards.map(({ tests }) => tests),
    expected.root,
    expected.tests,
    reference.tests,
  );
  const union = combineCoverage(
    shards.map(({ coverage }) => canonicalCoverage(coverage, expected.root, expected.sources)),
  );
  compareCoverage(union, canonicalCoverage(reference.coverage, expected.root, expected.sources));
  if (mode === "prepare") {
    const destination = resolve(expected.root, "merge-blobs");
    mkdirSync(destination);
    for (const shard of [1, 2])
      copyFileSync(
        resolve(directory, `shard-${shard}/blob.json`),
        resolve(destination, `${shard}.json`),
      );
  } else {
    compareCoverage(
      canonicalCoverage(
        json(resolve(expected.root, "coverage/coverage-final.json")),
        expected.root,
        expected.sources,
      ),
      union,
    );
    const merged = testIdentities(
      json(resolve(expected.root, "coverage/merged-tests.json")),
      expected.root,
    );
    const baseline = testIdentities(reference.tests, expected.root);
    equal(sorted(merged.files), sorted(baseline.files), "merged test-file inventory differs");
    equal(merged.identities, baseline.identities, "merged test-case multiset differs");
  }
  console.log(
    `Verified complete two-shard ${mode}: ${expected.tests.length} test files, ${expected.sources.length} source files, same SHA/run/attempt.`,
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
