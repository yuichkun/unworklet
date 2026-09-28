import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";
import { parse } from "yaml";

import { assembleDemo, tarballFingerprint, writeVercelOutput } from "./demo.ts";
import type { Tarball } from "./tarballs.ts";

function write(root: string, file: string, content: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
}

const WORKSPACE = `packages:
  - "packages/**"
  - "examples/*"

catalogMode: prefer

catalog:
  vue: ^3.5.34
  vite-plus: 0.1.24
  vite: npm:@voidzero-dev/vite-plus-core@0.1.24
overrides:
  vite: "catalog:"
peerDependencyRules:
  allowAny:
    - vite
allowBuilds:
  esbuild: true
`;

function fixtureRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "uwk-demo-repo-"));
  write(repo, "pnpm-workspace.yaml", WORKSPACE);
  write(
    repo,
    "package.json",
    JSON.stringify({
      name: "root",
      private: true,
      devDependencies: { "vite-plus": "catalog:" },
      packageManager: "pnpm@11.3.0",
    }),
  );
  write(
    repo,
    "examples/demo/package.json",
    JSON.stringify({
      name: "@unworklet-examples/demo",
      private: true,
      dependencies: { "@unworklet/core": "workspace:*", vue: "catalog:" },
      devDependencies: { "@unworklet/unplugin": "workspace:*" },
    }),
  );
  write(repo, "examples/demo/index.html", "<!doctype html>\n");
  write(repo, "examples/demo/src/main.ts", "export {};\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  write(repo, "examples/demo/dist/stale.js", "leftover build output\n");
  return repo;
}

const TARBALLS: Tarball[] = [
  {
    name: "@unworklet/core",
    version: "0.4.0",
    file: "unworklet-core-0.4.0.tgz",
    integrity: "sha512-core",
    dependsOn: [],
  },
  {
    name: "@unworklet/unplugin",
    version: "0.4.0",
    file: "unworklet-unplugin-0.4.0.tgz",
    integrity: "sha512-unplugin",
    dependsOn: ["@unworklet/core"],
  },
];

test("the candidate demo is the tracked demo source, installing @unworklet/* from the tarballs", () => {
  const repo = fixtureRepo();
  const out = path.join(mkdtempSync(path.join(tmpdir(), "uwk-demo-out-")), "demo");

  assembleDemo({ repo, tarballDir: "/release/tarballs", tarballs: TARBALLS, out });

  expect(readFileSync(path.join(out, "src/main.ts"), "utf8")).toBe("export {};\n");
  expect(existsSync(path.join(out, "index.html"))).toBe(true);
  expect(existsSync(path.join(out, "dist"))).toBe(false);

  expect(JSON.parse(readFileSync(path.join(out, "package.json"), "utf8"))).toEqual({
    name: "@unworklet-examples/demo",
    private: true,
    dependencies: {
      "@unworklet/core": "file:/release/tarballs/unworklet-core-0.4.0.tgz",
      vue: "catalog:",
    },
    devDependencies: {
      "@unworklet/unplugin": "file:/release/tarballs/unworklet-unplugin-0.4.0.tgz",
      "vite-plus": "catalog:",
    },
    packageManager: "pnpm@11.3.0",
  });
});

test("the candidate demo keeps the repository's catalog and settings, and pins every @unworklet package to its tarball", () => {
  const repo = fixtureRepo();
  const out = path.join(mkdtempSync(path.join(tmpdir(), "uwk-demo-out-")), "demo");

  assembleDemo({ repo, tarballDir: "/release/tarballs", tarballs: TARBALLS, out });

  expect(parse(readFileSync(path.join(out, "pnpm-workspace.yaml"), "utf8"))).toEqual({
    catalogMode: "prefer",
    catalog: {
      vue: "^3.5.34",
      "vite-plus": "0.1.24",
      vite: "npm:@voidzero-dev/vite-plus-core@0.1.24",
    },
    overrides: {
      vite: "catalog:",
      "@unworklet/core": "file:/release/tarballs/unworklet-core-0.4.0.tgz",
      "@unworklet/unplugin": "file:/release/tarballs/unworklet-unplugin-0.4.0.tgz",
    },
    peerDependencyRules: { allowAny: ["vite"] },
    allowBuilds: { esbuild: true },
  });
});

test("the Vercel output serves the built demo with the headers vercel.json declares", () => {
  const root = mkdtempSync(path.join(tmpdir(), "uwk-vercel-"));
  write(root, "dist/index.html", "<!doctype html>\n");
  write(root, "dist/assets/app.js", "console.log(1);\n");
  write(
    root,
    "vercel.json",
    JSON.stringify({
      outputDirectory: "examples/demo/dist",
      headers: [
        {
          source: "/(.*)",
          headers: [
            { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
            { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          ],
        },
      ],
    }),
  );

  writeVercelOutput({
    dist: path.join(root, "dist"),
    vercelJson: path.join(root, "vercel.json"),
    out: path.join(root, "deploy"),
  });

  const output = path.join(root, "deploy", ".vercel", "output");
  expect(readFileSync(path.join(output, "static/index.html"), "utf8")).toBe("<!doctype html>\n");
  expect(readFileSync(path.join(output, "static/assets/app.js"), "utf8")).toBe("console.log(1);\n");
  expect(JSON.parse(readFileSync(path.join(output, "config.json"), "utf8"))).toEqual({
    version: 3,
    routes: [
      {
        src: "/(.*)",
        headers: {
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
        },
        continue: true,
      },
    ],
  });
});

test("the tarballs' fingerprint names the set of packages the demo was built from", () => {
  const fingerprint = tarballFingerprint(TARBALLS);

  expect(fingerprint).toMatch(/^[0-9a-f]{8}$/);
  expect(tarballFingerprint([...TARBALLS].reverse())).toBe(fingerprint);
  expect(
    tarballFingerprint([{ ...TARBALLS[0]!, integrity: "sha512-other" }, TARBALLS[1]!]),
  ).not.toBe(fingerprint);
});
