/**
 * `.uwk.ts` → virtual `.ts` lowering (RFC-001). This first slice implements S11:
 * recognize the `process(() => {...})` macro + module-level declarations and wrap
 * them into the canonical `defineProcessor((ctx) => { ...decls; return { process }
 * })` shape that the existing `@unworklet/core` compile pipeline consumes. Sugar
 * passes (operators, index access, $prev, …) transform the AST before the wrap
 * and compose here as they land.
 *
 * The lowered module is plain public-DSL `.ts`: running it makes the same
 * sequence of DSL calls as a hand-written Tier-A processor, so it compiles to a
 * byte-identical `CompiledProcessor` (proven by the golden fingerprint harness).
 */

import ts from "typescript";

import { autoNameDeclaration } from "./passes/autoName.ts";
import { sugarTransformer } from "./passes/sugar.ts";
import { buildProgram, type FsSnapshot } from "./program.ts";

/** Authoring identifiers re-exported by `@unworklet/core` (the lowering import set). */
const CORE_AUTHORING_EXPORTS = new Set<string>([
  "defineProcessor",
  "defineSubgraph",
  "instantiate",
  "audioInput",
  "audioOutput",
  "state",
  "param",
  "event",
  "noiseSource",
  "forSample",
  "select",
  "pipe",
  "f32",
  "f64",
  "i32",
  "i64",
  "bool",
  "add",
  "sub",
  "mul",
  "div",
  "mod",
  "neg",
  "not",
  "and",
  "or",
  "eq",
  "lt",
  "gt",
  "lte",
  "gte",
  "sin",
  "cos",
  "tan",
  "tanh",
  "exp",
  "log",
  "sqrt",
  "floor",
  "ceil",
  "frac",
  "abs",
  "min",
  "max",
  "clamp",
  "SAMPLES_PER_BLOCK",
  "CAPACITY_16",
  "CAPACITY_32",
  "CAPACITY_64",
  "CAPACITY_128",
  "CAPACITY_256",
  "CAPACITY_512",
  "CAPACITY_1024",
  "CAPACITY_2048",
  "CAPACITY_4096",
  "CAPACITY_8192",
  "CAPACITY_16384",
]);

const PROCESS_MACRO = "process";
const MIGRATIONS_MACRO = "migrations";
const OPTIONS_MACRO = "options";

/** A lowering failure carrying a stable id for diagnostics. */
export class LowerError extends Error {
  readonly id: string;
  constructor(id: string, message: string) {
    super(message);
    this.id = id;
    this.name = "LowerError";
  }
}

export type LowerOptions = {
  /** Module specifier for the generated import. Defaults to `@unworklet/core`. */
  coreModule?: string;
  /**
   * When set, the processor is emitted as a named `export const <exportName> =
   * defineProcessor(...)` (a valid JS identifier). When omitted, it is emitted as
   * `export default`. The unplugin passes a filename-derived name so the lowered
   * module matches the named-export convention its loader expects.
   */
  exportName?: string;
  /**
   * A captured file-system snapshot (`captureFsSnapshot()`), used to build the
   * type-directed program off-disk — the path that makes `lower()` run in the
   * browser, where there is no `ts.sys` / disk. Omit it in Node (disk-backed).
   */
  snapshot?: FsSnapshot;
  /**
   * @internal Record every disk answer into this snapshot while lowering (Node).
   * Used by `captureFsSnapshot` to capture the type environment — including the
   * lazy `import("...")` resolutions the passes trigger — for later browser replay.
   */
  captureInto?: FsSnapshot;
  /**
   * Absolute path of the `.uwk.ts` file this source came from (disk-backed mode
   * only). When provided, the type-directed program roots its in-memory virtuals
   * in `path.dirname(sourcePath)` so sibling `.uwk.ts` imports resolve — the
   * fix for the cross-file subgraph bare-state auto-read gap (guidance-dogfood
   * F-08). Omit for runtime-compile (browser) paths that forbid cross-file
   * imports; `SELF_DIR` is used as before.
   */
  sourcePath?: string;
};

/** A top-level `name(...)` macro call (e.g. `process(() => {...})`). */
type MacroCall = { name: string; call: ts.CallExpression };

function topLevelMacroCall(stmt: ts.Statement): MacroCall | undefined {
  if (!ts.isExpressionStatement(stmt)) return undefined;
  const expr = stmt.expression;
  if (!ts.isCallExpression(expr)) return undefined;
  if (!ts.isIdentifier(expr.expression)) return undefined;
  return { name: expr.expression.text, call: expr };
}

function callbackBody(call: ts.CallExpression): ts.Statement[] | undefined {
  const arg = call.arguments[0];
  if (arg === undefined) return undefined;
  if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) return undefined;
  if (ts.isBlock(arg.body)) return [...arg.body.statements];
  // Expression-bodied arrow: `process(() => expr)` — wrap as a statement.
  return [ts.factory.createExpressionStatement(arg.body)];
}

/** Collect `@unworklet/core` authoring identifiers actually referenced (excluding
 * property names like `a.state`), so the generated import lists only what's used. */
function collectUsedCoreExports(node: ts.Node): Set<string> {
  const used = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && CORE_AUTHORING_EXPORTS.has(n.text)) {
      const parent = n.parent as ts.Node | undefined;
      const isPropertyName =
        parent !== undefined &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === n) ||
          (ts.isPropertyAssignment(parent) && parent.name === n) ||
          (ts.isBindingElement(parent) && parent.propertyName === n));
      if (!isPropertyName) used.add(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return used;
}

/** The module an import declaration names, or undefined when it is not a literal. */
function moduleSpecifierOf(decl: ts.ImportDeclaration): string | undefined {
  const spec = decl.moduleSpecifier;
  return ts.isStringLiteral(spec) ? spec.text : undefined;
}

/** The local binding names a user import introduces (default / namespace / named,
 * each as its in-scope alias). The injected core import drops these so a name the
 * user imports explicitly is never double-bound (e.g. `import { state }`). */
