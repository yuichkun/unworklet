/**
 * The combined type-directed sugar transformer. All passes share ONE `ts.transform`
 * walk because every type query must hit the original `SourceFile` the checker is
 * bound to (the nodes a visitor receives are original, never factory). Each pass
 * is a `try*` handler that returns its rewrite or undefined; the visitor tries them
 * in order, then recurses. Bottom-up recursion preserves operator precedence.
 */

import ts from "typescript";

import { tryBareState } from "./bareState.ts";
import { tryIndex } from "./index.ts";
import { tryOperator } from "./operators.ts";

export function sugarTransformer(checker: ts.TypeChecker): ts.TransformerFactory<ts.SourceFile> {
  return (context) => {
    const visit: ts.Visitor = (node) => {
      const lowered = tryOperator(checker, node, visit);
      if (lowered !== undefined) return lowered;
      const indexed = tryIndex(checker, node, visit);
      if (indexed !== undefined) return indexed;
      const read = tryBareState(checker, node);
      if (read !== undefined) return read;
      return ts.visitEachChild(node, visit, context);
    };
    return (sf) => ts.visitNode(sf, visit) as ts.SourceFile;
  };
}
