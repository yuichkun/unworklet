/**
 * Type classification for the lowering passes. Every predicate reads the
 * `TypeChecker`'s `typeToString` of a node and matches the `@unworklet/core`
 * brand by prefix — the brands print as `Node<"f32">` / `State<"f32">` /
 * `Buffer<"u8">` / `Param` / `InputChannelView<"f32">` / `OutputChannelView<"f32">`,
 * which the program probe confirms are stable and authoritative.
 *
 * All queries run against the PRISTINE source (the nodes a `ts.transform` visitor
 * receives are original, never factory), so these are safe to call mid-transform.
 */

import ts from "typescript";

export function typeString(checker: ts.TypeChecker, node: ts.Node): string {
  return checker.typeToString(checker.getTypeAtLocation(node));
}

export type ValueClass =
  | "node"
  | "state"
  | "buffer"
  | "param"
  | "inputChannel"
  | "outputChannel"
  | "other";

export function classify(checker: ts.TypeChecker, node: ts.Node): ValueClass {
  const s = typeString(checker, node);
  if (s.startsWith("Node<")) return "node";
  if (s.startsWith("State<")) return "state";
  if (s.startsWith("Buffer<")) return "buffer";
  if (s === "Param") return "param";
  if (s.startsWith("InputChannelView<")) return "inputChannel";
  if (s.startsWith("OutputChannelView<")) return "outputChannel";
  return "other";
}

/** The sugar binary operators (arithmetic + comparison) the operator pass lowers. */
export function isSugarBinaryOperator(kind: ts.SyntaxKind): boolean {
  switch (kind) {
    case ts.SyntaxKind.PlusToken:
    case ts.SyntaxKind.MinusToken:
    case ts.SyntaxKind.AsteriskToken:
    case ts.SyntaxKind.SlashToken:
    case ts.SyntaxKind.PercentToken:
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.LessThanToken:
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.LessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return true;
    default:
      return false;
  }
}

/**
 * Whether `node` is — or will lower to — a `Node<T>`. A bare `Node` / `State` is
 * a DSP value directly; an operator expression becomes one iff an operand
 * (recursively) is a DSP value. This is the operator-dispatch predicate: a
 * `number op number` const-fold returns false and is left as build-time JS.
 */
export function isDspExpr(checker: ts.TypeChecker, node: ts.Node): boolean {
  const c = classify(checker, node);
  if (c === "node" || c === "state") return true;
  if (ts.isParenthesizedExpression(node)) return isDspExpr(checker, node.expression);
  if (ts.isBinaryExpression(node) && isSugarBinaryOperator(node.operatorToken.kind)) {
    return isDspExpr(checker, node.left) || isDspExpr(checker, node.right);
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.ExclamationToken)
  ) {
    return isDspExpr(checker, node.operand);
  }
  if (ts.isConditionalExpression(node)) return isDspExpr(checker, node.condition);
  return false;
}
