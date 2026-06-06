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
 * The slot type T follows the method's RETURN (the slot stores the previous return
 * value): a return-type annotation, else the return expression's checker type when
 * resolvable, else the first `Node<T>` parameter (RFC O4 — correct when param type
 * == return type), else `f32`. See {@link slotScalar}. `$prev` is left untouched by
 * the operator pass (its ambient type is `Node`), and replaced here after operators
 * lower.
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

const NODE_SCALAR = /^Node<"(\w+)">/;

/** The method's representative return expression (first `return`, or the concise body). */
function returnExpression(m: ts.ArrowFunction): ts.Expression | undefined {
  if (!ts.isBlock(m.body)) return m.body;
  let found: ts.Expression | undefined;
  const v = (n: ts.Node): void => {
    if (found !== undefined || ts.isFunctionLike(n)) return; // a nested closure's return is not this method's
    if (ts.isReturnStatement(n) && n.expression !== undefined) {
      found = n.expression;
      return;
    }
    ts.forEachChild(n, v);
  };
  ts.forEachChild(m.body, v);
  return found;
}

/**
 * Scalar type of the `$prev` slot. The slot stores the method's previous RETURN
 * value, so the return type — not a parameter — is authoritative. We read it from,
 * in order:
 *   1. an explicit return-type annotation `(p): Node<'X'> => ...` (always reliable),
 *   2. the return expression's checker type, when resolvable (a method-form /
 *      constructor-anchored body types cleanly even under `@ts-nocheck`; pure infix
 *      operator sugar is a TS error and falls through),
 *   3. the first `Node<T>` parameter (RFC O4 — correct when param type == return type),
 *   4. `f32`.
 */
function slotScalar(checker: ts.TypeChecker, m: ts.ArrowFunction): string {
  if (m.type !== undefined) {
    const match = NODE_SCALAR.exec(m.type.getText());
    if (match) return match[1]!;
  }
  const ret = returnExpression(m);
  if (ret !== undefined) {
    const match = NODE_SCALAR.exec(typeString(checker, ret));
    if (match) return match[1]!;
  }
  for (const p of m.parameters) {
    const match = NODE_SCALAR.exec(typeString(checker, p.name));
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

/**
 * Mark every `$prev` identifier OWNED by this method body (i.e. not inside a nested
 * `defineSubgraph`, whose `$prev` belongs to that inner method) with `scalar`. This
 * mirrors the lowering's {@link replacePrev}, which rewrites exactly those `$prev`
 * to the method's slot after any nested subgraph has already been lowered.
 */
function markOwnedPrev(
  body: ts.Node,
  scalar: string,
  sourceFile: ts.SourceFile,
  out: Map<number, string>,
): void {
  const v = (n: ts.Node): void => {
    if (isDefineSubgraph(n)) return; // a nested subgraph's `$prev` is the inner method's
    if (ts.isIdentifier(n) && n.text === "$prev") {
      out.set(n.getStart(sourceFile), scalar);
      return;
    }
    ts.forEachChild(n, v);
  };
  v(body);
}

/**
 * Map each `$prev` identifier (keyed by its source start offset) to the slot scalar
 * the lowering would give it — the SAME per-method {@link slotScalar} `tryPrev`
 * injects. The IDE virtual-code generator uses this to type `$prev` as the concrete
 * `Node<scalar>` the build lowers it to, instead of the broad ambient
 * `Node<ScalarType>` that draws bogus editor diagnostics on otherwise-valid feedback.
 */
export function prevSlotScalars(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): Map<number, string> {
  const out = new Map<number, string>();
  const visit = (node: ts.Node): void => {
    if (isDefineSubgraph(node)) {
      const arrow = node.arguments[0];
      if (arrow !== undefined && ts.isArrowFunction(arrow)) {
        const ret = returnedObject(arrow);
        if (ret !== undefined) {
          for (const p of ret.obj.properties) {
            if (
              ts.isPropertyAssignment(p) &&
              ts.isArrowFunction(p.initializer) &&
              usesPrev(p.initializer)
            ) {
              markOwnedPrev(
                p.initializer.body,
                slotScalar(checker, p.initializer),
                sourceFile,
                out,
              );
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
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
    // Wrap EVERY return with the store-then-return, including nested ones: a
    // build-time `if (b) return x;` early-return must advance the slot too, or
    // that path leaves `$prev` stale. Stop at function boundaries — a return
    // inside a nested closure is not this method's return value.
    const wrapReturns = (n: ts.Node): ts.Node => {
      if (ts.isFunctionLike(n)) return n;
      if (ts.isReturnStatement(n) && n.expression !== undefined) {
        return f.createBlock(storeReturn(n.expression), true);
      }
      return ts.visitEachChild(n, wrapReturns, context);
    };
    const block = ts.isBlock(replaced)
      ? (ts.visitNode(replaced, wrapReturns) as ts.Block)
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
