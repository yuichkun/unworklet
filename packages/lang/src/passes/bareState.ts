/**
 * Bare-state pass (RFC-001 S6). A bare `State<T>` reference used in a `Node<T>`
 * position auto-reads: `gain` → `gain.read()`. The write site stays explicit
 * (`gain.write(v)`), and a `State<T>` passed where a `State<T>` is expected
 * (subgraph / L1-helper argument) keeps its reference.
 *
 * Fires when the identifier's contextual type accepts a `Node` (a value position)
 * OR it's a field of an `emit`/`emitIf` payload (whose TS field type prints
 * `number` but accepts a `Node` at runtime). Operator operands are skipped — the
 * operator pass read-wraps those — EXCEPT a JS-boolean ternary's branches, which
 * the operator pass leaves untouched, so bare-state must read them.
 */

import ts from "typescript";

import { classify, isDspExpr, isSugarBinaryOperator } from "../classify.ts";

/** A direct operand of a SUGAR operator the operator pass will read-wrap. A
 * JS-boolean ternary is NOT lowered, so its branches are NOT operator operands. */
function isSugarOperatorOperand(checker: ts.TypeChecker, node: ts.Node): boolean {
  const p = node.parent;
  // Every expression node in a parsed tree has a parent (only the SourceFile root
  // does not, and that is never an operand) — a defensive guard, never taken.
  /* v8 ignore next */
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
  if (ts.isConditionalExpression(p) && isDspExpr(checker, p.condition)) {
    return p.condition === node || p.whenTrue === node || p.whenFalse === node;
  }
  return false;
}

/** A bare value of a field in an `emit(...)` / `emitIf(...)` payload object. */
function isEmitPayloadField(node: ts.Node): boolean {
  const prop = node.parent;
  if (prop === undefined || !ts.isPropertyAssignment(prop) || prop.initializer !== node)
    return false;
  const obj = prop.parent;
  // A PropertyAssignment in a parsed tree always sits inside an ObjectLiteral, so
  // `obj` is never undefined here — the `=== undefined` arm is a defensive guard.
  /* v8 ignore next */
  if (obj === undefined || !ts.isObjectLiteralExpression(obj)) return false;
  const call = obj.parent;
  return (
    call !== undefined &&
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    (call.expression.name.text === "emit" || call.expression.name.text === "emitIf")
  );
}

function read(node: ts.Expression): ts.CallExpression {
  return ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(node, "read"),
    undefined,
    [],
  );
}

/**
 * Whether a bare `State<T>` identifier reads (`gain` → `gain.read()`) at this
 * position. The single source of truth for the bare-state decision, shared by the
 * lowering pass ({@link tryBareState}) and the IDE virtual-code generator — both
 * must rewrite the exact same identifiers, or the editor would diverge from the
 * build.
 */
export function readsAsBareState(checker: ts.TypeChecker, node: ts.Node): boolean {
  if (!ts.isIdentifier(node)) return false;
  if (classify(checker, node) !== "state") return false;

  const p = node.parent;
  // Object of a property access (`gain.read` / `.write` / `.named` / `.expose`) — the handle.
  if (p !== undefined && ts.isPropertyAccessExpression(p) && p.expression === node) return false;
  // The binding being declared.
  if (p !== undefined && ts.isVariableDeclaration(p) && p.name === node) return false;
  // Operator operands are read-wrapped by the operator pass.
  if (isSugarOperatorOperand(checker, node)) return false;

  // An emit payload field accepts Node | number at runtime even though its TS
  // field type prints `number`, so a bare State there must read.
  if (isEmitPayloadField(node)) return true;

  // Otherwise only a position whose contextual type accepts a Node is a value position.
  const ctx = checker.getContextualType(node);
  if (ctx === undefined) return false;
  return checker.typeToString(ctx).includes("Node<");
}

export function tryBareState(checker: ts.TypeChecker, node: ts.Node): ts.Node | undefined {
  return readsAsBareState(checker, node) ? read(node as ts.Expression) : undefined;
}
