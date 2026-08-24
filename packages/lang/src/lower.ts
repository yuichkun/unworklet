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
function importBoundNames(imports: readonly ts.ImportDeclaration[]): Set<string> {
  const names = new Set<string>();
  for (const decl of imports) {
    const clause = decl.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      names.add(bindings.name.text);
    } else {
      for (const el of bindings.elements) names.add(el.name.text);
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
  const valueBindingOf = new Map<string, number>();
  const typeBindingOf = new Map<string, number>();
  statements.forEach((stmt, idx) => {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) valueBindingOf.set(d.name.text, idx);
      }
      return;
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
      valueBindingOf.set(name, idx);
    }
    // A type alias or interface binds nothing at runtime, but an exported
    // declaration annotated with one still needs it in scope beside it.
    if (
      ts.isClassDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt)
    ) {
      typeBindingOf.set(name, idx);
    }
  });

  /** Identifier is a NAME position (`a.foo`, `{ foo: v }`), not a value reference. */
  const isNamePosition = (n: ts.Identifier): boolean => {
    // Synthesized nodes (auto-name / sugar factory updates) carry no parent;
    // treat them as value references (the conservative direction — a name
    // position mistaken for a reference can only ADD taint, never lose it).
    const p = n.parent as ts.Node | undefined;
    if (p === undefined) return false;
    if (ts.isPropertyAccessExpression(p) && p.name === n) return true;
    if (ts.isPropertyAssignment(p) && p.name === n) return true;
    if (ts.isMethodDeclaration(p) && p.name === n) return true;
    if (ts.isPropertyDeclaration(p) && p.name === n) return true;
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
    if (ts.isFunctionLike(n)) {
      for (const p of n.parameters) collectBindingNames(p.name, names);
      if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n.name !== undefined) {
        names.add(n.name.text);
      }
    } else if (ts.isBlock(n) || ts.isModuleBlock(n)) {
      addStatementBindings(n.statements);
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
    }
    return names.size > 0 ? names : null;
  };

  const refs = statements.map((stmt) => {
    const bindings = new Set<number>();
    const dsl = new Set<string>();
    const visit = (n: ts.Node, shadowed: ReadonlySet<string>, inType: boolean): void => {
      if (ts.isIdentifier(n) && !isNamePosition(n) && !shadowed.has(n.text)) {
        // A type position resolves in the type namespace, falling back to the
        // value one for the declarations that name both (class / enum /
        // namespace) and for a `typeof x` query.
        const b = inType
          ? (typeBindingOf.get(n.text) ?? valueBindingOf.get(n.text))
          : valueBindingOf.get(n.text);
        // A module-scope declaration owns the name throughout the module, DSL
        // root or not — `export const clamp = ...` is the file's `clamp`, and
        // its own declaration name is not a reference to the ambient one. Taint
        // still reaches it through the dependency edge when that declaration is
        // itself DSL-tied.
        if (b !== undefined) bindings.add(b);
        // A name reached only through a type is erased at emit, so it cannot
        // tie the declaration to the capture — `export type Signal =
        // Node<"f32">` names the DSL without depending on it. The dependency
        // edge above still applies: an annotation's own type alias has to
        // travel with the declaration it annotates.
        else if (inType) return;
        else if (imported.dsl.has(n.text)) dsl.add(n.text);
        else if (!imported.other.has(n.text) && DSL_TAINT_ROOTS.has(n.text)) dsl.add(n.text);
      }
      const opened = scopeBindings(n);
      const inner = opened === null ? shadowed : new Set([...shadowed, ...opened]);
      const childInType =
        inType || ts.isTypeNode(n) || ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n);
      ts.forEachChild(n, (child) => {
        visit(child, inner, childInType);
      });
    };
    // The statement's own top-level bindings stay visible: they are the module
    // bindings the dependency edges are drawn between.
    visit(stmt, new Set<string>(), false);
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
          // An export list can name either namespace (`export { Level }` for
          // the value, `export { type Level }` for the type).
          const local = spec.propertyName?.text ?? spec.name.text;
          const dep = valueBindingOf.get(local) ?? typeBindingOf.get(local);
          if (dep === undefined || tainted[dep]) {
            throw new LowerError(
              "uwk-export-unsupported",
              `\`export { ${spec.name.text} }\` cannot move to module scope: ` +
                `${dep === undefined ? "the binding is not a top-level declaration" : taintReason(dep)}. ` +
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
    for (const name of importBoundNames(userImports)) used.delete(name);
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

  const used = collectUsedCoreExports(sf);
  if (needInput) used.add("audioInput");
  if (needOutput) used.add("audioOutput");
  used.add("defineProcessor");
  // Drop any name the user imports explicitly so the injected core import never
  // double-binds it (their import provides it). This also strips the user
  // import's own specifier identifiers, which `collectUsedCoreExports` counts.
  for (const name of importBoundNames(userImports)) used.delete(name);
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
