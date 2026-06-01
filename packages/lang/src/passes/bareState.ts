/**
 * Bare-state pass (RFC-001 S6). A bare `State<T>` reference used in a `Node<T>`
 * position auto-reads: `gain` → `gain.read()`. The write site stays explicit
 * (`gain.write(v)`), and a `State<T>` passed where a `State<T>` is expected
 * (subgraph / L1-helper argument) keeps its reference.
 *
 * Fires only when the identifier's contextual type accepts a `Node` — that
 * distinguishes a value position (`max(gain, x)`) from a handle position
 * (`gain.write(v)` / a declaration / a `State`-typed parameter). Operator
 * operands are skipped: the operator pass read-wraps those itself.
 */

import ts from "typescript";

import { classify, isSugarBinaryOperator } from "../classify.ts";

function isOperatorOperand(node: ts.Node): boolean {
  const p = node.parent;
  if (p === undefined) return false;
  if (ts.isBinaryExpression(p) && isSugarBinaryOperator(p.operatorToken.kind)) {
    return p.left === node || p.right === node;
  }
  if (
    ts.isPrefixUnaryExpression(p) &&
    (p.operator === ts.SyntaxKind.MinusToken || p.operator === ts.SyntaxKind.ExclamationToken)
  ) {
    return p.operand === node;
  }
  if (ts.isConditionalExpression(p)) {
    return p.condition === node || p.whenTrue === node || p.whenFalse === node;
  }
  return false;
}

export function tryBareState(checker: ts.TypeChecker, node: ts.Node): ts.Node | undefined {
  if (!ts.isIdentifier(node)) return undefined;
  if (classify(checker, node) !== "state") return undefined;

  const p = node.parent;
  // Object of a property access (`gain.read` / `.write` / `.named` / `.expose`) — the handle.
  if (p !== undefined && ts.isPropertyAccessExpression(p) && p.expression === node)
    return undefined;
  // The binding being declared.
  if (p !== undefined && ts.isVariableDeclaration(p) && p.name === node) return undefined;
  // Operator operands are read-wrapped by the operator pass.
  if (isOperatorOperand(node)) return undefined;

  // Only a position whose contextual type accepts a Node is a value position.
  const ctx = checker.getContextualType(node);
  if (ctx === undefined) return undefined;
  if (!checker.typeToString(ctx).includes("Node<")) return undefined;

  return ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(node, "read"),
    undefined,
    [],
  );
}