function importBoundNames(
  imports: readonly ts.ImportDeclaration[],
  /**
   * Skip the names a type-only import binds. Those carry no runtime value, so
   * they cannot stand in for a binding the generated code calls — but they do
   * occupy the name, which is why the reserved-binding check counts them.
   */
  options?: { valuesOnly?: boolean },
): Set<string> {
  const names = new Set<string>();
  for (const decl of imports) {
    const clause = decl.importClause;
    if (clause === undefined) continue;
    if (options?.valuesOnly === true && clause.isTypeOnly) continue;
    if (clause.name !== undefined) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      names.add(bindings.name.text);
    } else {
      for (const el of bindings.elements) {
        if (options?.valuesOnly === true && el.isTypeOnly) continue;
        names.add(el.name.text);
      }
    }
  }
  return names;
}

/**
 * Names imported from the core module as VALUES under their own name — the only
 * imports that can stand in for a binding the lowering generates. An alias
 * (`{ defineProcessor as audioInput }`) binds a different export under the name,
 * and a namespace or default import binds the module rather than the export.
 */
function unaliasedCoreValueImports(
  imports: readonly ts.ImportDeclaration[],
  coreModule: string,
): Set<string> {
  const names = new Set<string>();
  for (const decl of imports) {
    if (moduleSpecifierOf(decl) !== coreModule) continue;
    const clause = decl.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (bindings === undefined || ts.isNamespaceImport(bindings)) continue;
    for (const el of bindings.elements) {
      if (el.isTypeOnly) continue;
      if (el.propertyName !== undefined && el.propertyName.text !== el.name.text) continue;
      names.add(el.name.text);
    }
  }
  return names;
}

/** Every name a binding pattern introduces (`a`, `{ b }`, `[c, ...d]`). */
function collectBindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  // ObjectBindingPattern | ArrayBindingPattern — array holes are
  // OmittedExpression, not BindingElement, so they are skipped.
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(element.name, into);
  }
}

/**
 * `var` names declared anywhere inside `node`'s own body — `var` is scoped to
 * the enclosing function, not the block it sits in, so `{ var input = 1; }` and
 * a later `return input` are the same binding. Nested functions own theirs.
 */
function collectFunctionScopedVars(node: ts.Node, into: Set<string>): void {
  const walk = (n: ts.Node): void => {
    // A function, a class static block and a namespace each open their own
    // `var` scope, so a `var` inside one is not the outer scope's.
    if (
      ts.isFunctionLike(n) ||
      ts.isClassStaticBlockDeclaration(n) ||
      ts.isModuleDeclaration(n) ||
      ts.isModuleBlock(n)
    ) {
      return;
    }
    if (
      ts.isVariableDeclarationList(n) &&
      (n.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0
    ) {
      for (const d of n.declarations) collectBindingNames(d.name, into);
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(node, walk);
}

/**
 * Names a statement assigns to when it runs — `x = 1`, `x += 1`, `x++`,
 * `[x] = ...`. A function body is skipped: it assigns when CALLED, so a helper
 * that merely contains an assignment is not a write at statement time.
 */
/** Strip parentheses and the TS-only wrappers that leave the value untouched. */
function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function statementWrites(stmt: ts.Statement): Set<string> {
  const names = new Set<string>();
  const target = (raw: ts.Expression): void => {
    const expr = unwrapExpression(raw);
    if (ts.isIdentifier(expr)) names.add(expr.text);
    // `helper.value = 1` / `table[0] = 1` mutate what `helper` and `table`
    // hold, so the binding at the root of the access is what was written.
    // Parentheses and TS-only wrappers (`as`, `satisfies`, `!`) sit between the
    // access and that root without changing which binding it is.
    else if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      let root: ts.Expression = unwrapExpression(expr.expression);
      while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
        root = unwrapExpression(root.expression);
      }
      if (ts.isIdentifier(root)) names.add(root.text);
    } else if (ts.isArrayLiteralExpression(expr)) for (const el of expr.elements) target(el);
    else if (ts.isObjectLiteralExpression(expr)) {
      for (const p of expr.properties) {
        if (ts.isShorthandPropertyAssignment(p)) names.add(p.name.text);
        else if (ts.isPropertyAssignment(p)) target(p.initializer);
      }
    } else if (ts.isSpreadElement(expr)) target(expr.expression);
  };
  const walk = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isBinaryExpression(n) && isAssignmentOperator(n.operatorToken.kind)) target(n.left);
    // `delete helper.value` removes from what `helper` holds.
    if (ts.isDeleteExpression(n)) target(n.expression);
    // `for (slot of xs)` — an initializer that is an expression rather than a
    // declaration assigns into an existing binding on every iteration.
    if (
      (ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
      !ts.isVariableDeclarationList(n.initializer)
    ) {
      target(n.initializer);
    }
    if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
      if (
        n.operator === ts.SyntaxKind.PlusPlusToken ||
        n.operator === ts.SyntaxKind.MinusMinusToken
      ) {
        target(n.operand as ts.Expression);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(stmt);
  return names;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** Whether this qualified name is (part of) an `import("...")` type's qualifier. */
function isImportTypeQualifier(name: ts.QualifiedName): boolean {
  let node: ts.Node = name;
  let parent = node.parent as ts.Node | undefined;
  while (parent !== undefined && ts.isQualifiedName(parent)) {
    node = parent;
    parent = parent.parent as ts.Node | undefined;
  }
  return parent !== undefined && ts.isImportTypeNode(parent) && parent.qualifier === node;
}

/** Names bound by `infer X` anywhere in a conditional type's extends clause. */
function collectInferNames(node: ts.Node, into: Set<string>): void {
  const walk = (n: ts.Node): void => {
    if (ts.isInferTypeNode(n)) into.add(n.typeParameter.name.text);
    ts.forEachChild(n, walk);
  };
  walk(node);
}

/** The names a statement list binds in the scope it belongs to. */
function statementBoundNames(statements: readonly ts.Statement[]): Set<string> {
  const names = new Set<string>();
  for (const stmt of statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) collectBindingNames(d.name, names);
    } else if (
      (ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt) ||
        ts.isModuleDeclaration(stmt)) &&
      stmt.name !== undefined &&
      ts.isIdentifier(stmt.name)
    ) {
      names.add(stmt.name.text);
    }
  }
  return names;
}

