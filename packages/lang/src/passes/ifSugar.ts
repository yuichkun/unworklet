/**
 * if-sugar pass (RFC-001 S7). An `if` with a `Node<'bool'>` condition lowers to a
 * branch-free `select` / `emitIf`. A JS-boolean condition is left as a build-time
 * `if` (the existing meta-program path). Three shapes:
 *
 *   1. single state / buffer write, no else:
 *        if (c) s.write(v)        → s.write(select(c, v, s.read()))
 *        if (c) buf[i] = v        → buf.write(i, select(c, v, buf.read(i)))
 *   2. symmetric if-else to the same target:
 *        if (c) s.write(a) else s.write(b)  → s.write(select(c, a, b))
 *   3. guarded emit, no else:
 *        if (c) port.emit(p)      → port.emitIf(c, p)   (each emit in the block)
 *
 * The condition and all values are recursed through the shared visitor so nested
 * operator / index / bare-state sugar lowers too.
 */

import ts from "typescript";

import { classify, isDspExpr } from "../classify.ts";
import { LowerError } from "../lower.ts";

const f = ts.factory;
const method = (obj: ts.Expression, name: string, args: ts.Expression[]): ts.Expression =>
  f.createCallExpression(f.createPropertyAccessExpression(obj, name), undefined, args);
const exprStmt = (e: ts.Expression): ts.Statement => f.createExpressionStatement(e);
const select = (c: ts.Expression, x: ts.Expression, y: ts.Expression): ts.Expression =>
  f.createCallExpression(f.createIdentifier("select"), undefined, [c, x, y]);

// A Node<'bool'>-conditioned `if` that matches none of the three shapes cannot be
// left as a build-time `if`: a `.uwk.ts` file is `@ts-nocheck`, so the condition is
// a truthy DSP object at graph-capture time and only the then-branch would run —
// silently producing wrong audio. Refuse it with guidance instead.
const unsupportedDspIf = (): never => {
  throw new LowerError(
    "uwk-unsupported-if",
    "an `if` with a Node<'bool'> condition lowers only as a single state/buffer write " +
      "(optionally a symmetric `if`/`else` writing the same target) or guarded port.emit(...) " +
      "calls. Rewrite this branch into one of those shapes, or compute the value directly with " +
      "select(cond, whenTrue, whenFalse).",
  );
};

type Write =
  | { kind: "state"; target: ts.Expression; value: ts.Expression }
  | { kind: "buffer"; buf: ts.Expression; idx: ts.Expression; value: ts.Expression };

function stmtList(s: ts.Statement): ts.Statement[] {
  return ts.isBlock(s) ? [...s.statements] : [s];
}

/** A single `state.write(v)` / `buf[i] = v` / `buf.write(i, v)` statement. */
function detectWrite(checker: ts.TypeChecker, stmt: ts.Statement): Write | undefined {
  if (!ts.isExpressionStatement(stmt)) return undefined;
  const e = stmt.expression;
  if (
    ts.isBinaryExpression(e) &&
    e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isElementAccessExpression(e.left) &&
    classify(checker, e.left.expression) === "buffer"
  ) {
    return {
      kind: "buffer",
      buf: e.left.expression,
      idx: e.left.argumentExpression,
      value: e.right,
    };
  }
  if (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === "write"
  ) {
    const obj = e.expression.expression;
    const cls = classify(checker, obj);
    if (cls === "state" && e.arguments[0] !== undefined) {
      return { kind: "state", target: obj, value: e.arguments[0] };
    }
    if (cls === "buffer" && e.arguments[0] !== undefined && e.arguments[1] !== undefined) {
      return { kind: "buffer", buf: obj, idx: e.arguments[0], value: e.arguments[1] };
    }
  }
  return undefined;
}

// Buffer index / write value are synthesized into new AST fragments, so the
// bareState pass never gets to see them (the sugar visitor short-circuits at
// tryIfSugar's return). If they name a bare `State<T>`, wrap them here — same
// intent as bareState, but locally applied to the injected positions.
const readIfState = (checker: ts.TypeChecker, e: ts.Expression): ts.Expression =>
  classify(checker, e) === "state" ? method(e, "read", []) : e;

