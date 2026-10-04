import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build as bundle } from "vite-plus";
import { afterEach, expect, test } from "vite-plus/test";
import { demoBuildPlugin, prepareDemoBuild } from "./demo-build.ts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "demo-build-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), "dist\n");
  for (const name of ["core", "unplugin", "offline", "test", "lang"]) {
    mkdirSync(join(root, "packages", name, "dist"), { recursive: true });
    writeFileSync(
      join(root, "packages", name, "package.json"),
      JSON.stringify({ version: "0.4.0" }),
    );
    writeFileSync(join(root, "packages", name, "source.ts"), "export const value = 42;");
  }
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"],
    { cwd: root },
  );
  const built: string[] = [];
  const build = (name: string) => {
    built.push(name);
    writeFileSync(
      join(root, "packages", name, "dist", "index.mjs"),
      readFileSync(join(root, "packages", name, "source.ts")),
    );
  };
  return { root, built, build };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("rebuilds every workspace package in runtime embedding order and binds identity to the outputs", () => {
  const { root, built, build } = fixture();
  writeFileSync(join(root, "packages/core/dist/index.mjs"), "stale runtime");
  const result = prepareDemoBuild(root, build, {});
  expect(built).toEqual(["core", "unplugin", "offline", "test", "lang"]);
  expect(readFileSync(join(root, "packages/core/dist/index.mjs"), "utf8")).toContain("42");
  expect(result.info.version).toBe("0.4.0");
  expect(result.info.label).toContain("Workspace v0.4.0");
  expect(result.info.revision).toMatch(/^[a-f0-9]{40}$/);
  expect(result.info.artifacts).toMatch(/^[a-f0-9]{64}$/);
  expect(() => result.verify()).not.toThrow();
  writeFileSync(join(root, "packages/core/dist/index.mjs"), "stale runtime");
  expect(() => result.verify()).toThrow(/artifacts changed/);
});

test("rejects stale source both during and after the build", () => {
  const { root, build } = fixture();
  const result = prepareDemoBuild(root, build, {});
  writeFileSync(join(root, "packages/core/source.ts"), "different code");
  expect(() => result.verify()).toThrow(/source changed/);
  expect(() =>
    prepareDemoBuild(
      root,
      (name) => {
        build(name);
        if (name === "lang")
          writeFileSync(join(root, "packages/core/source.ts"), "changed during build");
      },
      {},
    ),
  ).toThrow(/source changed/);
});

test("fails on inconsistent versions, missing outputs and deployment revision mismatches", () => {
  const { root, build } = fixture();
  expect(() => prepareDemoBuild(root, build, { VERCEL_GIT_COMMIT_SHA: "0".repeat(40) })).toThrow(
    /revision/,
  );
  expect(() => prepareDemoBuild(root, () => {}, {})).toThrow(/No built artifacts/);
  writeFileSync(join(root, "packages/lang/package.json"), '{"version":"0.3.0"}');
  expect(() => prepareDemoBuild(root, build, {})).toThrow(/versions/);
});

test("marks dirty builds and previews without claiming a published release", () => {
  const { root, build } = fixture();
  writeFileSync(join(root, "untracked.ts"), "unreleased");
  const local = prepareDemoBuild(root, build, {});
  expect(local.info.label).toContain("dirty");
  const preview = prepareDemoBuild(root, build, { VERCEL_ENV: "preview" });
  expect(preview.info.label).toContain("Preview workspace v0.4.0");
  expect(preview.info.source).toBe(local.info.source);
});

async function bundleFixture(wrongResolution = false) {
  const { root, build } = fixture();
  writeFileSync(join(root, "entry.js"), "export const label = __DEMO_BUILD_LABEL__;");
  const prepared = prepareDemoBuild(
    root,
    (name) => {
      build(name);
      if (name === "lang")
        writeFileSync(join(root, "packages/lang/dist/browser.mjs"), "export const compiler = 42;");
    },
    {},
  );
  return {
    prepared,
    output: await bundle({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [demoBuildPlugin(root, prepared)],
      resolve: {
        alias: {
          "@unworklet/core": join(
            root,
            wrongResolution ? "packages/lang/dist/index.mjs" : "packages/core/dist/index.mjs",
          ),
          "@unworklet/lang/browser": join(root, "packages/lang/dist/browser.mjs"),
        },
      },
      build: {
        write: false,
        minify: false,
        lib: { entry: join(root, "entry.js"), formats: ["es"] },
      },
    }),
  };
}

test("embeds exactly the verified identity in bundled code and its build report", async () => {
  const { prepared, output } = await bundleFixture();
  const result = Array.isArray(output) ? output[0] : output;
  if (!("output" in result)) throw new Error("Expected a completed build");
  const files = result.output;
  const js = files.find((file) => file.type === "chunk");
  expect(js?.code).toContain(prepared.info.label);
  const report = files.find((file) => file.type === "asset" && file.fileName === "build-info.json");
  expect(report?.type === "asset" && JSON.parse(String(report.source))).toEqual(prepared.info);
});

test("refuses a bundle resolved from a different package artifact", async () => {
  await expect(bundleFixture(true)).rejects.toThrow(/resolution does not match/);
});
