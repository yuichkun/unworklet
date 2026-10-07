import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePortfolio, PROJECTS, MIDI_FILE } from "./check.mjs";

const project = (config, files, overrides = {}) => ({
  config,
  files,
  environment: "node",
  pool: "forks",
  browser: null,
  globalSetup: [],
  setupFiles: [],
  ...overrides,
});

function fixture() {
  const coverage = PROJECTS.coverage.map((config, index) =>
    project(
      config,
      index === 0 ? [MIDI_FILE, "packages/core/src/unit.test.ts"] : [`owner-${index}.test.ts`],
    ),
  );
  const residual = PROJECTS.residual.map((config, index) =>
    project(config, [`residual-${index}.test.ts`], index < 2 ? { browser: "chromium" } : {}),
  );
  const demo = PROJECTS.demo.map((config, index) => project(config, [`demo-${index}.test.ts`]));
  const midi = project(PROJECTS.midi, [MIDI_FILE]);
  const native = ["scripts/test-portfolio/verify.test.mjs"];
  return {
    root: { globalSetup: ["test/global-setup.ts"], projects: [...coverage, ...residual] },
    ci: {
      globalSetup: ["test/global-setup.ts"],
      coverageEnabled: false,
      projects: [...residual, coverage.at(-1), midi],
    },
    coverage,
    demo,
    native,
    files: [...coverage, ...residual, ...demo].flatMap((item) => item.files).concat(native),
  };
}

void test("every execution realm retains an owner with required UI and MIDI intentional repeats", () => {
  const data = fixture();
  const result = validatePortfolio(data);
  assert.equal(result.uniqueFiles, data.files.length);
  assert.equal(result.intentionalExtraExecutions, data.coverage.at(-1).files.length + 1);
});

void test("required Vitest retains DevTools assertions even when optional UI coverage owns them", () => {
  const data = fixture();
  data.ci.projects = data.ci.projects.filter((entry) => entry.config !== PROJECTS.coverage.at(-1));
  assert.throws(() => validatePortfolio(data), /CI projects/);
  const changed = fixture();
  const index = changed.ci.projects.findIndex((entry) => entry.config === PROJECTS.coverage.at(-1));
  changed.ci.projects[index] = { ...changed.ci.projects[index], environment: "node-other" };
  assert.throws(() => validatePortfolio(changed), /required UI/);
});

void test("a new owned file is accepted without updating a frozen manifest", () => {
  const data = fixture();
  data.coverage[0].files.push("packages/core/src/new.test.ts");
  data.files.push("packages/core/src/new.test.ts");
  assert.doesNotThrow(() => validatePortfolio(data));
});

void test("a new orphan file fails even when all established projects still exist", () => {
  const data = fixture();
  data.files.push("packages/new/src/orphan.test.ts");
  assert.throws(() => validatePortfolio(data), /unowned/);
});

void test("coverage narrowing cannot silently remove a root assertion", () => {
  const data = fixture();
  data.coverage[0] = { ...data.coverage[0], files: [MIDI_FILE] };
  assert.throws(() => validatePortfolio(data), /coverage collection/);
});

void test("root narrowing cannot be hidden by coverage still finding the file", () => {
  const data = fixture();
  data.root.projects[0] = { ...data.root.projects[0], files: [MIDI_FILE] };
  assert.throws(() => validatePortfolio(data), /coverage collection/);
});

void test("dropping postMessage fails even if SAB directly collects its wrapper file", () => {
  const data = fixture();
  data.ci.projects = data.ci.projects.filter((entry) => entry.config !== PROJECTS.residual[1]);
  data.ci.projects[0] = {
    ...data.ci.projects[0],
    files: [...data.ci.projects[0].files, "residual-1.test.ts"],
  };
  assert.throws(() => validatePortfolio(data), /CI projects/);
});

void test("browser instance, environment, setup and pool drift are rejected", () => {
  for (const change of [
    { browser: null },
    { environment: "happy-dom" },
    { pool: "threads" },
    { setupFiles: ["unexpected.ts"] },
  ]) {
    const data = fixture();
    data.ci.projects[0] = { ...data.ci.projects[0], ...change };
    assert.throws(() => validatePortfolio(data), /residual project/);
  }
});

void test("the root build barrier and full local project list remain mandatory", () => {
  const data = fixture();
  data.ci.globalSetup = [];
  assert.throws(() => validatePortfolio(data), /build barrier/);
  const removed = fixture();
  removed.root.projects.pop();
  assert.throws(() => validatePortfolio(removed), /local root projects/);
});

void test("MIDI resampling cannot disappear or broaden into ordinary core repeats", () => {
  for (const files of [[], [MIDI_FILE, "packages/core/src/unit.test.ts"]]) {
    const data = fixture();
    data.ci.projects.at(-1).files = files;
    assert.throws(() => validatePortfolio(data), /MIDI/);
  }
  const instrumented = fixture();
  instrumented.ci.coverageEnabled = true;
  assert.throws(() => validatePortfolio(instrumented), /uninstrumented/);
});

void test("accidental duplicate ownership and unknown native guard files fail", () => {
  const duplicate = fixture();
  duplicate.demo[0].files.push("packages/core/src/unit.test.ts");
  assert.throws(() => validatePortfolio(duplicate), /duplicate/);
  const native = fixture();
  native.files.push("scripts/unowned.test.mjs");
  assert.throws(() => validatePortfolio(native), /unowned/);
});

void test("invented collector paths and duplicate entries are rejected", () => {
  const extra = fixture();
  extra.demo[0].files.push("not-in-checkout.test.ts");
  assert.throws(() => validatePortfolio(extra), /unknown/);
  const duplicate = fixture();
  duplicate.coverage[0].files.push(MIDI_FILE);
  assert.throws(() => validatePortfolio(duplicate), /duplicate/);
});