function makeCoreImport(names: readonly string[], coreModule: string): ts.ImportDeclaration {
  const specifiers = names.map((name) =>
    ts.factory.createImportSpecifier(false, undefined, ts.factory.createIdentifier(name)),
  );
  return ts.factory.createImportDeclaration(
    undefined,
    ts.factory.createImportClause(false, undefined, ts.factory.createNamedImports(specifiers)),
    ts.factory.createStringLiteral(coreModule),
  );
}

function makeDefineProcessor(
  declarations: readonly ts.Statement[],
  processBody: readonly ts.Statement[],
  optionsArg: ts.Expression | undefined,
  exportName: string | undefined,
): ts.Statement {
  const processArrow = ts.factory.createArrowFunction(
    undefined,
    undefined,
    [],
    undefined,
    ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    ts.factory.createBlock(processBody, true),
  );
  const returnObject = ts.factory.createReturnStatement(
    ts.factory.createObjectLiteralExpression(
      [ts.factory.createPropertyAssignment("process", processArrow)],
      true,
    ),
  );
  const ctxParam = ts.factory.createParameterDeclaration(
    undefined,
    undefined,
    ts.factory.createIdentifier("ctx"),
  );
  const bodyArrow = ts.factory.createArrowFunction(
    undefined,
    undefined,
    [ctxParam],
    undefined,
    ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    ts.factory.createBlock([...declarations, returnObject], true),
  );
  const args = optionsArg === undefined ? [bodyArrow] : [bodyArrow, optionsArg];
  const call = ts.factory.createCallExpression(
    ts.factory.createIdentifier("defineProcessor"),
    undefined,
    args,
  );
  if (exportName !== undefined) {
    return ts.factory.createVariableStatement(
      [ts.factory.createToken(ts.SyntaxKind.ExportKeyword)],
      ts.factory.createVariableDeclarationList(
        [ts.factory.createVariableDeclaration(exportName, undefined, undefined, call)],
        ts.NodeFlags.Const,
      ),
    );
  }
  return ts.factory.createExportAssignment(undefined, false, call);
}

/** Build the optional `defineProcessor` options arg from `migrations()` / `options()`. */
function makeOptionsArg(
  migrations: ts.Expression | undefined,
  options: ts.Expression | undefined,
): ts.Expression | undefined {
  const props: ts.ObjectLiteralElementLike[] = [];
  if (migrations !== undefined) {
    props.push(ts.factory.createPropertyAssignment("migrations", migrations));
  }
  if (options !== undefined) {
    props.push(ts.factory.createSpreadAssignment(options));
  }
  if (props.length === 0) return undefined;
  return ts.factory.createObjectLiteralExpression(props, true);
}

/** A synthesized `const <varName> = <factory>({ channels, name });` declaration.
 * Built with the factory (not parsed) so it carries no source positions — the
 * printer must generate its text from structure, not read a foreign source. */
function makeAudioDecl(
  varName: string,
  factory: string,
  channels: number,
  port: string,
): ts.Statement {
  const call = ts.factory.createCallExpression(ts.factory.createIdentifier(factory), undefined, [
    ts.factory.createObjectLiteralExpression(
      [
        ts.factory.createPropertyAssignment("channels", ts.factory.createNumericLiteral(channels)),
        ts.factory.createPropertyAssignment("name", ts.factory.createStringLiteral(port)),
      ],
      false,
    ),
  ]);
  return ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList(
      [ts.factory.createVariableDeclaration(varName, undefined, undefined, call)],
      ts.NodeFlags.Const,
    ),
  );
}

/** Whether a top-level statement exports something (an `export` modifier, or a
 * bare `export { ... }` / `export default`). Used to tell a library module (no
 * `process()`, but exports a value) from a no-op file (neither). */
function isExportedStatement(stmt: ts.Statement): boolean {
  if (ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt)) return true;
  const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** Whether any of `nodes` contains a call to the bare identifier `calleeName`. */
function referencesCall(nodes: readonly ts.Node[], calleeName: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === calleeName
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  for (const n of nodes) visit(n);
  return found;
}

/**
 * Identifiers whose presence in a statement pins it to the processor body: the
 * ambient DSL surface (only meaningful inside the `defineProcessor` capture),
 * the injected stereo I/O handles, and the top-level macros.
 */
const DSL_TAINT_ROOTS = new Set<string>([
  ...CORE_AUTHORING_EXPORTS,
  "input",
  "out",
  "process",
  "migrations",
  "options",
  "$prev",
]);

/**
 * Split the processor file's non-macro statements into module-scope `hoisted`
 * and wrapper-body `inner` (issue #44). Lowering wraps the body into
 * `defineProcessor((ctx) => {...})`, and an `export` swallowed into that
 * callback emits invalid JavaScript — so an exported declaration moves OUT,
 * together with its dependency closure, but only when nothing in that closure
 * touches the DSL (a DSL declaration only exists inside the capture). A
 * DSL-dependent or structurally-unsupported export is a loud `LowerError`
 * (`uwk-export-unsupported`) — never an emit that fails later and elsewhere.
 *
 * Taint is computed as a fixpoint over identifier references: a statement is
 * tainted by naming a DSL root, by referencing a tainted binding, or by being
 * a form the hoist cannot carry (a destructuring declaration). Non-exported
 * untainted statements move only if a hoisted export's closure needs them —
 * everything else keeps its place (and its per-capture evaluation timing).
 */
