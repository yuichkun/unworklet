/**
 * Auto-name pass (RFC-001 S9) — runs on module-top-level
 * `const X = <decl helper>` declarations. The binding name fills in a missing
 * declared name; an explicit name always wins.
 *
 *   const cutoff = param.f32({...})         → param.f32({...}).named("cutoff")
 *   const input = audioInput({ channels })   → audioInput({ channels, name: "input" })
 *   const notes = event.midi({ from })        → event.midi({ from, name: "notes" })
 *   const meterL = state.f32(0).expose({...}) → ...expose({..., name: "meterL"})
 *   const tap = state.f32(0).named()          → state.f32(0).named("tap")
 *
 * Name-required helpers (param / audioInput / audioOutput / event) always derive.
 * Name-optional state / buffer derive ONLY through an explicit marker — a
 * `.expose({...})` without a name, or a no-arg `.named()` — so a plain
 * `state.f32(0)` stays anonymous. An explicit `name` / `.named("x")` / a
 * `.expose({ name })` is left untouched. Non-object expose options forward the
 * core fields lazily, with a binding-name fallback for an undefined name.
 * Other helpers leave non-object options untouched.
 */

import ts from "typescript";

const f = ts.factory;

/** The leftmost identifier of a call/property chain (the root helper name). */
export function rootCallee(expr: ts.Expression): string | undefined {
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

/** Whether the chain already contains a call to a method named `method`. */
function hasMethodCall(expr: ts.Expression, method: string): boolean {
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isCallExpression(e)) {
      if (ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === method) {
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

/** The method name of a call whose callee is `obj.method(...)`, else undefined. */
export function calledMethod(call: ts.CallExpression): string | undefined {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined;
}

/** Whether the call's first-arg options object already has a `name` property. */
export function optionsHaveName(call: ts.CallExpression): boolean {
  const arg = call.arguments[0];
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return false;
  // The key may be written either bare (`name:`) or quoted (`"name":`) — a quoted
  // key is a StringLiteral, not an Identifier. Missing the quoted form would let
  // auto-name append a second `name`, silently renaming the slot / snapshot key.
  return arg.properties.some(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === "name",
  );
}

/** Whether the call's first argument can carry an injected `name` (object or absent). */
export function argIsInjectable(call: ts.CallExpression): boolean {
  const arg = call.arguments[0];
  return arg === undefined || ts.isObjectLiteralExpression(arg);
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

function withExposeOptions(
  call: ts.CallExpression,
  name: string,
  coreModule: string,
): ts.CallExpression {
  const options = f.createIdentifier("__exposeOptions");
  const exposeName = f.createIdentifier("__exposeName");
  // Lazy forwarding retains inherited getters, their receiver, and core's read
  // order/count; spreading would eagerly read even fields core never uses.
  const getters = ["name", "snapshot", "publish"].map((field) => {
    const value = f.createPropertyAccessExpression(options, field);
    const statements =
      field === "name"
        ? [
            f.createVariableStatement(
              undefined,
              f.createVariableDeclarationList(
                [f.createVariableDeclaration(exposeName, undefined, undefined, value)],
                ts.NodeFlags.Const,
              ),
            ),
            f.createReturnStatement(
              f.createConditionalExpression(
                f.createBinaryExpression(
                  exposeName,
                  ts.SyntaxKind.EqualsEqualsEqualsToken,
                  f.createVoidZero(),
                ),
                undefined,
                f.createStringLiteral(name),
                undefined,
                exposeName,
              ),
            ),
          ]
        : [f.createReturnStatement(value)];
    return f.createGetAccessorDeclaration(
      undefined,
      field,
      [],
      undefined,
      f.createBlock(statements, true),
    );
  });
  const adapter = f.createArrowFunction(
    undefined,
    undefined,
    [
      f.createParameterDeclaration(
        undefined,
        undefined,
        options,
        undefined,
        f.createImportTypeNode(
          f.createLiteralTypeNode(f.createStringLiteral(coreModule)),
          undefined,
          f.createIdentifier("ExposeOptions"),
        ),
      ),
    ],
    undefined,
    undefined,
    f.createObjectLiteralExpression(getters, true),
  );
  return f.updateCallExpression(call, call.expression, call.typeArguments, [
    f.createCallExpression(adapter, undefined, [call.arguments[0]!]),
    ...call.arguments.slice(1),
  ]);
}

/** Compute the auto-named initializer, or undefined if nothing to do. */
function autoNamedInit(
  init: ts.Expression,
  name: string,
  coreModule: string,
  checker: ts.TypeChecker,
  coreExpose: Set<ts.Declaration>,
): ts.Expression | undefined {
  const root = rootCallee(init);
  const outer = ts.isCallExpression(init) ? init : undefined;
  const outerMethod = outer !== undefined ? calledMethod(outer) : undefined;

  // `.expose({...})` (param / state / buffer) — the name lives in the expose
  // options; derive it from the binding when absent, never clobber an explicit one.
  if (outer !== undefined && outerMethod === "expose") {
    const receiver = ts.getOriginalNode(
      (outer.expression as ts.PropertyAccessExpression).expression,
    );
    const declarations = checker
      .getNonNullableType(checker.getTypeAtLocation(receiver))
      .getProperty("expose")?.declarations;
    // A mixed core/custom union can resolve its call signature to core alone.
    // Every possible receiver method must originate from a core declaration.
    if (!declarations?.length || !declarations.every((decl) => coreExpose.has(decl)))
      return undefined;
    if (optionsHaveName(outer)) return undefined;
    return argIsInjectable(outer)
      ? withNameInOptions(outer, name)
      : withExposeOptions(outer, name, coreModule);
  }
  // A no-arg `.named()` marker on a name-optional state / buffer — fill the name.
  if (outer !== undefined && outerMethod === "named" && outer.arguments.length === 0) {
    return f.updateCallExpression(outer, outer.expression, outer.typeArguments, [
      f.createStringLiteral(name),
    ]);
  }
  // Name-required option-bag helpers — inject `name` into the options object.
  if (
    (root === "audioInput" || root === "audioOutput" || root === "event") &&
    ts.isCallExpression(init) &&
    !optionsHaveName(init) &&
    argIsInjectable(init)
  ) {
    return withNameInOptions(init, name);
  }
  // `param.<T>({...})` — name lives on a trailing `.named(...)`; append one (unless
  // the param is already named or exposed).
  if (root === "param" && !hasMethodCall(init, "named") && !hasMethodCall(init, "expose")) {
    return f.createCallExpression(f.createPropertyAccessExpression(init, "named"), undefined, [
      f.createStringLiteral(name),
    ]);
  }
  return undefined;
}

/** Bind auto-naming to the canonical core declarations in this program. */
export function createAutoNameDeclaration(
  program: ts.Program,
  coreModule = "@unworklet/core",
): (stmt: ts.Statement) => ts.Statement {
  const checker = program.getTypeChecker();
  const ambient = program.getSourceFile(program.getRootFileNames()[0]!)!;
  const coreImport = ambient.statements.find(ts.isImportDeclaration)!;
  const coreSymbol = checker.getSymbolAtLocation(coreImport.moduleSpecifier);
  const coreExpose = new Set<ts.Declaration>();
  const exposureTypes = new Set([
    "State",
    "Buffer",
    "Param",
    "StateChain",
    "BufferChain",
    "ParamChain",
  ]);
  if (coreSymbol !== undefined) {
    for (const exported of checker.getExportsOfModule(coreSymbol)) {
      if (!exposureTypes.has(exported.name)) continue;
      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const type = checker.getDeclaredTypeOfSymbol(symbol);
      for (const declaration of type.getProperty("expose")!.declarations!)
        coreExpose.add(declaration);
    }
  }
  return (stmt) => autoNameDeclaration(stmt, coreModule, checker, coreExpose);
}

function autoNameDeclaration(
  stmt: ts.Statement,
  coreModule: string,
  checker: ts.TypeChecker,
  coreExpose: Set<ts.Declaration>,
): ts.Statement {
  if (!ts.isVariableStatement(stmt)) return stmt;
  if (stmt.declarationList.declarations.length !== 1) return stmt;
  const decl = stmt.declarationList.declarations[0]!;
  if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return stmt;

  const newInit = autoNamedInit(decl.initializer, decl.name.text, coreModule, checker, coreExpose);
  if (newInit === undefined) return stmt;

  return f.updateVariableStatement(
    stmt,
    stmt.modifiers,
    f.updateVariableDeclarationList(stmt.declarationList, [
      f.updateVariableDeclaration(decl, decl.name, decl.exclamationToken, decl.type, newInit),
    ]),
  );
}
