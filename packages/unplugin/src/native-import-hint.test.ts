/**
 * Contract of `withExtensionHint` (issue #41): the build path's native
 * `import()` of a processor module fails with a raw `ERR_MODULE_NOT_FOUND`
 * when a relative import omits its file extension — Vite-idiomatic in the rest
 * of the app, invalid under Node ESM resolution. The wrap must state the rule
 * and name the exact suffix when the sibling file exists, and must pass every
 * other error through untouched.
 *
 * Tested as a unit because the failure cannot be reproduced end-to-end inside
 * the test runtime: the module runner intercepts dynamic `import()` and
 * resolves specifiers Vite-style, so the native resolution never runs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, test } from "vite-plus/test";

import { withExtensionHint } from "./native-import-hint.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const nodeNotFound = (missing: string, importer: string): Error => {
  const err = new Error(`Cannot find module '${missing}' imported from ${importer}`) as Error & {
    code: string;
  };
  err.code = "ERR_MODULE_NOT_FOUND";
  return err;
};

test("an extensionless miss whose .ts sibling exists is rewrapped with the exact suffix to write", () => {
  dir = mkdtempSync(path.join(tmpdir(), "uwk-hint-"));
  writeFileSync(path.join(dir, "tables.ts"), "export const TABLE = [1];\n");
  const missing = path.join(dir, "tables");
  const wrapped = withExtensionHint(
    nodeNotFound(missing, path.join(dir, "my.processor.ts")),
  ) as Error;
  expect(wrapped.message).toContain("explicit file extension");
  expect(wrapped.message).toContain(`${missing}.ts`);
  expect(wrapped.message).toContain('"./tables.ts"');
  expect(wrapped.cause).toBeInstanceOf(Error);
});

test("a nested extensionless miss keeps its directories in the suggested specifier", () => {
  // `path.basename` alone turned `./helpers/tables` into `./tables.ts`, which
  // names a different file or none. Reported by @codex on #48.
  dir = mkdtempSync(path.join(tmpdir(), "uwk-hint-"));
  mkdirSync(path.join(dir, "helpers"));
  writeFileSync(path.join(dir, "helpers", "tables.ts"), "export const TABLE = [1];\n");
  const missing = path.join(dir, "helpers", "tables");
  const wrapped = withExtensionHint(
    nodeNotFound(missing, path.join(dir, "my.processor.ts")),
  ) as Error;
  expect(wrapped.message).toContain('"./helpers/tables.ts"');
  expect(wrapped.message).not.toContain('"./tables.ts"');
});

test("a file-URL importer is understood the same as a path", () => {
  dir = mkdtempSync(path.join(tmpdir(), "uwk-hint-"));
  mkdirSync(path.join(dir, "helpers"));
  writeFileSync(path.join(dir, "helpers", "tables.ts"), "export const TABLE = [1];\n");
  const missing = path.join(dir, "helpers", "tables");
  const wrapped = withExtensionHint(
    nodeNotFound(missing, pathToFileURL(path.join(dir, "my.processor.ts")).href),
  ) as Error;
  expect(wrapped.message).toContain('"./helpers/tables.ts"');
});

test("an extensionless miss with no matching sibling still states the rule and the generic fix", () => {
  const wrapped = withExtensionHint(
    nodeNotFound("/nowhere/at/all/tables", "/src/my.processor.ts"),
  ) as Error;
  expect(wrapped.message).toContain("explicit file extension");
  expect(wrapped.message).toContain('"./name.ts"');
});

test("a genuinely missing file WITH an extension passes through untouched", () => {
  const original = nodeNotFound("/src/tables.ts", "/src/my.processor.ts");
  expect(withExtensionHint(original)).toBe(original);
});

test("unrelated errors pass through untouched", () => {
  const boom = new Error("boom");
  expect(withExtensionHint(boom)).toBe(boom);
  expect(withExtensionHint(undefined)).toBe(undefined);
  const otherCode = new Error("nope") as Error & { code: string };
  otherCode.code = "ERR_UNSUPPORTED_DIR_IMPORT";
  expect(withExtensionHint(otherCode)).toBe(otherCode);
});
