/**
 * AST helpers over a lowered `.ts` module's module specifiers, for the build
 * path's transitive `.uwk.ts` lowering: a processor `.uwk.ts` that pulls a
 * subgraph from a sibling `.uwk.ts` must have that sibling lowered too, and its
 * specifier rewritten to the lowered sibling. Operating on AST nodes (not the
 * source text) means an `import` inside a comment / string literal is ignored.
 *
 * "Module specifier" covers both directions a dependency can be written. A
 * subgraph library is often re-exported through a barrel
 * (`export { onepole } from "./onepole.uwk.ts"`), and that `export … from` is an
 * `ExportDeclaration`, not an `ImportDeclaration` — walking imports alone left
 * the barrel's temp pointing at raw `.uwk.ts`, whose bare DSL globals only exist
 * after lowering.
 */
import ts from "typescript";

/**
 * Every way a source can name another module, found by walking the whole tree —
 * a top-level scan misses two of the four, and both turned out to matter.
 *
 * - `declaration` — `import … from` / `export … from`. Carries its node, since
 *   these are the ones the rewriter can update.
 * - `type` — `import("./types.ts").Gain`, an ImportTypeNode. No runtime
 *   dependency, but the checker reads the file, so a type-directed lowering
 *   depends on it.
 * - `dynamic` — `import("./x.mjs")` as an expression. A real runtime load, at
 *   any nesting depth. (A non-literal argument is skipped: nothing here can say
 *   what it resolves to.)
 */
type ModuleRef =
  | { kind: "declaration"; stmt: ts.ImportDeclaration | ts.ExportDeclaration; spec: string }
  | { kind: "type"; spec: string }
  | { kind: "dynamic"; spec: string };

function moduleRefs(sf: ts.SourceFile): ModuleRef[] {
  const out: ModuleRef[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const s = node.moduleSpecifier;
      if (s !== undefined && ts.isStringLiteral(s)) {
        out.push({ kind: "declaration", stmt: node, spec: s.text });
      }
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)) {
        out.push({ kind: "type", spec: arg.literal.text });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteral(arg))
        out.push({ kind: "dynamic", spec: arg.text });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

/** The refs that load at runtime — everything except a type-position `import()`,
 * which is erased before anything runs. */
const runtimeRefs = (sf: ts.SourceFile): ModuleRef[] =>
  moduleRefs(sf).filter((r) => r.kind !== "type");

/** The module specifiers of a lowered `.ts` module that point at a `.uwk.ts`
 * (the transitive sugar imports and re-exports the build must lower too). */
export function uwkImportSpecifiers(loweredTs: string): string[] {
  const sf = ts.createSourceFile("__m.ts", loweredTs, ts.ScriptTarget.ESNext, true);
  const out: string[] = [];
  for (const { spec } of moduleRefs(sf)) {
    if (spec.endsWith(".uwk.ts") && !out.includes(spec)) out.push(spec);
  }
  return out;
}

/**
 * The plain relative `.ts` / `.mts` / `.cts` files an EMITTED temp still asks
 * Node to load — a helper the author imported (`import { GAIN } from
 * "./constants.ts"`), as opposed to a sibling `.uwk.ts`, which is lowered
 * separately. Nothing rewrites these, so the temp — JavaScript though it is —
 * still points at raw TypeScript, and only a Node that strips types can load it.
 *
 * Deliberately takes the transpiled output, not the lowered TypeScript. Whether a
 * specifier survives is not a structural property one can read off the source:
 * the emit drops a type-only import (`import { type Gain } …` marks the SPECIFIER,
 * not the clause, so a clause-level `isTypeOnly` check misses it) and equally
 * drops an import whose bindings go unused. Reading the emit instead of
 * predicting it means this reports exactly the set Node will try to resolve.
 */
