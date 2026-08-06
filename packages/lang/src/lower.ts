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

/** Lower a `.uwk.ts` source string to a virtual `.ts` module string. */
export function lower(source: string, options: LowerOptions = {}): string {
  const coreModule = options.coreModule ?? "@unworklet/core";
  // Build the type-directed program, then run the sugar passes (their type
  // queries hit the pristine source). The remaining split / wrap / ambient logic
  // operates on the desugared statements.
  const { checker, sourceFile } = buildProgram(source, {
    snapshot: options.snapshot,
    record: options.captureInto,
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

  // Reject options() / migrations() that reference a processor-body binding: the
  // declarations are moved into the defineProcessor callback, but the options
  // argument is attached outside it, so such a reference would be out of scope at
  // module evaluation. (Reported by @codex on #12.)
  const bodyBindings = new Set<string>();
  const collectBindingNames = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      bodyBindings.add(name.text);
      return;
    }
    // ObjectBindingPattern | ArrayBindingPattern — recurse into each element
    // (array holes are OmittedExpression, not BindingElement, so they are skipped).
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) collectBindingNames(el.name);
    }
  };
  for (const decl of declarations) {
    if (ts.isVariableStatement(decl)) {
      for (const d of decl.declarationList.declarations) collectBindingNames(d.name);
    } else if (ts.isFunctionDeclaration(decl) && decl.name !== undefined) {
      bodyBindings.add(decl.name.text);
    } else if (ts.isClassDeclaration(decl) && decl.name !== undefined) {
      bodyBindings.add(decl.name.text);
    }
  }
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
  const needInput = !referencesCall(declarations, "audioInput");
  const needOutput = !referencesCall(declarations, "audioOutput");
  const ambient: ts.Statement[] = [];
  if (needInput) {
    ambient.push(makeAudioDecl("input", "audioInput", 2, "input"));
  }
  if (needOutput) {
    ambient.push(makeAudioDecl("out", "audioOutput", 2, "out"));
  }
  const allDeclarations = [...ambient, ...declarations];

  const used = collectUsedCoreExports(sf);
  if (needInput) used.add("audioInput");
  if (needOutput) used.add("audioOutput");
  used.add("defineProcessor");
  // Drop any name the user imports explicitly so the injected core import never
  // double-binds it (their import provides it). This also strips the user
  // import's own specifier identifiers, which `collectUsedCoreExports` counts.
  for (const name of importBoundNames(userImports)) used.delete(name);
  const importDecl = makeCoreImport([...used].sort(), coreModule);
  const optionsArg = makeOptionsArg(migrationsArg, optionsObject);
  const exported = makeDefineProcessor(
    allDeclarations,
    processBody!,
    optionsArg,
    options.exportName,
  );

  const lowered = ts.factory.updateSourceFile(sf, [...userImports, importDecl, exported]);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  return printer.printFile(lowered);
}
