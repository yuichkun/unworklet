import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { publishLayers, readTarball } from "./tarballs.ts";
import type { Tarball } from "./tarballs.ts";

function makeTarball(manifest: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "uwk-tarball-test-"));
  mkdirSync(path.join(dir, "package"));
  writeFileSync(path.join(dir, "package", "package.json"), JSON.stringify(manifest));
  writeFileSync(path.join(dir, "package", "index.js"), "export {};\n");
  const file = path.join(dir, "pkg.tgz");
  execFileSync("tar", ["-czf", file, "-C", dir, "package"]);
  return file;
}

test("a tarball is read as its manifest plus the sha512 integrity npm records for it", () => {
  const file = makeTarball({
    name: "@unworklet/offline",
    version: "0.4.0",
    dependencies: { wavefile: "^11.0.0" },
    peerDependencies: { "@unworklet/core": "^0.4.0" },
  });

  const tarball = readTarball(file);

  const expected = "sha512-" + createHash("sha512").update(readFileSync(file)).digest("base64");
  expect(tarball).toEqual({
    name: "@unworklet/offline",
    version: "0.4.0",
    file,
    integrity: expected,
    dependsOn: ["@unworklet/core", "wavefile"],
  });
});

function tarball(name: string, dependsOn: string[]): Tarball {
  return { name, version: "0.4.0", file: `${name}.tgz`, integrity: `sha512-${name}`, dependsOn };
}

test("packages are published in layers, each after every package it depends on", () => {
  const layers = publishLayers([
    tarball("@unworklet/unplugin", ["@unworklet/core", "@unworklet/lang", "unplugin", "vite"]),
    tarball("@unworklet/test", ["@unworklet/core", "@unworklet/offline", "vitest"]),
    tarball("@unworklet/offline", ["@unworklet/core", "wavefile"]),
    tarball("@unworklet/lang", ["@unworklet/core", "typescript"]),
    tarball("@unworklet/core", ["binaryen"]),
  ]);

  expect(layers.map((layer) => layer.map((t) => t.name))).toEqual([
    ["@unworklet/core"],
    ["@unworklet/lang", "@unworklet/offline"],
    ["@unworklet/test", "@unworklet/unplugin"],
  ]);
});

test("packages that depend on each other in a cycle are refused", () => {
  expect(() => publishLayers([tarball("a", ["b"]), tarball("b", ["a"]), tarball("c", [])])).toThrow(
    /a.*b/s,
  );
});
