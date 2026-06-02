/**
 * Index-access pass (RFC-001 S5). Rewrites `[i]` sugar to the chain form, by the
 * OBJECT's type (the element-access result is a TS error against the real core
 * types — which have no index signature — so we never read its type):
 *
 *   audioIn.left[i]        → audioIn.left.at(i)        (InputChannelView)
 *   param[i]              → param.at(i)               (Param)
 *   buf[i]               → buf.read(i)               (Buffer, read)
 *   out.left[i] = v       → out.left.at(i).write(v)   (OutputChannelView, write)
 *   buf[i] = v            → buf.write(i, v)           (Buffer, write)
 *
 * A write is an assignment whose LHS is an element access; the whole assignment
 * is consumed here (so the LHS is never separately rewritten as a read).
 */

import ts from "typescript";

import { classify } from "../classify.ts";

const f = ts.factory;
const callMethod = (obj: ts.Expression, name: string, args: ts.Expression[]): ts.CallExpression =>
  f.createCallExpression(f.createPropertyAccessExpression(obj, name), undefined, args);

/**
 * Lower an index / value operand, read-wrapping a bare `State`. The operator pass
 * read-wraps operator operands, but a direct `buf[wi]` index (or `buf[i] = s`
 * value) has no operator and no contextual type for the bare-state pass to fire
 * on, so it would otherwise pass a `State` handle where a `Node` is expected.
 */
function operand(checker: ts.TypeChecker, e: ts.Expression, visit: ts.Visitor): ts.Expression {
  const visited = ts.visitNode(e, visit) as ts.Expression;
  return classify(checker, e) === "state" ? callMethod(visited, "read", []) : visited;
}

export function tryIndex(
  checker: ts.TypeChecker,
  node: ts.Node,
  visit: ts.Visitor,
): ts.Node | undefined {
  // Write: `obj[i] = v`.
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isElementAccessExpression(node.left)
  ) {
    const el = node.left;
    const cls = classify(checker, el.expression);
    const obj = ts.visitNode(el.expression, visit) as ts.Expression;
    const idx = operand(checker, el.argumentExpression, visit);
    const val = operand(checker, node.right, visit);
    if (cls === "outputChannel") return callMethod(callMethod(obj, "at", [idx]), "write", [val]);
    if (cls === "buffer") return callMethod(obj, "write", [idx, val]);
  }

  // Read: `obj[i]`.
  if (ts.isElementAccessExpression(node)) {
    const cls = classify(checker, node.expression);
    const obj = ts.visitNode(node.expression, visit) as ts.Expression;
    const idx = operand(checker, node.argumentExpression, visit);
    if (cls === "inputChannel" || cls === "param") return callMethod(obj, "at", [idx]);
    if (cls === "buffer") return callMethod(obj, "read", [idx]);
  }

  return undefined;
}