function partitionModuleScopeExports(
  statements: readonly ts.Statement[],
  /**
   * How the file's own imports classify the names they bind. A name imported
   * from a module OTHER than the core is that module's, whatever it is spelled;
   * a name imported FROM the core is the DSL under whatever local name it was
   * given (`{ state as makeState }`, `* as core`), which no spelling test on
   * `DSL_TAINT_ROOTS` would catch.
   */
  imported: { readonly dsl: ReadonlySet<string>; readonly other: ReadonlySet<string> },
): {
  hoisted: ts.Statement[];
  inner: ts.Statement[];
} {
  // Value and type live in separate namespaces, and one name can hold both
  // (`const Level = ...` beside `interface Level {}`). One map would let
  // whichever came last answer for both, so a value reference could resolve to
  // a type declaration and follow the wrong dependency out of the wrapper.
  // Each name maps to EVERY statement declaring it: namespaces, interfaces and
  // function overloads merge across statements, and a hoisted export needs all
  // the pieces of what it names, not the last one written.
  const valueBindingOf = new Map<string, number[]>();
  const typeBindingOf = new Map<string, number[]>();
  const record = (map: Map<string, number[]>, name: string, idx: number): void => {
    const existing = map.get(name);
    if (existing === undefined) map.set(name, [idx]);
    else existing.push(idx);
  };
  statements.forEach((stmt, idx) => {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) record(valueBindingOf, d.name.text, idx);
      }
      return;
    }
    // A `var` inside a control statement belongs to the module, not the block
    // it sits in — an export reading it depends on the whole statement, so the
    // closure has to carry that statement out. A function's own body vars stay
    // its own, which is why a function-like statement is skipped here.
    if (!ts.isFunctionLike(stmt)) {
      const nestedVars = new Set<string>();
      collectFunctionScopedVars(stmt, nestedVars);
      for (const name of nestedVars) record(valueBindingOf, name, idx);
    }
    const declared = (stmt as { name?: ts.Node }).name;
    if (declared === undefined || !ts.isIdentifier(declared)) return;
    const name = declared.text;
    // Enums, classes and namespaces bind a runtime value, so an export reading
    // one depends on it exactly as it would on a const — and they name a type
    // as well, which an annotation may reach.
    if (
      ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isModuleDeclaration(stmt)
    ) {
      record(valueBindingOf, name, idx);
    }
    // A type alias or interface binds nothing at runtime, but an exported
    // declaration annotated with one still needs it in scope beside it.
    if (
      ts.isClassDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt)
    ) {
      record(typeBindingOf, name, idx);
    }
  });

  /**
   * Which namespace a reference reads. `typeQuery` is a `typeof X` inside a
   * type: erased like any type, but naming a VALUE.
   */
  type RefPosition = "value" | "type" | "typeQuery";

  const NO_BINDINGS: readonly number[] = [];

  /**
   * `name` plus every binding it is a bare alias of — `const alias = helper`
   * puts `helper` in the chain, transitively. Only a plain identifier
   * initializer counts: anything computed is not an alias this can follow.
   */
  const aliasChain = (name: string): Set<string> => {
    const chain = new Set<string>([name]);
    const queue = [name];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const idx of valueBindingOf.get(current) ?? NO_BINDINGS) {
        const stmt = statements[idx];
        if (stmt === undefined || !ts.isVariableStatement(stmt)) continue;
        for (const d of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || d.name.text !== current) continue;
          const init = d.initializer === undefined ? undefined : unwrapExpression(d.initializer);
          if (init === undefined || !ts.isIdentifier(init) || chain.has(init.text)) continue;
          chain.add(init.text);
          queue.push(init.text);
        }
      }
    }
    return chain;
  };

  const resolveBinding = (name: string, position: RefPosition): readonly number[] => {
    if (position === "value") return valueBindingOf.get(name) ?? NO_BINDINGS;
    if (position === "typeQuery") {
      return valueBindingOf.get(name) ?? typeBindingOf.get(name) ?? NO_BINDINGS;
    }
    // A type position falls back to the value namespace for the declarations
    // that name both (class / enum / namespace).
    return typeBindingOf.get(name) ?? valueBindingOf.get(name) ?? NO_BINDINGS;
  };

  const addBindings = (into: Set<number>, indices: readonly number[]): void => {
    for (const idx of indices) into.add(idx);
  };

  /** Identifier is a NAME position (`a.foo`, `{ foo: v }`), not a value reference. */
  const isNamePosition = (n: ts.Identifier): boolean => {
    // Synthesized nodes (auto-name / sugar factory updates) carry no parent;
    // treat them as value references (the conservative direction — a name
    // position mistaken for a reference can only ADD taint, never lose it).
    const p = n.parent as ts.Node | undefined;
    if (p === undefined) return false;
    if (ts.isPropertyAccessExpression(p) && p.name === n) return true;
    // `Types.min` in a type — the right side names a member of the left, the
    // same way a property access does in an expression.
    if (ts.isQualifiedName(p) && p.right === n) return true;
    // `import("./types.ts").min` — every part of the qualifier names something
    // in THAT module, the leftmost included: there is no local binding to read.
    if (ts.isImportTypeNode(p) && p.qualifier === n) return true;
    if (ts.isQualifiedName(p) && p.left === n && isImportTypeQualifier(p)) return true;
    if (ts.isPropertyAssignment(p) && p.name === n) return true;
    if (ts.isMethodDeclaration(p) && p.name === n) return true;
    if (ts.isPropertyDeclaration(p) && p.name === n) return true;
    // `{ input: value }` — the key names what is read out of the object, not a
    // binding the statement depends on.
    if (ts.isBindingElement(p) && p.propertyName === n) return true;
    if (ts.isEnumMember(p) && p.name === n) return true;
    if (ts.isGetAccessorDeclaration(p) && p.name === n) return true;
    if (ts.isSetAccessorDeclaration(p) && p.name === n) return true;
    // Type-member keys (`interface Levels { gain: number }`) name a member of
    // the type, not the `gain` a statement may declare beside it.
    if (ts.isPropertySignature(p) && p.name === n) return true;
    if (ts.isMethodSignature(p) && p.name === n) return true;
    // `[min: number]` — the tuple label names the slot, nothing else.
    if (ts.isNamedTupleMember(p) && p.name === n) return true;
    // A type parameter's name declares it — `<T>` and `infer X` alike.
    if (ts.isTypeParameterDeclaration(p) && p.name === n) return true;
    // A statement label lives in its own namespace and reads no value.
    if (ts.isLabeledStatement(p) && p.label === n) return true;
    if (ts.isBreakStatement(p) && p.label === n) return true;
    if (ts.isContinueStatement(p) && p.label === n) return true;
    return false;
  };

  /**
   * The names a node binds in the scope it opens, or null when it opens none.
   * `input`, `min`, `out` and friends are DSL roots AND everyday parameter
   * names, so a reference has to be resolved against the scopes enclosing it —
   * matching on spelling alone rejects pure helpers that never touch the DSL.
   */
  const scopeBindings = (n: ts.Node): Set<string> | null => {
    const names = new Set<string>();
    const addStatementBindings = (body: readonly ts.Statement[]): void => {
      for (const name of statementBoundNames(body)) names.add(name);
    };
    // A type parameter binds its name for the declaration that introduces it,
    // so `function id<input>(...)` is that declaration's `input`.
    const typeParameters = (n as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> })
      .typeParameters;
    if (typeParameters !== undefined) {
      for (const tp of typeParameters) names.add(tp.name.text);
    }
    // A mapped type carries a singular `typeParameter` — `{ [K in Keys]: T }`.
    if (ts.isMappedTypeNode(n)) names.add(n.typeParameter.name.text);
    if (ts.isClassStaticBlockDeclaration(n)) {
      // Its own `var` scope, collected here so the block sees its nested
      // declarations without leaking them into the enclosing function.
      collectFunctionScopedVars(n, names);
    }
    if (ts.isFunctionLike(n)) {
      for (const p of n.parameters) collectBindingNames(p.name, names);
      if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n.name !== undefined) {
        names.add(n.name.text);
      }
      // Body `var`s are NOT added here: a default parameter initializer is
      // evaluated in the parameter scope, before the body's bindings exist, so
      // `visit` applies them to the body child alone.
    } else if (ts.isBlock(n) || ts.isModuleBlock(n)) {
      addStatementBindings(n.statements);
      // A namespace body is its own `var` scope: the outer collector stops at
      // the boundary, so the block collects what is nested inside it.
      if (ts.isModuleBlock(n)) collectFunctionScopedVars(n, names);
    } else if (ts.isCaseBlock(n)) {
      // One block scope spans every clause of the switch.
      for (const clause of n.clauses) addStatementBindings(clause.statements);
    } else if (ts.isCatchClause(n)) {
      if (n.variableDeclaration !== undefined)
        collectBindingNames(n.variableDeclaration.name, names);
    } else if (ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) {
      const init = n.initializer;
      if (init !== undefined && ts.isVariableDeclarationList(init)) {
        for (const d of init.declarations) collectBindingNames(d.name, names);
      }
    } else if ((ts.isClassDeclaration(n) || ts.isClassExpression(n)) && n.name !== undefined) {
      names.add(n.name.text);
    } else if (ts.isEnumDeclaration(n)) {
      // A member is in scope for the members after it (`Copy = input`).
      for (const member of n.members) {
        if (ts.isIdentifier(member.name)) names.add(member.name.text);
      }
    }
    return names.size > 0 ? names : null;
  };

  const refs = statements.map((stmt) => {
    const bindings = new Set<number>();
    const dsl = new Set<string>();
    const exportIsTypeOnly = ts.isExportDeclaration(stmt) && stmt.isTypeOnly;
    // `export { x } from "./other.ts"` names the OTHER module's exports. It
    // binds nothing here and depends on nothing here, so resolving its
    // specifiers locally would drag an unrelated declaration that happens to
    // share a name out of the wrapper with it.
    const isReExport = ts.isExportDeclaration(stmt) && stmt.moduleSpecifier !== undefined;
    const visit = (n: ts.Node, shadowed: ReadonlySet<string>, position: RefPosition): void => {
      // An export specifier names a binding directly rather than referencing
      // one, and it chooses its namespace: `export { type Level }` takes the
      // type, a plain `export { Level }` takes the value and carries the type
      // of a merged name along with it.
      if (ts.isExportSpecifier(n)) {
        if (isReExport) return;
        const local = n.propertyName?.text ?? n.name.text;
        if (n.isTypeOnly || exportIsTypeOnly) {
          addBindings(bindings, resolveBinding(local, "type"));
        } else {
          addBindings(bindings, valueBindingOf.get(local) ?? NO_BINDINGS);
          addBindings(bindings, typeBindingOf.get(local) ?? NO_BINDINGS);
        }
        return;
      }
      if (ts.isIdentifier(n) && !isNamePosition(n) && !shadowed.has(n.text)) {
        const declaring = resolveBinding(n.text, position);
        // A module-scope declaration owns the name throughout the module, DSL
        // root or not — `export const clamp = ...` is the file's `clamp`, and
        // its own declaration name is not a reference to the ambient one. Taint
        // still reaches it through the dependency edge when that declaration is
        // itself DSL-tied.
        if (declaring.length > 0) addBindings(bindings, declaring);
        // A name reached only through a type is erased at emit, so it cannot
        // tie the declaration to the capture — `export type Signal =
        // Node<"f32">` names the DSL without depending on it. The dependency
        // edge above still applies: an annotation's own type alias has to
        // travel with the declaration it annotates. A `typeof X` is the
        // exception: erased too, but it names a VALUE, and a hoisted alias
        // still has to see that value where it lands — so it taints like one.
        else if (position === "type") return;
        else if (imported.dsl.has(n.text)) dsl.add(n.text);
        else if (!imported.other.has(n.text) && DSL_TAINT_ROOTS.has(n.text)) dsl.add(n.text);
      }
      const opened = scopeBindings(n);
      const inner = opened === null ? shadowed : new Set([...shadowed, ...opened]);
      // `typeof X` sits inside a type but names a VALUE, so its entity name
      // keeps resolving in the value namespace all the way down.
      const childPosition: RefPosition = ts.isTypeQueryNode(n)
        ? "typeQuery"
        : position !== "value"
          ? position
          : ts.isTypeNode(n) || ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)
            ? "type"
            : "value";
      // A function's body sees its `var`s throughout, but a default parameter
      // initializer is evaluated before any of them exist — so the body child
      // gets the wider scope and the parameters keep the narrower one.
      let scopedChild: ts.Node | undefined;
      let scopedNames = inner;
      if (ts.isFunctionLike(n)) {
        const vars = new Set<string>();
        collectFunctionScopedVars(n, vars);
        scopedChild = (n as { body?: ts.Node }).body;
        if (vars.size > 0) scopedNames = new Set([...inner, ...vars]);
      } else if (ts.isConditionalTypeNode(n)) {
        // `T extends infer X ? X : never` — the infer'd name is bound for the
        // TRUE branch alone; the constraint and the false branch never see it.
        const inferred = new Set<string>();
        collectInferNames(n.extendsType, inferred);
        scopedChild = n.trueType;
        if (inferred.size > 0) scopedNames = new Set([...inner, ...inferred]);
      }
      // A class `extends` clause is an EXPRESSION that runs at evaluation, even
      // though its node satisfies `isTypeNode` like an interface's heritage
      // does. Reading it as erased would drop a real dependency.
      const heritage = n.parent as ts.Node | undefined;
      const classExtendsExpr =
        ts.isExpressionWithTypeArguments(n) &&
        heritage !== undefined &&
        ts.isHeritageClause(heritage) &&
        heritage.token === ts.SyntaxKind.ExtendsKeyword &&
        heritage.parent !== undefined &&
        (ts.isClassDeclaration(heritage.parent) || ts.isClassExpression(heritage.parent))
          ? n.expression
          : undefined;
      ts.forEachChild(n, (child) => {
        visit(
          child,
          child === scopedChild ? scopedNames : inner,
          child === classExtendsExpr ? "value" : childPosition,
        );
      });
    };
    // The statement's own top-level bindings stay visible: they are the module
    // bindings the dependency edges are drawn between.
    visit(stmt, new Set<string>(), "value");
    return { bindings, dsl };
  });

  const isDestructuredDecl = (stmt: ts.Statement): boolean =>
    ts.isVariableStatement(stmt) &&
    stmt.declarationList.declarations.some((d) => !ts.isIdentifier(d.name));

  // Taint fixpoint. A destructuring declaration is treated as tainted for
  // closure purposes: the hoist cannot carry it, so an export depending on it
  // is blocked (with the error naming it below).
  const tainted = statements.map((stmt, i) => refs[i]!.dsl.size > 0 || isDestructuredDecl(stmt));
  for (let changed = true; changed; ) {
    changed = false;
    statements.forEach((_, i) => {
      if (tainted[i]) return;
      for (const dep of refs[i]!.bindings) {
        if (dep !== i && tainted[dep]) {
          tainted[i] = true;
          changed = true;
          return;
        }
      }
    });
  }

  /** First DSL name reachable from statement `i` — the "why" for the error. */
  const taintReason = (start: number): string => {
    const seen = new Set<number>();
    const queue = [start];
    while (queue.length > 0) {
      const i = queue.shift()!;
      if (seen.has(i)) continue;
      seen.add(i);
      const dsl = [...refs[i]!.dsl];
      if (dsl.length > 0) return `it reaches the DSL identifier \`${dsl[0]}\``;
      if (isDestructuredDecl(statements[i]!)) {
        return "it depends on a destructuring declaration, which the hoist cannot carry";
      }
      for (const dep of refs[i]!.bindings) queue.push(dep);
    }
    return "it depends on a declaration that must stay inside the processor body";
  };

  const exportName = (stmt: ts.Statement): string => {
    if (ts.isVariableStatement(stmt)) {
      const first = stmt.declarationList.declarations[0];
      if (first !== undefined && ts.isIdentifier(first.name)) return first.name.text;
    }
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name !== undefined)
      return stmt.name.text;
    return "(export)";
  };

  const mustHoist = new Set<number>();
  statements.forEach((stmt, i) => {
    if (ts.isExportAssignment(stmt)) {
      throw new LowerError(
        "uwk-export-unsupported",
        "`export default` cannot appear in a processor .uwk.ts — the lowered module's " +
          "export IS the processor. Export a named value instead.",
      );
    }
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.moduleSpecifier !== undefined) {
        // `export ... from "./x"` is import-like: no local bindings involved.
        mustHoist.add(i);
        return;
      }
      // `export { a, b }` — every named binding must be hoistable.
      if (stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause)) {
        for (const spec of stmt.exportClause.elements) {
          // An export list picks its namespace: `export { type Level }` (or
          // `export type { Level }`) takes the type declaration, a plain
          // `export { Level }` takes the value.
          const local = spec.propertyName?.text ?? spec.name.text;
          // A plain `export { Level }` carries BOTH declarations of a merged
          // name out, so both have to be hoistable — checking only the value
          // side passes a pure const standing beside a DSL-tied type alias.
          const deps =
            spec.isTypeOnly || stmt.isTypeOnly
              ? resolveBinding(local, "type")
              : [
                  ...(valueBindingOf.get(local) ?? NO_BINDINGS),
                  ...(typeBindingOf.get(local) ?? NO_BINDINGS),
                ];
          const blocked = deps.find((d) => tainted[d]);
          if (deps.length === 0 || blocked !== undefined) {
            throw new LowerError(
              "uwk-export-unsupported",
              `\`export { ${spec.name.text} }\` cannot move to module scope: ` +
                `${blocked === undefined ? "the binding is not a top-level declaration" : taintReason(blocked)}. ` +
                "A value tied to the DSL lives only inside the processor capture — expose it " +
                "through the processor surface (param / state / event) instead.",
            );
          }
        }
      }
      mustHoist.add(i);
      return;
    }
    if (!isExportedStatement(stmt)) return;
    if (isDestructuredDecl(stmt)) {
      throw new LowerError(
        "uwk-export-unsupported",
        `exported destructuring declarations are not supported in a processor .uwk.ts — ` +
          `export each value as its own \`export const <name> = ...\`.`,
      );
    }
    if (tainted[i]) {
      throw new LowerError(
        "uwk-export-unsupported",
        `\`export ${exportName(stmt)}\` cannot move to module scope: ${taintReason(i)}. ` +
          "A value tied to the DSL lives only inside the processor capture — expose it " +
          "through the processor surface (param / state / event), or move pure helpers " +
          "to a separate module.",
      );
    }
    mustHoist.add(i);
  });

  // Closure: pull the (untainted, by fixpoint) dependencies of every hoisted
  // statement out with it.
  const queue = [...mustHoist];
  while (queue.length > 0) {
    const i = queue.pop()!;
    for (const dep of refs[i]!.bindings) {
      if (!mustHoist.has(dep)) {
        mustHoist.add(dep);
        queue.push(dep);
      }
    }
  }

  // A hoisted declaration keeps its initializer, but a bare `helper = 1` is a
  // statement nothing references, so the closure has no reason to carry it and
  // it stays in the wrapper. Moving a hoisted declaration PAST such a write
  // makes it read a value the source never gives it — silently. A write that
  // stands after what it cannot affect is fine: source order already gives the
  // earlier statement the pre-write value.
  for (const [i, stmt] of statements.entries()) {
    if (mustHoist.has(i)) continue;
    const written = statementWrites(stmt);
    if (written.size === 0) continue;
    // `const alias = helper; alias.value = 1` writes what `helper` holds, so a
    // write follows a chain of bare-identifier aliases back to its source. An
    // alias built by anything else — a call, a conditional, a property read —
    // is not followed, the same limit as mutation through a call.
    for (const name of [...written].flatMap((n) => [...aliasChain(n)])) {
      for (const decl of valueBindingOf.get(name) ?? NO_BINDINGS) {
        if (!mustHoist.has(decl)) continue;
        // The statement that READS it is what the write has to precede.
        const reader = statements.findIndex(
          (_, j) => j > i && mustHoist.has(j) && refs[j]!.bindings.has(decl),
        );
        if (reader === -1) continue;
        throw new LowerError(
          "uwk-export-unsupported",
          `\`export ${exportName(statements[reader]!)}\` cannot move to module scope: ` +
            `\`${name}\` is assigned by an earlier statement that stays inside the processor, ` +
            `so the export would read the value from before that assignment. Compute the ` +
            `exported value in its own initializer rather than assigning to it beforehand.`,
        );
      }
    }
  }

  const hoisted: ts.Statement[] = [];
  const inner: ts.Statement[] = [];
  statements.forEach((stmt, i) => {
    (mustHoist.has(i) ? hoisted : inner).push(stmt);
  });
  return { hoisted, inner };
}