export function plainTsModuleSpecifiers(emittedJs: string): string[] {
  const sf = ts.createSourceFile("__m.js", emittedJs, ts.ScriptTarget.ESNext, true);
  const out: string[] = [];
  for (const { spec } of runtimeRefs(sf)) {
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
    // Classified by the file part: ESM allows a query and a fragment on a file
    // URL, and an extension test against the raw specifier misses both.
    const asPath = spec.split(/[?#]/)[0]!;
    if (asPath.endsWith(".uwk.ts")) continue; // lowered separately, and remapped above
    // The three extensions Node strips once it can strip at all — and therefore
    // the three it cannot load when it cannot. (`.tsx` is excluded on purpose:
    // no Node version loads it, so it is not a capability question.)
    if (/\.(ts|mts|cts)$/.test(asPath) && !out.includes(spec)) out.push(spec);
  }
  return out;
}

/** Every module specifier a source names, in either direction — including
 * type-only edges, which carry no runtime dependency but very much affect a
 * type-directed lowering. */
export function moduleSpecifiers(source: string): string[] {
  return moduleRefs(ts.createSourceFile("__m.ts", source, ts.ScriptTarget.ESNext, true)).map(
    (r) => r.spec,
  );
}

/**
 * The specifiers a source still loads once Node's strip-only mode has erased its
 * types — for walking a module graph this package does not own and must not
 * rewrite, where Node is the loader.
 *
 * Only a CLAUSE-level `type` removes the edge (`import type { T } from …`,
 * `export type { T } from …`). The inline form (`export { type T } from …`)
 * does not: Node drops the specifier and keeps the statement, so the module is
 * still loaded. That is the opposite of what `ts.transpileModule` does with the
 * same syntax, which is why this cannot be shared with the emit-side scan.
 */
export function runtimeModuleSpecifiers(source: string): string[] {
  const sf = ts.createSourceFile("__m.ts", source, ts.ScriptTarget.ESNext, true);
  const out: string[] = [];
  for (const ref of runtimeRefs(sf)) {
    if (ref.kind === "declaration") {
      const typeOnly = ts.isImportDeclaration(ref.stmt)
        ? ref.stmt.importClause?.isTypeOnly === true
        : ref.stmt.isTypeOnly;
      if (typeOnly) continue;
    }
    out.push(ref.spec);
  }
  return out;
}

/**
 * The RELATIVE modules an emitted temp still asks Node to load, whatever their
 * extension — the author's own helper files, JavaScript ones included.
 *
 * Separate from `plainTsModuleSpecifiers`, which answers a narrower question
 * (which of them this Node cannot load at all). Anything reachable from a temp
 * can lead on to a `.uwk.ts`, and a `.mjs` helper leads there just as easily as
 * a `.ts` one — more easily, in fact, since `.mjs` is what the TypeScript
 * diagnostic recommends renaming to.
 */
export function relativeModuleSpecifiers(emittedJs: string): string[] {
  const sf = ts.createSourceFile("__m.js", emittedJs, ts.ScriptTarget.ESNext, true);
  const out: string[] = [];
  for (const { spec } of runtimeRefs(sf)) {
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
    if (!out.includes(spec)) out.push(spec);
  }
  return out;
}

/**
 * The subset of {@link relativeModuleSpecifiers} that {@link rewriteImportSpecifiers}
 * can actually change: an `import … from` or `export … from`. A dynamic
 * `import("./x.mjs")` is an expression, so its specifier stays as written — and
 * a caller that assumed otherwise would think it had rewritten something it had
 * not.
 */
export function rewritableRelativeSpecifiers(emittedJs: string): string[] {
  const sf = ts.createSourceFile("__m.js", emittedJs, ts.ScriptTarget.ESNext, true);
  const out: string[] = [];
  for (const ref of runtimeRefs(sf)) {
    if (ref.kind !== "declaration") continue;
    if (!ref.spec.startsWith("./") && !ref.spec.startsWith("../")) continue;
    if (!out.includes(ref.spec)) out.push(ref.spec);
  }
  return out;
}

/** Rewrite a lowered `.ts` module's module specifiers per `map` (original →
 * replacement), in both directions — an `import … from` and a barrel's
 * `export … from` alike. Specifiers absent from `map` are left unchanged. */
export function rewriteImportSpecifiers(loweredTs: string, map: Record<string, string>): string {
  const sf = ts.createSourceFile("__m.ts", loweredTs, ts.ScriptTarget.ESNext, true);
  const next = (sf: ts.SourceFile): ts.SourceFile =>
    ts.factory.updateSourceFile(
      sf,
      sf.statements.map((stmt) => {
        const s = ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt) ? stmt : undefined;
        if (s === undefined || s.moduleSpecifier === undefined) return stmt;
        if (!ts.isStringLiteral(s.moduleSpecifier)) return stmt;
        const replacement = map[s.moduleSpecifier.text];
        if (replacement === undefined) return stmt;
        const lit = ts.factory.createStringLiteral(replacement);
        return ts.isImportDeclaration(s)
          ? ts.factory.updateImportDeclaration(s, s.modifiers, s.importClause, lit, s.attributes)
          : ts.factory.updateExportDeclaration(
              s,
              s.modifiers,
              s.isTypeOnly,
              s.exportClause,
              lit,
              s.attributes,
            );
      }),
    );
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  return printer.printFile(next(sf));
}
