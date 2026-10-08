import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { expect, test } from "vite-plus/test";

import { generateVirtualCode } from "./ide/virtualCode.ts";
import { lower } from "./lower.ts";
import { buildProgram, emptySnapshot, type BuiltProgram } from "./program.ts";

function declarationType(built: BuiltProgram, name = "value"): string {
  let declaration: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      declaration = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(built.sourceFile);
  expect(declaration).toBeDefined();
  return built.checker.typeToString(built.checker.getTypeAtLocation(declaration!.name));
}

test("a null-aware view has an independent checker and cannot contaminate the original", () => {
  const original = buildProgram("declare const value: number | undefined;");
  expect(declarationType(original)).toBe("number");
  const precise = original.withStrictNullChecks();
  expect(precise.program).not.toBe(original.program);
  expect(precise.checker).not.toBe(original.checker);
  expect(precise.sourceFile).toBe(original.sourceFile);
  expect(precise.program.getCompilerOptions()).toEqual({
    ...original.program.getCompilerOptions(),
    strictNullChecks: true,
  });
  expect(declarationType(precise)).toBe("number | undefined");
  expect(declarationType(original)).toBe("number");
  const repeated = original.withStrictNullChecks();
  expect(declarationType(repeated)).toBe("number | undefined");
  expect(declarationType(original)).toBe("number");
  expect(original.program.getCompilerOptions().strictNullChecks).toBe(false);
});

test("the null-aware view reuses every unchanged source AST", () => {
  const original = buildProgram("declare const value: number | undefined;");
  const precise = original.withStrictNullChecks();
  expect(precise.program.getSourceFiles()).toHaveLength(original.program.getSourceFiles().length);
  for (const sourceFile of original.program.getSourceFiles()) {
    expect(precise.program.getSourceFile(sourceFile.fileName), sourceFile.fileName).toBe(
      sourceFile,
    );
  }
});

test("source changes and source roots have separate reusable graphs", () => {
  const dir = mkdtempSync(path.join(import.meta.dirname, ".program-reuse-"));
  try {
    const number = buildProgram("declare const value: number | undefined;", {
      sourcePath: path.join(dir, "number.uwk.ts"),
    });
    const string = buildProgram("declare const value: string | undefined;", {
      sourcePath: path.join(dir, "number.uwk.ts"),
    });
    const alternateRoot = buildProgram("declare const value: boolean | undefined;", {
      sourcePath: path.join(dir, "nested", "value.uwk.ts"),
    });
    expect(string.sourceFile).not.toBe(number.sourceFile);
    expect(alternateRoot.sourceFile.fileName).not.toBe(number.sourceFile.fileName);
    expect(declarationType(number.withStrictNullChecks())).toBe("number | undefined");
    expect(declarationType(string.withStrictNullChecks())).toBe("string | undefined");
    expect(declarationType(alternateRoot.withStrictNullChecks())).toBe("boolean | undefined");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disk dependency revisions do not leak between source-scoped views", () => {
  const dir = mkdtempSync(path.join(import.meta.dirname, ".program-reuse-"));
  const helper = path.join(dir, "helper.ts");
  const source = 'import { external } from "./helper.ts"; const value = external;';
  const options = { sourcePath: path.join(dir, "entry.uwk.ts") };
  try {
    writeFileSync(helper, "export declare const external: number | undefined;");
    const number = buildProgram(source, options);
    writeFileSync(helper, "export declare const external: string | undefined;");
    const string = buildProgram(source, options);
    expect(number.program.getSourceFile(helper)).not.toBe(string.program.getSourceFile(helper));
    expect(declarationType(number.withStrictNullChecks())).toBe("number | undefined");
    expect(declarationType(string.withStrictNullChecks())).toBe("string | undefined");
    expect(declarationType(number)).toBe("number");
    expect(declarationType(string)).toBe("string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot revisions keep their own dependency ASTs and types", () => {
  const dir = mkdtempSync(path.join(import.meta.dirname, ".program-reuse-"));
  const helper = path.join(dir, "helper.ts");
  const source = 'import { external } from "./helper.ts"; const value = external;';
  try {
    writeFileSync(helper, "export declare const external: number | undefined;");
    const snapshot = emptySnapshot();
    const recorded = buildProgram(source, {
      sourcePath: path.join(dir, "entry.uwk.ts"),
      record: snapshot,
    });
    expect(declarationType(recorded)).toBe("number");
    const revisedSnapshot = structuredClone(snapshot);
    revisedSnapshot.sourceTexts[helper] = "export declare const external: string | undefined;";
    const number = buildProgram(source, { snapshot });
    const string = buildProgram(source, { snapshot: revisedSnapshot });
    expect(declarationType(number.withStrictNullChecks())).toBe("number | undefined");
    expect(declarationType(string.withStrictNullChecks())).toBe("string | undefined");
    expect(number.program.getSourceFile(helper)).not.toBe(string.program.getSourceFile(helper));
    expect(declarationType(number)).toBe("number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repeated runtime lowering and virtual mappings remain stable around nullable arguments", () => {
  const source = `declare const maybe: number | undefined;
const sg = defineSubgraph((a: Node<"f64">, b?: Node<"f64">) => ({ tick: () => a }));
const voice = instantiate(sg, 0.2, maybe);
process(() => {});`;
  const runtime = lower(source);
  const virtual = generateVirtualCode(source);
  expect(runtime).toContain("instantiate(sg, f64(0.2), maybe)");
  expect(virtual.code).toContain("instantiate(sg, f64(0.2), maybe)");
  expect(lower(source)).toBe(runtime);
  expect(generateVirtualCode(source)).toEqual(virtual);
});
