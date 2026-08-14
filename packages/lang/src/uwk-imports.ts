/**
 * AST helpers over a lowered `.ts` module's import declarations, for the build
 * path's transitive `.uwk.ts` lowering: a processor `.uwk.ts` that imports a
 * subgraph from a sibling `.uwk.ts` must have that sibling lowered too, and its
 * import specifier rewritten to the lowered sibling. Operating on AST nodes (not
 * the source text) means an `import` inside a comment / string literal is ignored.
 */
import ts from "typescript";

/** The module specifiers of a lowered `.ts` module that point at a `.uwk.ts`
 * (the transitive sugar imports the build must lower too). */
export function uwkImportSpecifiers(loweredTs: string): string[] {
  const sf = ts.createSourceFile("__m.ts", loweredTs, ts.ScriptTarget.ESNext, true);
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      if (stmt.moduleSpecifier.text.endsWith(".uwk.ts")) out.push(stmt.moduleSpecifier.text);
    }
  }
  return out;
}

/**
 * The module specifiers of a lowered `.ts` module that point at a plain relative
 * `.ts` file — a helper the author imported (`import { GAIN } from
 * "./constants.ts"`), as opposed to a sibling `.uwk.ts`, which is lowered
 * separately. These survive lowering untouched, so the temp still imports raw
 * TypeScript and only a Node that strips types can load it.
 */
export function plainTsImportSpecifiers(loweredTs: string): string[] {
  const sf = ts.createSourceFile("__m.ts", loweredTs, ts.ScriptTarget.ESNext, true);
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    // A type-only import is erased by the transpile, so it never reaches Node.
    if (stmt.importClause?.isTypeOnly === true) continue;
    const spec = stmt.moduleSpecifier.text;
    const relative = spec.startsWith("./") || spec.startsWith("../");
    if (relative && spec.endsWith(".ts") && !spec.endsWith(".uwk.ts")) out.push(spec);
  }
  return out;
}

/** Rewrite a lowered `.ts` module's import specifiers per `map` (original →
 * replacement). Specifiers absent from `map` are left unchanged. */
export function rewriteImportSpecifiers(loweredTs: string, map: Record<string, string>): string {
  const sf = ts.createSourceFile("__m.ts", loweredTs, ts.ScriptTarget.ESNext, true);
  const next = (sf: ts.SourceFile): ts.SourceFile =>
    ts.factory.updateSourceFile(
      sf,
      sf.statements.map((stmt) => {
        if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
          const replacement = map[stmt.moduleSpecifier.text];
          if (replacement !== undefined) {
            return ts.factory.updateImportDeclaration(
              stmt,
              stmt.modifiers,
              stmt.importClause,
              ts.factory.createStringLiteral(replacement),
              stmt.attributes,
            );
          }
        }
        return stmt;
      }),
    );
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  return printer.printFile(next(sf));
}
