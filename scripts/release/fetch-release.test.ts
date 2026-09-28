import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { fetchRelease } from "./fetch-release.ts";

function tarballBytes(name: string, version: string): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "uwk-fetch-fixture-"));
  mkdirSync(path.join(dir, "package"));
  writeFileSync(path.join(dir, "package", "package.json"), JSON.stringify({ name, version }));
  execFileSync("tar", ["-czf", path.join(dir, "pkg.tgz"), "-C", dir, "package"]);
  return readFileSync(path.join(dir, "pkg.tgz"));
}

const sri = (bytes: Buffer) => "sha512-" + createHash("sha512").update(bytes).digest("base64");

/** A registry serving `@unworklet/core` and `@unworklet/lang` at 0.3.0, the latest release. */
function fakeRegistry(options: { tamper?: string } = {}) {
  const files = new Map<string, Buffer>();
  const versions = new Map<string, { dist: { tarball: string; integrity: string } }>();
  for (const name of ["@unworklet/core", "@unworklet/lang"]) {
    const bytes = tarballBytes(name, "0.3.0");
    const url = `https://registry.example/${name}/-/0.3.0.tgz`;
    files.set(url, name === options.tamper ? Buffer.concat([bytes, Buffer.from([0])]) : bytes);
    versions.set(`${name}/0.3.0`, { dist: { tarball: url, integrity: sri(bytes) } });
  }
  const requested: string[] = [];
  const fetch = async (url: string) => {
    requested.push(url);
    const file = files.get(url);
    if (file) return new Response(new Uint8Array(file));
    const meta = url.replace("https://registry.npmjs.org/", "");
    if (meta === "@unworklet/core") {
      return Response.json({ "dist-tags": { latest: "0.3.0" } });
    }
    const version = versions.get(meta);
    return version ? Response.json(version) : new Response("Not Found", { status: 404 });
  };
  return { fetch, requested };
}

test("the latest release is downloaded as the tarballs npm serves, verified against their integrity", async () => {
  const registry = fakeRegistry();
  const dir = mkdtempSync(path.join(tmpdir(), "uwk-fetch-"));

  const tarballs = await fetchRelease({
    names: ["@unworklet/core", "@unworklet/lang"],
    version: "latest",
    dir,
    fetch: registry.fetch,
  });

  expect(tarballs.map((t) => ({ name: t.name, version: t.version, file: t.file }))).toEqual([
    { name: "@unworklet/core", version: "0.3.0", file: "unworklet-core-0.3.0.tgz" },
    { name: "@unworklet/lang", version: "0.3.0", file: "unworklet-lang-0.3.0.tgz" },
  ]);
  for (const t of tarballs) {
    expect(sri(readFileSync(path.join(dir, t.file)))).toBe(t.integrity);
  }
  expect(JSON.parse(readFileSync(path.join(dir, "tarballs.json"), "utf8"))).toEqual(tarballs);
});

test("a tarball that does not match the integrity npm records is refused", async () => {
  const registry = fakeRegistry({ tamper: "@unworklet/lang" });
  const dir = mkdtempSync(path.join(tmpdir(), "uwk-fetch-"));

  await expect(
    fetchRelease({
      names: ["@unworklet/core", "@unworklet/lang"],
      version: "0.3.0",
      dir,
      fetch: registry.fetch,
    }),
  ).rejects.toThrow(/@unworklet\/lang@0\.3\.0/);
});

test("a package missing from the release is reported by name", async () => {
  const registry = fakeRegistry();
  const dir = mkdtempSync(path.join(tmpdir(), "uwk-fetch-"));

  await expect(
    fetchRelease({
      names: ["@unworklet/core", "@unworklet/brand-new"],
      version: "0.3.0",
      dir,
      fetch: registry.fetch,
    }),
  ).rejects.toThrow(/@unworklet\/brand-new@0\.3\.0.*404/s);
});
