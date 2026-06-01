/**
 * Auto-name pass (RFC-001 S9) — purely syntactic, runs on module-top-level
 * `const X = <decl helper>` declarations. Name-required helpers derive their
 * name from the binding when none is given:
 *
 *   const cutoff = param.f32({...})        → param.f32({...}).named("cutoff")
 *   const input = audioInput({ channels })  → audioInput({ channels, name: "input" })
 *   const notes = event.midi({ from })       → event.midi({ from, name: "notes" })
 *
 * An explicit `name` / `.named(...)` always wins (left untouched). State / buffer
 * are name-optional: a plain `state.f32(0)` stays anonymous, and a `.named("x")`
 * keeps its explicit name — those are left as-is here.
 */

import ts from "typescript";

const f = ts.factory;

/** The leftmost identifier of a call/property chain (the root helper name). */
function rootCallee(expr: ts.Expression): string | undefined {
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isCallExpression(e)) {
      e = e.expression;
    } else if (ts.isPropertyAccessExpression(e)) {
      e = e.expression;
    } else {
      break;
    }
  }
  return ts.isIdentifier(e) ? e.text : undefined;
}

/** Whether the chain already contains a `.named(...)` call. */
function hasNamedCall(expr: ts.Expression): boolean {
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isCallExpression(e)) {
      if (ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "named") {
        return true;
      }
      e = e.expression;
    } else if (ts.isPropertyAccessExpression(e)) {
      e = e.expression;
    } else {
      break;
    }
  }
  return false;
}

/** Whether the call's first-arg options object already has a `name` property. */
function optionsHaveName(call: ts.CallExpression): boolean {
  const arg = call.arguments[0];
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return false;
  return arg.properties.some(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      ts.isIdentifier(p.name) &&
      p.name.text === "name",
  );
}

function withNameInOptions(call: ts.CallExpression, name: string): ts.CallExpression {
  const nameProp = f.createPropertyAssignment("name", f.createStringLiteral(name));
  const arg = call.arguments[0];
  const options =
    arg !== undefined && ts.isObjectLiteralExpression(arg)
      ? f.updateObjectLiteralExpression(arg, [...arg.properties, nameProp])
      : f.createObjectLiteralExpression([nameProp]);
  return f.updateCallExpression(call, call.expression, call.typeArguments, [
    options,
    ...call.arguments.slice(1),
  ]);
}

/** Apply auto-name to one module-top-level statement (no-op if not applicable). */
export function autoNameDeclaration(stmt: ts.Statement): ts.Statement {
  if (!ts.isVariableStatement(stmt)) return stmt;
  if (stmt.declarationList.declarations.length !== 1) return stmt;
  const decl = stmt.declarationList.declarations[0]!;
  if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return stmt;

  const name = decl.name.text;
  const init = decl.initializer;
  const root = rootCallee(init);

  let newInit: ts.Expression | undefined;
  if (
    (root === "audioInput" || root === "audioOutput" || root === "event") &&
    ts.isCallExpression(init) &&
    !optionsHaveName(init)
  ) {
    // Name-required helper carrying an options object (audioInput / audioOutput /
    // event / event.midi): add `name: "<binding>"`.
    newInit = withNameInOptions(init, name);
  } else if (root === "param" && !hasNamedCall(init)) {
    // param.<T>({...}) — name lives on a `.named(...)`; append one.
    newInit = f.createCallExpression(f.createPropertyAccessExpression(init, "named"), undefined, [
      f.createStringLiteral(name),
    ]);
  }
  if (newInit === undefined) return stmt;

  return f.updateVariableStatement(
    stmt,
    stmt.modifiers,
    f.updateVariableDeclarationList(stmt.declarationList, [
      f.updateVariableDeclaration(decl, decl.name, decl.exclamationToken, decl.type, newInit),
    ]),
  );
}
