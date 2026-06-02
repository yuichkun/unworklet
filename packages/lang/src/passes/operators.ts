/**
 * Operator pass (RFC-001 S1 / S2 / S3 / S4). Rewrites infix operators on DSP
 * values to the chain-primitive calls they desugar to:
 *
 *   a + b      → add(a, b)        a == b     → eq(a, b)        -a   → neg(a)
 *   a - b      → sub(a, b)        a != b     → not(eq(a, b))   !b   → not(b)
 *   a * b / %  → mul / div / mod  a < > <= >=→ lt / gt / lte / gte
 *   c ? x : y  → select(c, x, y)
 *
 * Dispatch is type-directed (`isDspExpr`): an operator lowers iff an operand is —
 * or lowers to — a `Node<T>`. A bare `State<T>` operand is wrapped in `.read()`;
 * `number op number` (build-time constants like `Math.round(SR * 0.3)`) is left
 * untouched. Operands are recursed through the shared visitor (bottom-up, so
 * precedence is preserved); this pass owns the read-wrap of its own operands, so
 * the bare-state pass skips operator operands to avoid double-wrapping.
 */

import ts from "typescript";

import { classify, isDspExpr, isSugarBinaryOperator } from "../classify.ts";

export const BINARY_FN: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.PlusToken]: "add",
  [ts.SyntaxKind.MinusToken]: "sub",
  [ts.SyntaxKind.AsteriskToken]: "mul",
  [ts.SyntaxKind.SlashToken]: "div",
  [ts.SyntaxKind.PercentToken]: "mod",
  [ts.SyntaxKind.LessThanToken]: "lt",
  [ts.SyntaxKind.GreaterThanToken]: "gt",
  [ts.SyntaxKind.LessThanEqualsToken]: "lte",
  [ts.SyntaxKind.GreaterThanEqualsToken]: "gte",
  [ts.SyntaxKind.EqualsEqualsToken]: "eq",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "eq",
};
export const NEGATED_EQ = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

function call(fn: string, args: ts.Expression[]): ts.CallExpression {
  return ts.factory.createCallExpression(ts.factory.createIdentifier(fn), undefined, args);
}

/** Wrap a bare `State<T>` operand in `.read()`; leave Nodes / numbers as-is. */
function readWrap(expr: ts.Expression, isState: boolean): ts.Expression {
  if (!isState) return expr;
  return ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(expr, "read"),
    undefined,
    [],
  );
}

/** Lower a sugar operator node, or return undefined if this isn't one. */
export function tryOperator(
  checker: ts.TypeChecker,
  node: ts.Node,
  visit: ts.Visitor,
): ts.Node | undefined {
  const operand = (e: ts.Expression): ts.Expression =>
    readWrap(ts.visitNode(e, visit) as ts.Expression, classify(checker, e) === "state");

  if (ts.isBinaryExpression(node) && isSugarBinaryOperator(node.operatorToken.kind)) {
    if (isDspExpr(checker, node.left) || isDspExpr(checker, node.right)) {
      const left = operand(node.left);
      const right = operand(node.right);
      if (NEGATED_EQ.has(node.operatorToken.kind)) return call("not", [call("eq", [left, right])]);
      return call(BINARY_FN[node.operatorToken.kind]!, [left, right]);
    }
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken ||
      node.operator === ts.SyntaxKind.ExclamationToken) &&
    isDspExpr(checker, node.operand)
  ) {
    const x = operand(node.operand);
    return call(node.operator === ts.SyntaxKind.MinusToken ? "neg" : "not", [x]);
  }
  if (ts.isConditionalExpression(node) && isDspExpr(checker, node.condition)) {
    return call("select", [
      operand(node.condition),
      operand(node.whenTrue),
      operand(node.whenFalse),
    ]);
  }
  return undefined;
}
