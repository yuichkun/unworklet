import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { canonicalCoverage, combineCoverage, compareCoverage, validateReports } from "./verify.mjs";

void test(
  "installed runner preserves complete branch unions and rejects an untested denominator",
  { timeout: 90_000 },
  () => {
    const repository = mkdtempSync(resolve(tmpdir(), "lang-shard-runner-"));
    const root = resolve(repository, "packages/lang");
    const { packageManager } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    mkdirSync(root, { recursive: true });
    const read = (file) => JSON.parse(readFileSync(resolve(root, file), "utf8"));
    const write = (file, content) => writeFileSync(resolve(root, file), content);
    const run = (args, expected = 0) => {
      const result = spawnSync(process.env.COVERAGE_VP ?? "vp", args, {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, NO_COLOR: "1" },
      });
      assert.equal(
        result.status,
        expected,
        `${args.join(" ")}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
      );
    };
    try {
      mkdirSync(resolve(root, "src"));
      mkdirSync(resolve(repository, "node_modules/@vitest"), { recursive: true });
      for (const dependency of ["vite-plus", "@vitest/coverage-v8"])
        symlinkSync(
          dirname(fileURLToPath(import.meta.resolve(`${dependency}/package.json`))),
          resolve(repository, "node_modules", dependency),
          "dir",
        );
      write("package.json", JSON.stringify({ type: "module", private: true, packageManager }));
      writeFileSync(
        resolve(repository, "package.json"),
        JSON.stringify({ type: "module", private: true, packageManager }),
      );
      write(
        "vite.config.ts",
        `import { defineConfig } from 'vite-plus';
export default defineConfig({ test: { include: ['src/**/*.test.ts'], globalSetup: ['./setup.mjs'], testTimeout: 60000, coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/**/*.test.ts'], reporter: ['json', 'json-summary'], thresholds: { branches: 98 } } } });`,
      );
      write(
        "setup.mjs",
        "import { appendFileSync } from 'node:fs'; export default function () { appendFileSync('executed.log', 'setup\\n'); }",
      );
      write(
        "src/subject.ts",
        "export function subject(value: boolean) {\n  if (value) return 1;\n  return 2;\n}\nexport const ternary = (value: boolean) => value ? 3 : 4;\n",
      );
      for (const [name, input, output] of [
        ["a", true, 1],
        ["b", false, 2],
        ["c", true, 1],
        ["d", false, 2],
        ["e", true, 1],
      ])
        write(
          `src/${name}.test.ts`,
          `import { test, expect } from 'vite-plus/test'; import { subject, ternary } from './subject'; import { appendFileSync } from 'node:fs'; test('${name}', () => { appendFileSync('executed.log', '${name}\\n'); expect(subject(${input})).toBe(${output}); expect(ternary(${input})).toBe(${output + 2}); });`,
        );
      mkdirSync(resolve(repository, "scripts/lang-coverage"), { recursive: true });
      mkdirSync(resolve(repository, ".github/workflows"), { recursive: true });
      copyFileSync(
        fileURLToPath(new URL("verify.mjs", import.meta.url)),
        resolve(repository, "scripts/lang-coverage/verify.mjs"),
      );
      writeFileSync(
        resolve(repository, "scripts/lang-coverage/coordinator.mjs"),
        "// independent coordinator fixture identity\n",
      );
      writeFileSync(resolve(repository, "pnpm-lock.yaml"), "fixture lockfile");
      writeFileSync(resolve(repository, ".github/workflows/test.yml"), "fixture workflow");
      writeFileSync(resolve(repository, ".gitignore"), "node_modules\n");
      const git = (...args) => {
        const result = spawnSync("git", args, {
          cwd: repository,
          encoding: "utf8",
          timeout: 5_000,
        });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git("init", "-q");
      git("add", ".");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "fixture",
      );
      const identity = {
        GITHUB_SHA: git("rev-parse", "HEAD"),
        EXPECTED_HEAD_SHA: git("rev-parse", "HEAD"),
        GITHUB_EVENT_NAME: "push",
        GITHUB_REPOSITORY: "fixture/repository",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
      };
      const verify = (mode, directory, shard, expected = 0) => {
        const result = spawnSync(
          process.env.COVERAGE_VP ?? "vp",
          [
            "exec",
            "node",
            "scripts/lang-coverage/verify.mjs",
            mode,
            directory,
            "packages/lang/expected.json",
          ],
          {
            cwd: repository,
            encoding: "utf8",
            timeout: 15_000,
            env: { ...process.env, ...identity, COVERAGE_SHARD: String(shard) },
          },
        );
        assert.equal(result.status, expected, `${mode}\n${result.stdout}\n${result.stderr}`);
      };
      run(["test", "list", "--filesOnly", "--json=expected.json"]);
      const tests = [
        "src/a.test.ts",
        "src/b.test.ts",
        "src/c.test.ts",
        "src/d.test.ts",
        "src/e.test.ts",
      ];
      assert.equal(read("expected.json").length, tests.length);
      const measure = (directory, shard) =>
        run([
          "test",
          "run",
          "--coverage",
          "--maxWorkers=2",
          ...(shard ? [`--shard=${shard}/4`, "--coverage.thresholds.branches=0"] : []),
          "--reporter=blob",
          "--reporter=json",
          `--outputFile.blob=${directory}/blob.json`,
          `--outputFile.json=${directory}/tests.json`,
          `--coverage.reportsDirectory=${directory}/coverage`,
          "--coverage.reporter=json",
          "--coverage.reporter=json-summary",
        ]);
      const merge = (prefix, expected) => {
        mkdirSync(resolve(root, `${prefix}-blobs`));
        for (const shard of [1, 2, 3, 4])
          copyFileSync(
            resolve(root, `${prefix}-${shard}/blob.json`),
            resolve(root, `${prefix}-blobs/${shard}.json`),
          );
        const executed = readFileSync(resolve(root, "executed.log"), "utf8");
        run(
          [
            "test",
            "run",
            `--merge-reports=${prefix}-blobs`,
            "--coverage",
            "--reporter=json",
            `--outputFile.json=${prefix}-merged/tests.json`,
            `--coverage.reportsDirectory=${prefix}-merged/coverage`,
            "--coverage.reporter=json",
            "--coverage.reporter=json-summary",
          ],
          expected,
        );
        assert.equal(
          readFileSync(resolve(root, "executed.log"), "utf8"),
          executed,
          "merge must not run setup or tests",
        );
      };
      measure("reference");
      for (const shard of [1, 2, 3, 4]) measure(`complete-${shard}`, shard);
      merge("complete", 0);
      const map = (directory, sources) =>
        canonicalCoverage(read(`${directory}/coverage/coverage-final.json`), root, sources);
      const union = combineCoverage(
        [1, 2, 3, 4].map((shard) => map(`complete-${shard}`, ["src/subject.ts"])),
      );
      const nativeBranches = Object.values(
        read("reference/coverage/coverage-final.json")[`${root}/src/subject.ts`].branchMap,
      );
      const implicit = nativeBranches.find((branch) => branch.type === "if");
      assert.deepEqual(implicit.locations[1], { start: {}, end: {} });
      assert.equal(implicit.loc.end.column, null);
      assert.equal(
        nativeBranches.find((branch) => branch.type === "cond-expr").locations[1].end.column,
        null,
      );
      compareCoverage(union, map("reference", ["src/subject.ts"]));
      compareCoverage(union, map("complete-merged", ["src/subject.ts"]));
      validateReports(
        [1, 2, 3, 4].map((index) => read(`complete-${index}/tests.json`)),
        root,
        tests,
        read("reference/tests.json"),
      );
      assert.equal(read("complete-merged/coverage/coverage-summary.json").total.branches.pct, 100);
      mkdirSync(resolve(repository, "inputs"));
      for (const shard of [1, 2, 3, 4]) {
        const directory = `complete-${shard}`;
        const artifact = `lang-coverage-123-1-${shard}`;
        verify("record", `packages/lang/${directory}`, shard);
        const destination = resolve(repository, "inputs", artifact);
        mkdirSync(resolve(destination, "coverage"), { recursive: true });
        for (const file of [
          "manifest.json",
          "blob.json",
          "tests.json",
          "coverage/coverage-final.json",
          "coverage/coverage-summary.json",
        ])
          copyFileSync(resolve(root, directory, file), resolve(destination, file));
      }
      const manifestPath = resolve(repository, "inputs/lang-coverage-123-1-1/manifest.json");
      const sealed = readFileSync(manifestPath, "utf8");
      const stale = JSON.parse(sealed);
      stale.attempt = "0";
      writeFileSync(manifestPath, JSON.stringify(stale));
      verify("prepare", "inputs", 0, 1);
      writeFileSync(manifestPath, sealed);
      verify("prepare", "inputs", 0);
      run([
        "test",
        "run",
        "--merge-reports=merge-blobs",
        "--coverage",
        "--reporter=json",
        "--outputFile.json=coverage/merged-tests.json",
        "--coverage.reporter=json",
        "--coverage.reporter=json-summary",
      ]);
      verify("compare", "inputs", 0);
      write(
        "src/untested.ts",
        "export function untested(value: boolean) {\n  if (value) return 3;\n  return 4;\n}\nexport const untouched = (value: boolean) => value ? 5 : 6;\n",
      );
      for (const shard of [1, 2, 3, 4]) measure(`untested-${shard}`, shard);
      merge("untested", 1);
      const sources = ["src/subject.ts", "src/untested.ts"];
      const missingUnion = combineCoverage(
        [1, 2, 3, 4].map((shard) => map(`untested-${shard}`, sources)),
      );
      compareCoverage(missingUnion, map("untested-merged", sources));
      assert.deepEqual(
        missingUnion.find(({ file }) => file === "src/untested.ts").branches[0].covered,
        [false, false],
      );
      assert.equal(read("untested-merged/coverage/coverage-summary.json").total.branches.pct, 50);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  },
);