const writeRead = (checker: ts.TypeChecker, w: Write): ts.Expression =>
  w.kind === "state"
    ? method(w.target, "read", [])
    : method(w.buf, "read", [readIfState(checker, w.idx)]);

const writeWith = (checker: ts.TypeChecker, w: Write, value: ts.Expression): ts.Statement =>
  exprStmt(
    w.kind === "state"
      ? method(w.target, "write", [value])
      : method(w.buf, "write", [readIfState(checker, w.idx), value]),
  );

/** Same write target (by source text) — symmetric-if requires it. */
function sameTarget(a: Write, b: Write): boolean {
  if (a.kind === "state" && b.kind === "state") return a.target.getText() === b.target.getText();
  if (a.kind === "buffer" && b.kind === "buffer")
    return a.buf.getText() === b.buf.getText() && a.idx.getText() === b.idx.getText();
  // The kinds differ (a state write vs a buffer write) — not the same target.
  return false;
}

/** A block whose statements are all `port.emit(payload)` calls. Exported so the IDE
 * virtual-code generator gates its guarded-emit rewrite on the SAME all-emits shape
 * the build accepts — a then-branch mixing an emit with anything else is rejected by
 * the build (`uwk-unsupported-if`), so the editor must not rewrite it either. */
export function detectEmits(
  stmt: ts.Statement,
): Array<{ port: ts.Expression; payload: ts.Expression }> | undefined {
  const out: Array<{ port: ts.Expression; payload: ts.Expression }> = [];
  for (const s of stmtList(stmt)) {
    if (!ts.isExpressionStatement(s)) return undefined;
    const e = s.expression;
    if (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      e.expression.name.text === "emit" &&
      e.arguments[0] !== undefined
    ) {
      out.push({ port: e.expression.expression, payload: e.arguments[0] });
    } else {
      return undefined;
    }
  }
  return out.length > 0 ? out : undefined;
}

export function tryIfSugar(
  checker: ts.TypeChecker,
  node: ts.Node,
  visit: ts.Visitor,
): ts.Node | undefined {
  if (!ts.isIfStatement(node)) return undefined;
  // Only a Node<'bool'>-derived condition is sugar; a JS boolean stays build-time.
  if (!isDspExpr(checker, node.expression)) return undefined;
  const v = (e: ts.Expression): ts.Expression => ts.visitNode(e, visit) as ts.Expression;
  // A bare `State<'bool'>` condition sits in a `boolean` contextual position, so
  // bare-state leaves it untouched — read it here.
  const cond =
    classify(checker, node.expression) === "state"
      ? method(v(node.expression), "read", [])
      : v(node.expression);

  if (node.elseStatement === undefined) {
    // Shape 3: guarded emit(s).
    const emits = detectEmits(node.thenStatement);
    if (emits !== undefined) {
      return f.createBlock(
        emits.map(({ port, payload }) => exprStmt(method(v(port), "emitIf", [cond, v(payload)]))),
        true,
      );
    }
    // Shape 1: single state / buffer write, no else.
    const then = stmtList(node.thenStatement);
    if (then.length === 1) {
      const w = detectWrite(checker, then[0]!);
      if (w !== undefined)
        return writeWith(checker, w, select(cond, v(w.value), writeRead(checker, w)));
    }
    return unsupportedDspIf();
  }

  // Shape 2: symmetric if-else to the same target.
  const thenStmts = stmtList(node.thenStatement);
  const elseStmts = stmtList(node.elseStatement);
  if (thenStmts.length === 1 && elseStmts.length === 1) {
    const tw = detectWrite(checker, thenStmts[0]!);
    const ew = detectWrite(checker, elseStmts[0]!);
    if (tw !== undefined && ew !== undefined && sameTarget(tw, ew)) {
      return writeWith(checker, tw, select(cond, v(tw.value), v(ew.value)));
    }
  }
  return unsupportedDspIf();
}
