import ts from "typescript";
import { expect, test } from "vite-plus/test";

import { classify } from "./classify.ts";
import { buildProgram } from "./program.ts";

test.each([
  ["a ? a : b", "node"],
  ["true ? a : b", "state"],
  ["true && a", "node"],
  ["false || a", "node"],
  ["a = b", "state"],
  ["a ?? b", "state"],
] as const)(
  "classifies a state-valued expression by the operation it performs: %s",
  (expression, expected) => {
    const { checker, sourceFile } = buildProgram(
      `let a = state.bool(false);\nconst b = state.bool(true);\nconst result = ${expression};`,
    );
    const statement = sourceFile.statements.at(-1)!;
    expect(ts.isVariableStatement(statement)).toBe(true);
    const declaration = (statement as ts.VariableStatement).declarationList.declarations[0]!;
    expect(classify(checker, declaration.initializer!)).toBe(expected);
  },
);
