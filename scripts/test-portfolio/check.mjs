import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROJECTS = {
  coverage: [
    "packages/core/vite.config.ts",
    "packages/lang/vite.config.ts",
    "packages/offline/vite.config.ts",
    "packages/test/vite.config.ts",
    "packages/unplugin/vite.config.ts",
    "packages/unplugin/devtools-ui/vite.config.ts",
  ],
  residual: [
    "packages/core/vite.browser.config.ts",
    "packages/core/vite.browser-postmessage.config.ts",
    "packages/unplugin/vite.integration.config.ts",
    "scripts/vite.config.ts",
  ],
  demo: ["examples/demo/vite.config.ts", "examples/demo/vite.browser.config.ts"],
  requiredUi: "packages/unplugin/devtools-ui/vite.config.ts",
  midi: "packages/core/vite.midi-property.config.ts",
};
export const MIDI_FILE = "packages/core/src/midiWire.property.test.ts";

const sorted = (values) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const equal = (actual, expected, label) => assert.deepEqual(actual, expected, label);
const files = (projects) => projects.flatMap((project) => project.files);

function unique(values, label) {
  equal(values.length, new Set(values).size, `duplicate ${label}`);
}

function projectKeys(projects) {
  return sorted(projects.map((project) => project.config));
}

function sameProject(actual, expected, label) {
  assert(actual && expected, `${label} missing`);
  equal(
    { ...actual, files: sorted(actual.files) },
    { ...expected, files: sorted(expected.files) },
    label,
  );
}

export function validatePortfolio(data) {
  const { root, ci, coverage, demo, native, files: checkoutFiles } = data;
  equal(
    projectKeys(root.projects),
    sorted([...PROJECTS.coverage, ...PROJECTS.residual]),
    "local root projects",
  );
  equal(
    projectKeys(ci.projects),
    sorted([...PROJECTS.residual, PROJECTS.requiredUi, PROJECTS.midi]),
    "CI projects",
  );
  equal(projectKeys(coverage), sorted(PROJECTS.coverage), "coverage projects");
  equal(projectKeys(demo), sorted(PROJECTS.demo), "demo projects");
  equal(root.globalSetup, ["test/global-setup.ts"], "local build barrier");
  equal(ci.globalSetup, root.globalSetup, "CI build barrier");
  assert.equal(ci.coverageEnabled, false, "CI residual and MIDI sample must be uninstrumented");
  for (const expected of coverage) {
    sameProject(
      root.projects.find((entry) => entry.config === expected.config),
      expected,
      "coverage collection",
    );
  }
  for (const config of PROJECTS.residual) {
    sameProject(
      ci.projects.find((entry) => entry.config === config),
      root.projects.find((entry) => entry.config === config),
      "residual project",
    );
  }
  const requiredUi = ci.projects.find((entry) => entry.config === PROJECTS.requiredUi);
  sameProject(
    requiredUi,
    coverage.find((entry) => entry.config === PROJECTS.requiredUi),
    "required UI collection and environment",
  );
  const midi = ci.projects.find((entry) => entry.config === PROJECTS.midi);
  equal(midi.files, [MIDI_FILE], "MIDI extra sample must be exactly its property suite");
  const core = coverage.find((entry) => entry.config === PROJECTS.coverage[0]);
  const { config: _midiConfig, files: _midiFiles, ...midiSettings } = midi;
  const { config: _coreConfig, files: _coreFiles, ...coreSettings } = core;
  equal(midiSettings, coreSettings, "MIDI execution settings");
  assert(core.files.includes(MIDI_FILE), "MIDI coverage sample missing");

  const primary = [
    ...coverage,
    ...ci.projects.filter(
      (entry) => entry.config !== PROJECTS.midi && entry.config !== PROJECTS.requiredUi,
    ),
    ...demo,
  ];
  for (const entry of [...root.projects, ...ci.projects, ...coverage, ...demo]) {
    assert(entry.files.length > 0, `empty project ${entry.config}`);
    unique(entry.files, `entries in ${entry.config}`);
  }
  const owned = [...files(primary), ...native];
  unique(owned, "CI ownership");
  unique(checkoutFiles, "checkout paths");
  const checked = new Set(checkoutFiles);
  const ownedSet = new Set(owned);
  equal(sorted(checkoutFiles.filter((file) => !ownedSet.has(file))), [], "unowned test files");
  equal(sorted(owned.filter((file) => !checked.has(file))), [], "unknown collector test files");
  return {
    uniqueFiles: checkoutFiles.length,
    localAggregateExecutions: files(root.projects).length,
    coverageExecutions: files(coverage).length,
    residualExecutions: files(ci.projects).length,
    demoExecutions: files(demo).length,
    nativeGuardFiles: native.length,
    intentionalExtraExecutions: requiredUi.files.length + 1,
  };
}

