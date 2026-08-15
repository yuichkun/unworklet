/**
 * Type classification for the lowering passes. Every predicate reads the
 * `TypeChecker`'s `typeToString` of a node and matches the `@unworklet/core`
 * brand by prefix — the brands print as `Node<"f32">` / `State<"f32">` /
 * `Buffer<"u8">` / `Param` / `InputChannelView<"f32">` / `OutputChannelView<"f32">`.
 *
 * The hard part is that operator sugar is a TS error until lowered (`Node * 2`
 * types as `number`), so stock TS mis-types three DSP-producing shapes as
 * `number` / `any`: an index read (`buf[i]`), a `const` bound to a sugar
 * expression (`const x = a * 2`), and a call to a sugar-bodied helper
 * (`double(x)`). `isDspExpr` / `classify` recover all three structurally, so an
 * operator over them still lowers. All queries run against the PRISTINE source
 * (a visitor receives original, never factory, nodes).
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

/** Recursion guard for the structural fallbacks (bound locals / sugar-bodied calls). */
const inFlight = new Set<ts.Node>();

// Per-node memo. Nodes are unique per `ts.Program` (one program per `lower()`),
// so the WeakMap is self-clearing across calls and never sees a stale checker.
// The structural fallbacks resolve symbols / signatures, which is expensive, so
// memoizing turns the whole classify pass from O(queries) to O(nodes).
const classifyMemo = new WeakMap<ts.Node, ValueClass>();
const dspExprMemo = new WeakMap<ts.Node, boolean>();

export function classify(checker: ts.TypeChecker, node: ts.Node): ValueClass {
  const cached = classifyMemo.get(node);
  if (cached !== undefined) return cached;
  const result = computeClassify(checker, node);
  classifyMemo.set(node, result);
  return result;
}

function computeClassify(checker: ts.TypeChecker, node: ts.Node): ValueClass {
  const s = typeString(checker, node);
  // A union containing `Node<...>` (e.g. a `cond ? nodeBranch : stateBranch`
  // select result types as `Node<T> | State<T>`) is a Node value — check before
  // State so the (unspecified) union member print order can't flip it.
  if (s.startsWith("Node<") || (s.includes(" | ") && s.includes("Node<"))) return "node";
  if (s.startsWith("State<")) return "state";
  if (s.startsWith("Buffer<")) return "buffer";
  if (s === "Param") return "param";
  if (s.startsWith("InputChannelView<")) return "inputChannel";
  if (s.startsWith("OutputChannelView<")) return "outputChannel";
  // Fallback: a `const x = <sugar expr>` is mis-typed `number` / `any`, so a
  // binding whose initializer is itself a DSP expression is a DSP value.
  if (ts.isIdentifier(node) && isDspBoundLocal(checker, node)) return "node";
  return "other";
}

/** A local `const X = <DSP expr>` binding (stock TS mis-types it `number`/`any`). */
function isDspBoundLocal(checker: ts.TypeChecker, node: ts.Identifier): boolean {
  const sym = checker.getSymbolAtLocation(node);
  const decl = sym?.valueDeclaration;
  if (
    decl === undefined ||
    !ts.isVariableDeclaration(decl) ||
    decl.initializer === undefined ||
    decl.initializer === node ||
    inFlight.has(decl)
  ) {
    return false;
  }
  inFlight.add(decl);
  try {
    return isDspExpr(checker, decl.initializer);
  } finally {
    inFlight.delete(decl);
  }
}

/** A call whose result is a DSP value: `pipe(dspValue, ...)`, or a helper /
 * subgraph method whose body returns a DSP expression (its return is mis-typed
 * `number` when written with operator sugar and no return annotation). */
function isDspCall(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
  if (ts.isIdentifier(call.expression) && call.expression.text === "pipe") {
    return call.arguments[0] !== undefined && isDspExpr(checker, call.arguments[0]);
  }
  const decl = checker.getResolvedSignature(call)?.declaration;
  if (
    decl === undefined ||
    inFlight.has(decl) ||
    !(
      ts.isArrowFunction(decl) ||
      ts.isFunctionExpression(decl) ||
      ts.isFunctionDeclaration(decl) ||
      ts.isMethodDeclaration(decl)
    )
  ) {
    return false;
  }
  const body = decl.body;
  if (body === undefined) return false;
  inFlight.add(decl);
  try {
    if (!ts.isBlock(body)) return isDspExpr(checker, body);
    const ret = body.statements.find(ts.isReturnStatement);
    return ret?.expression !== undefined && isDspExpr(checker, ret.expression);
  } finally {
    inFlight.delete(decl);
  }
}

/** The sugar binary operators (arithmetic + comparison + bool logical) the operator pass lowers. */
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
    // Bool logical: `a && b` → `and(a, b)`, `a || b` → `or(a, b)`. Both operands
    // are always evaluated (no JS-style short-circuit) — WASM realtime has no
    // branch-free short-circuit primitive, and `select(cond, a, b)` is no way
    // around it: it picks a value and evaluates both. Nothing in the DSL skips
    // an operand, so every operand has to be safe to evaluate.
    // Fires only when at least one operand classifies as a DSP expr;
    // when both operands are non-Node the sugar is a no-op and TS reports the
    // usual JS boolean semantics.
    case ts.SyntaxKind.AmpersandAmpersandToken:
    case ts.SyntaxKind.BarBarToken:
      return true;
    default:
      return false;
  }
}

/**
 * Whether `node` is — or will lower to — a `Node<T>`. A bare `Node` / `State` is
 * one directly; an operator / index / sugar-helper-call expression becomes one
 * iff a constituent is a DSP value. This is the operator-dispatch predicate: a
 * `number op number` const-fold returns false and is left as build-time JS.
 */
export function isDspExpr(checker: ts.TypeChecker, node: ts.Node): boolean {
  const cached = dspExprMemo.get(node);
  if (cached !== undefined) return cached;
  const result = computeDspExpr(checker, node);
  dspExprMemo.set(node, result);
  return result;
}

function computeDspExpr(checker: ts.TypeChecker, node: ts.Node): boolean {
  const c = classify(checker, node);
  if (c === "node" || c === "state") return true;
  if (ts.isParenthesizedExpression(node)) return isDspExpr(checker, node.expression);
  // An index read `obj[i]` becomes a Node when the object is a channel view /
  // param / buffer — those types carry no index signature so stock TS types the
  // access `any`, but it desugars to `.at(i)` / `.read(i)` one pass later.
  if (ts.isElementAccessExpression(node)) {
    const obj = classify(checker, node.expression);
    return obj === "inputChannel" || obj === "outputChannel" || obj === "param" || obj === "buffer";
  }
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
  if (ts.isCallExpression(node)) {
    // A method call on a DSP receiver — `buf[i].abs()`, `(a * b).sin()`, a
    // sugar-bound local's `.frac()`. The receiver mis-types `any` (un-lowered
    // sugar), so the method result does too and its signature can't be resolved;
    // recover it structurally. Every `Node<T>` method returns a `Node`, so a
    // method call on a DSP value is itself a DSP value.
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      isDspExpr(checker, node.expression.expression)
    ) {
      return true;
    }
    return isDspCall(checker, node);
  }
  return false;
}
