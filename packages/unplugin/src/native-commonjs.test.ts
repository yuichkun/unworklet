import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { DevEnvironment } from "vite-plus";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { isCommonJsFile, preserveNativeCommonJs } from "./native-commonjs.ts";

const roots: string[] = [];
const fixture = async (source: string, manifest?: Record<string, unknown>): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "uwk-cjs-"));
  roots.push(root);
  if (manifest) await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  const file = path.join(root, "helper.js");
  await writeFile(file, source);
  return file;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("explicit CommonJS and ESM suffixes keep their format", async () => {
  expect(await isCommonJsFile("/any/helper.cjs")).toBe(true);
  expect(await isCommonJsFile("/any/helper.mjs")).toBe(false);
  expect(await isCommonJsFile("/any/helper.ts")).toBe(false);
});

test("the nearest explicit package type controls .js", async () => {
  expect(await isCommonJsFile(await fixture("exports.value = 1", { type: "commonjs" }))).toBe(true);
  expect(await isCommonJsFile(await fixture("exports.value = 1", { type: "module" }))).toBe(false);
});

test("a UTF-8 BOM in package.json preserves the native package type", async () => {
  const file = await fixture("exports.value = 1", {});
  await writeFile(path.join(path.dirname(file), "package.json"), '\uFEFF{"type":"commonjs"}');
  expect(await isCommonJsFile(file)).toBe(true);
});

test.each([
  "export const value = 1",
  'import "node:path"',
  "import.meta.url",
  "await Promise.resolve()",
  "const require = 1",
])("ambiguous .js with ESM syntax stays fresh: %s", async (source) => {
  expect(await isCommonJsFile(await fixture(source, {}))).toBe(false);
});

test.each([
  "exports.value = 1",
  "#!/usr/bin/env node\nmodule.exports = 1",
  "return;",
  'void import("node:path")',
  'throw new Error("classification must not execute this")',
])("ambiguous CommonJS is parsed without execution: %s", async (source) => {
  expect(await isCommonJsFile(await fixture(source))).toBe(true);
});

test("a typeless package boundary does not inherit an outer module type", async () => {
  const outer = path.dirname(await fixture("", { type: "module" }));
  const inner = path.join(outer, "inner");
  await mkdir(inner);
  await writeFile(path.join(inner, "package.json"), "{}");
  const file = path.join(inner, "helper.js");
  await writeFile(file, "module.exports = 1");
  expect(await isCommonJsFile(file)).toBe(true);
});

test("node_modules is a package-scope boundary", async () => {
  const outer = path.dirname(await fixture("", { type: "module" }));
  const inner = path.join(outer, "node_modules", "local");
  await mkdir(inner, { recursive: true });
  const file = path.join(inner, "helper.js");
  await writeFile(file, "module.exports = 1");
  expect(await isCommonJsFile(file)).toBe(true);
});

test("invalid package data and missing source retain their errors", async () => {
  const file = await fixture("", {});
  await writeFile(path.join(path.dirname(file), "package.json"), "{");
  await expect(isCommonJsFile(file)).rejects.toBeInstanceOf(SyntaxError);
  await writeFile(path.join(path.dirname(file), "package.json"), "{}");
  await rm(file);
  await expect(isCommonJsFile(file)).rejects.toMatchObject({ code: "ENOENT" });
});

test("the loader delegates unresolved, virtual, and ESM modules unchanged", async () => {
  const result = { code: "export const x = 1;" };
  const fetchModule = vi.fn().mockResolvedValue(result);
  const resolveId = vi.fn();
  const environment = { fetchModule, pluginContainer: { resolveId } } as unknown as DevEnvironment;
  preserveNativeCommonJs(environment);
  for (const resolution of [null, { id: "\0virtual" }, { id: "/any/helper.mjs" }]) {
    resolveId.mockResolvedValue(resolution);
    await expect(environment.fetchModule("request", "importer", { cached: true })).resolves.toBe(
      result,
    );
    expect(fetchModule).toHaveBeenLastCalledWith("request", "importer", { cached: true });
  }
});

test.each(["path", "file-url"])("CommonJS %s reaches Node with its query intact", async (kind) => {
  const file = path.join(path.dirname(await fixture("")), "helper.cjs");
  const url = pathToFileURL(file).href + "?rev=1#part";
  const id = kind === "path" ? `${file}?rev=1#part` : url;
  const fetchModule = vi.fn();
  const environment = {
    fetchModule,
    pluginContainer: { resolveId: vi.fn().mockResolvedValue({ id }) },
  } as unknown as DevEnvironment;
  preserveNativeCommonJs(environment);
  await expect(environment.fetchModule(id)).resolves.toEqual({
    externalize: url,
    type: "commonjs",
  });
  expect(fetchModule).not.toHaveBeenCalled();
});