function relativePath(root, path) {
  const result = relative(root, path).replaceAll("\\", "/");
  assert(
    result && !result.startsWith("../") && !isAbsolute(result),
    `path outside checkout: ${path}`,
  );
  return result;
}

export async function discover(repository, config, options = {}) {
  const { createVitest } = await import("vite-plus/test/node");
  const root = options.root ?? repository;
  const previous = process.cwd();
  const previousEnv = Object.fromEntries(
    ["TEST", "VITEST", "NODE_ENV"].map((key) => [key, process.env[key]]),
  );
  let context;
  try {
    process.chdir(root);
    process.env.TEST = "true";
    process.env.VITEST = "true";
    process.env.NODE_ENV = "test";
    context = await createVitest("test", {
      root,
      config: resolve(repository, config),
      run: true,
      watch: false,
    });
    // This is the same file-only discovery used by `vp test list --filesOnly`.
    // collect() would import suites and run global setup; neither belongs here.
    const specifications = await context.globTestSpecifications();
    const projects = context.projects.map((project) => ({
      config: relativePath(repository, project.vite.config.configFile),
      files: sorted(
        specifications
          .filter((spec) => spec.project === project)
          .map((spec) => relativePath(repository, spec.moduleId)),
      ),
      environment: project.config.environment,
      pool: project.config.pool,
      browser: project.config.browser.enabled ? project.config.browser.name : null,
      globalSetup: project.config.globalSetup.map((file) => relativePath(repository, file)),
      setupFiles: project.config.setupFiles.map((file) => relativePath(repository, file)),
      testTimeout: project.config.testTimeout,
      hookTimeout: project.config.hookTimeout,
      isolate: project.config.isolate,
    }));
    return {
      globalSetup: context.config.globalSetup.map((file) => relativePath(repository, file)),
      coverageEnabled: context.config.coverage.enabled,
      projects,
    };
  } finally {
    await context?.close();
    process.chdir(previous);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function check(repository) {
  const checkoutFiles = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repository, encoding: "utf8" },
  )
    .split("\0")
    .filter(
      (file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) && existsSync(resolve(repository, file)),
    );
  const root = await discover(repository, "vite.config.ts");
  const ci = await discover(repository, "vite.ci.config.ts");
  const coverage = [];
  for (const config of PROJECTS.coverage) {
    coverage.push(
      ...(await discover(repository, config, { root: dirname(resolve(repository, config)) }))
        .projects,
    );
  }
  const demo = [];
  for (const config of PROJECTS.demo) {
    demo.push(
      ...(await discover(repository, config, { root: dirname(resolve(repository, config)) }))
        .projects,
    );
  }
  const native = checkoutFiles.filter((file) =>
    /^scripts\/test-portfolio\/[^/]+\.test\.mjs$/.test(file),
  );
  return validatePortfolio({ root, ci, coverage, demo, native, files: checkoutFiles });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  console.log(JSON.stringify(await check(repository), null, 2));
}
