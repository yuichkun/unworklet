/**
 * `$prev` pass (RFC-001 S8) — the one structural pass. Inside a `defineSubgraph`
 * method, `$prev` is the method's previous-call return value. For each method
 * that uses it:
 *
 *   1. inject an anonymous `const __prev_N = state.<T>(0)` into the subgraph's
 *      declaration scope (the factory arrow's body),
 *   2. rewrite `$prev` → `__prev_N.read()`,
 *   3. wrap the return: `(p) => e` → `(p) => { const __r = e; __prev_N.write(__r); return __r; }`.
 *
 * The slot type T is read from the method's first `Node<T>` PARAMETER (RFC O4) —
 * the return type is unreliable because the body's operator sugar is a TS error
 * until lowered. `$prev` is left untouched by the operator pass (its ambient type
 * is `Node`), and replaced here after operators lower.
 */

import ts from "typescript";

import { typeString } from "../classify.ts";

const f = ts.factory;
const id = (n: string): ts.Identifier => f.createIdentifier(n);
const method = (obj: ts.Expression, name: string, args: ts.Expression[]): ts.Expression =>
  f.createCallExpression(f.createPropertyAccessExpression(obj, name), undefined, args);

function isDefineSubgraph(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "defineSubgraph"
  );
}

function usesPrev(node: ts.Node): boolean {
  let found = false;
  const v = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === "$prev") found = true;
    else ts.forEachChild(n, v);
  };
  v(node);
  return found;
}

/** Slot type from the method's first `Node<T>` parameter; default `f32`. */
function slotScalar(checker: ts.TypeChecker, m: ts.ArrowFunction): string {
  for (const p of m.parameters) {
    const match = /^Node<"(\w+)">/.exec(typeString(checker, p.name));
    if (match) return match[1]!;
  }
  return "f32";
}

/** `const <slot> = state.<scalar>(0);` */
function slotDecl(slot: string, scalar: string): ts.Statement {
  const init = f.createCallExpression(
    f.createPropertyAccessExpression(id("state"), scalar),
    undefined,
    [f.createNumericLiteral(0)],
  );
  return f.createVariableStatement(
    undefined,
    f.createVariableDeclarationList(
      [f.createVariableDeclaration(slot, undefined, undefined, init)],
      ts.NodeFlags.Const,
    ),
  );
}

/** Replace `$prev` identifiers with `<slot>.read()`. */
function replacePrev(node: ts.Node, slot: string, context: ts.TransformationContext): ts.Node {
  const v: ts.Visitor = (n) =>
    ts.isIdentifier(n) && n.text === "$prev"
      ? method(id(slot), "read", [])
      : ts.visitEachChild(n, v, context);
  return ts.visitNode(node, v) as ts.Node;
}

/** Strip any number of nested parentheses: `(({...}))` → `{...}`. */
function unwrapParens(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

/** The methods object returned by the factory arrow, plus any pre-return decls. */
function returnedObject(
  arrow: ts.ArrowFunction,
): { obj: ts.ObjectLiteralExpression; pre: ts.Statement[] } | undefined {
  const b = arrow.body;
  if (ts.isBlock(b)) {
    const ret = b.statements.find(ts.isReturnStatement);
    if (ret?.expression !== undefined) {
      const inner = unwrapParens(ret.expression);
      if (ts.isObjectLiteralExpression(inner)) {
        return { obj: inner, pre: b.statements.filter((s) => !ts.isReturnStatement(s)) };
      }
    }
    return undefined;
  }
  const inner = unwrapParens(b);
  if (ts.isObjectLiteralExpression(inner)) return { obj: inner, pre: [] };
  return undefined;
}

export function tryPrev(
  checker: ts.TypeChecker,
  node: ts.Node,
  visit: ts.Visitor,
  context: ts.TransformationContext,
): ts.Node | undefined {
  if (!isDefineSubgraph(node)) return undefined;
  const arrow = node.arguments[0];
  if (arrow === undefined || !ts.isArrowFunction(arrow)) return undefined;
  const ret = returnedObject(arrow);
  if (ret === undefined) return undefined;
  if (!ret.obj.properties.some((p) => ts.isPropertyAssignment(p) && usesPrev(p.initializer))) {
    return undefined;
  }

  let counter = 0;
  const slots: ts.Statement[] = [];
  const props = ret.obj.properties.map((p): ts.ObjectLiteralElementLike => {
    if (
      !ts.isPropertyAssignment(p) ||
      !ts.isArrowFunction(p.initializer) ||
      !usesPrev(p.initializer)
    ) {
      return ts.visitNode(p, visit) as ts.ObjectLiteralElementLike;
    }
    const fn = p.initializer;
    const slot = `__prev_${counter++}`;
    slots.push(slotDecl(slot, slotScalar(checker, fn)));

    // Lower the body's operator / index / bare-state sugar (treating `$prev` as a
    // Node), then replace `$prev` with the slot read.
    const loweredBody = ts.visitNode(fn.body, visit) as ts.ConciseBody;
    const replaced = replacePrev(loweredBody, slot, context) as ts.ConciseBody;
    const r = id("__r");
    // Each returned value is stored into the slot before it is returned:
    //   return e  →  const __r = e; <slot>.write(__r); return __r
    const storeReturn = (e: ts.Expression): ts.Statement[] => [
      f.createVariableStatement(
        undefined,
        f.createVariableDeclarationList(
          [f.createVariableDeclaration("__r", undefined, undefined, e)],
          ts.NodeFlags.Const,
        ),
      ),
      f.createExpressionStatement(method(id(slot), "write", [r])),
      f.createReturnStatement(r),
    ];
    const block = ts.isBlock(replaced)
      ? f.createBlock(
          replaced.statements.flatMap((s) =>
            ts.isReturnStatement(s) && s.expression !== undefined ? storeReturn(s.expression) : [s],
          ),
          true,
        )
      : f.createBlock(storeReturn(replaced as ts.Expression), true);
    const newFn = f.createArrowFunction(
      fn.modifiers,
      fn.typeParameters,
      fn.parameters,
      fn.type,
      fn.equalsGreaterThanToken,
      block,
    );
    return f.createPropertyAssignment(p.name, newFn);
  });

  const newObj = f.createObjectLiteralExpression(props, true);
  // The factory's pre-return decls (`const g = coef * 2`) carry their own sugar.
  const newPre = ret.pre.map((s) => ts.visitNode(s, visit) as ts.Statement);
  const newArrowBody = f.createBlock([...newPre, ...slots, f.createReturnStatement(newObj)], true);
  const newArrow = f.createArrowFunction(
    arrow.modifiers,
    arrow.typeParameters,
    arrow.parameters,
    arrow.type,
    arrow.equalsGreaterThanToken,
    newArrowBody,
  );
  return f.createCallExpression(node.expression, node.typeArguments, [
    newArrow,
    ...node.arguments.slice(1),
  ]);
}