/** Lower a `.uwk.ts` source string to a virtual `.ts` module string. */
export function lower(source: string, options: LowerOptions = {}): string {
  const coreModule = options.coreModule ?? "@unworklet/core";
  // Build the type-directed program, then run the sugar passes (their type
  // queries hit the pristine source). The remaining split / wrap / ambient logic
  // operates on the desugared statements.
  const { checker, sourceFile } = buildProgram(source, {
    snapshot: options.snapshot,
    record: options.captureInto,
    sourcePath: options.sourcePath,
  });
  const sf = ts.transform(sourceFile, [sugarTransformer(checker)]).transformed[0] as ts.SourceFile;

  let processBody: ts.Statement[] | undefined;
  let processCount = 0;
  const declarations: ts.Statement[] = [];
  const userImports: ts.ImportDeclaration[] = [];
  let migrationsArg: ts.Expression | undefined;
  let optionsObject: ts.Expression | undefined;

  for (const stmt of sf.statements) {
    const macro = topLevelMacroCall(stmt);
    if (macro?.name === PROCESS_MACRO) {
      processCount += 1;
      const body = callbackBody(macro.call);
      if (body === undefined) {
        throw new LowerError(
          "uwk-bad-process",
          "process(...) must take an arrow or function callback",
        );
      }
      processBody = body;
      continue;
    }
    if (macro?.name === MIGRATIONS_MACRO) {
      migrationsArg = macro.call.arguments[0];
      continue;
    }
    if (macro?.name === OPTIONS_MACRO) {
      optionsObject = macro.call.arguments[0];
      continue;
    }
    if (ts.isImportDeclaration(stmt)) {
      // A .uwk.ts is ambient — the @unworklet/core DSL needs no import — but a
      // user import (sharing constants / params / helpers from a sibling file)
      // must survive at module scope, NOT be moved into the defineProcessor
      // callback (an illegal nested import). Keep it at the top of the lowered
      // module; the bindings it introduces stay in scope for the callback by
      // closure. The lowered module is emitted next to the source, so a relative
      // specifier resolves unchanged.
      userImports.push(stmt);
      continue;
    }
    declarations.push(autoNameDeclaration(stmt));
  }

  if (processCount === 0) {
    // No process() = a "library module": emit the (already-desugared) top-level
    // declarations + exports as a plain module — no defineProcessor wrap, no
    // synthesized ambient stereo I/O. Consumed via a normal import (e.g. a file
    // that `export`s a defineSubgraph; a processor file imports it and places
    // instances with instantiate()).
    if (migrationsArg !== undefined || optionsObject !== undefined) {
      throw new LowerError(
        "uwk-options-without-process",
        "migrations() / options() are processor-only — a .uwk.ts with no process() " +
          "call is a library module and cannot carry them.",
      );
    }
    if (!declarations.some(isExportedStatement)) {
      throw new LowerError(
        "uwk-empty",
        "a .uwk.ts must contain a process(() => {...}) call, or export at least one " +
          "value (e.g. `export const x = defineSubgraph(...)`).",
      );
    }
    const used = collectUsedCoreExports(sf);
    for (const name of importBoundNames(userImports, { valuesOnly: true })) used.delete(name);
    for (const name of statementBoundNames(declarations)) used.delete(name);
    const importDecl = makeCoreImport([...used].sort(), coreModule);
    const lowered = ts.factory.updateSourceFile(sf, [...userImports, importDecl, ...declarations]);
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    return printer.printFile(lowered);
  }
  if (processCount > 1) {
    throw new LowerError(
      "uwk-multiple-process",
      "a .uwk.ts file must contain exactly one process(...) call",
    );
  }

  // Module-scope exports leave the wrapper (with their dependency closure);
  // everything else becomes the defineProcessor body (issue #44).
  const { hoisted, inner } = partitionModuleScopeExports(declarations, {
    dsl: importBoundNames(userImports.filter((d) => moduleSpecifierOf(d) === coreModule)),
    other: importBoundNames(userImports.filter((d) => moduleSpecifierOf(d) !== coreModule)),
  });

  // Reject options() / migrations() that reference a processor-body binding: the
  // declarations are moved into the defineProcessor callback, but the options
  // argument is attached outside it, so such a reference would be out of scope at
  // module evaluation. (Reported by @codex on #12.)
  const bodyBindings = statementBoundNames(inner);
  const optionRefs = (expr: ts.Expression | undefined): string[] => {
    if (expr === undefined) return [];
    const hits = new Set<string>();
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && bodyBindings.has(n.text)) hits.add(n.text);
      ts.forEachChild(n, visit);
    };
    visit(expr);
    return [...hits];
  };
  const referenced = [...new Set([...optionRefs(migrationsArg), ...optionRefs(optionsObject)])];
  if (referenced.length > 0) {
    throw new LowerError(
      "uwk-options-binding",
      `options() / migrations() cannot reference a processor-body binding (${referenced
        .map((n) => `\`${n}\``)
        .join(", ")}): declarations are moved into the defineProcessor callback, so the ` +
        "reference would be out of scope. Inline the value, or move the binding into the object literal.",
    );
  }

  // S12: inject ambient stereo input / out when the file declares neither, so a
  // Tier-C .uwk.ts needs no explicit I/O. An explicit declaration suppresses it.
  const needInput = !referencesCall(inner, "audioInput");
  const needOutput = !referencesCall(inner, "audioOutput");
  const ambient: ts.Statement[] = [];
  if (needInput) {
    ambient.push(makeAudioDecl("input", "audioInput", 2, "input"));
  }
  if (needOutput) {
    ambient.push(makeAudioDecl("out", "audioOutput", 2, "out"));
  }
  const allDeclarations = [...ambient, ...inner];

  // The lowering writes code of its own: the `defineProcessor` wrapper, and —
  // when the file declares no audio I/O — the ambient `input` / `out` and the
  // factories they call. A file that binds one of those names would have the
  // generated code resolve to ITS binding, exporting something that is not a
  // processor or wiring I/O that is not the DSL's. Refuse instead: the name is
  // only reserved when the lowering is actually about to generate it, so
  // `const out = audioOutput(...)` — which suppresses the injection — is
  // unaffected.
  const generatedBindings = new Set<string>(["defineProcessor"]);
  if (needInput) {
    generatedBindings.add("input");
    generatedBindings.add("audioInput");
  }
  if (needOutput) {
    generatedBindings.add("out");
    generatedBindings.add("audioOutput");
  }
  // Any local binding of a generated name collides — a declaration, an import
  // from elsewhere, or a type-only import (erased, so it supplies no value, yet
  // it still occupies the name beside the injected import). The one exception
  // is a VALUE import of the same name from the core: that is the very binding
  // the generated code wants, and the injected import stands down for it.
  // That exemption requires the local name and the imported export to be the
  // SAME: `{ defineProcessor as audioInput }` binds `audioInput` to the wrong
  // factory, and the ambient declaration would call it.
  const coreValueImports = unaliasedCoreValueImports(userImports, coreModule);
  const boundHere = statementBoundNames(declarations);
  // A `var` nested in a control statement binds at module scope and, once the
  // statement moves into the callback, shadows the injected import there.
  for (const stmt of declarations) {
    if (ts.isFunctionLike(stmt)) continue;
    collectFunctionScopedVars(stmt, boundHere);
  }
  for (const name of importBoundNames(userImports)) {
    if (!coreValueImports.has(name)) boundHere.add(name);
  }
  const reserved = [...generatedBindings].find((name) => boundHere.has(name));
  if (reserved !== undefined) {
    throw new LowerError(
      "uwk-reserved-binding",
      `\`${reserved}\` is generated by the lowering in this file, so binding that name here — ` +
        `by declaration or by import from another module — would take its place. Rename it, or ` +
        `import it under an alias. (The ambient \`input\` / \`out\` and their factories are only ` +
        `generated when the file declares no audio I/O of its own.)`,
    );
  }

  const used = collectUsedCoreExports(sf);
  if (needInput) used.add("audioInput");
  if (needOutput) used.add("audioOutput");
  used.add("defineProcessor");
  // Drop any name the user imports explicitly so the injected core import never
  // double-binds it (their import provides it). This also strips the user
  // import's own specifier identifiers, which `collectUsedCoreExports` counts.
  for (const name of importBoundNames(userImports, { valuesOnly: true })) used.delete(name);
  // Same for a name the file declares itself: a hoisted `export const clamp`
  // sits at module scope beside the import (a duplicate binding), and a
  // declaration left inside the wrapper shadows the import for the whole body,
  // so no reference could reach it either way.
  for (const name of statementBoundNames(declarations)) used.delete(name);
  const importDecl = makeCoreImport([...used].sort(), coreModule);
  const optionsArg = makeOptionsArg(migrationsArg, optionsObject);
  const exported = makeDefineProcessor(
    allDeclarations,
    processBody!,
    optionsArg,
    options.exportName,
  );

  const lowered = ts.factory.updateSourceFile(sf, [
    ...userImports,
    importDecl,
    ...hoisted,
    exported,
  ]);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  return printer.printFile(lowered);
}
