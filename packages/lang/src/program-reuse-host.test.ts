import ts from "typescript";
import { expect, test, vi } from "vite-plus/test";

import { buildProgram } from "./program.ts";

vi.mock("typescript", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof ts }>();
  return {
    ...actual,
    default: { ...actual.default, createProgram: vi.fn(actual.default.createProgram) },
  };
});

test("source reuse obeys TypeScript's explicit fresh-parse request", () => {
  const original = buildProgram("declare const value: number | undefined;");
  const precise = original.withStrictNullChecks();
  const call = vi.mocked(ts.createProgram).mock.calls.at(-1)! as unknown[];
  const host = call[2] as ts.CompilerHost;
  expect(call[3]).toBe(original.program);
  expect(host.getSourceFile(original.sourceFile.fileName, ts.ScriptTarget.ESNext)).toBe(
    original.sourceFile,
  );
  const fresh = host.getSourceFile(
    original.sourceFile.fileName,
    ts.ScriptTarget.ESNext,
    undefined,
    true,
  );
  expect(fresh).not.toBe(original.sourceFile);
  expect(fresh?.text).toBe(original.sourceFile.text);
  expect(precise.sourceFile).toBe(original.sourceFile);
  expect(
    host.getSourceFile(`${original.sourceFile.fileName}.missing.ts`, ts.ScriptTarget.ESNext),
  ).toBeUndefined();
});
