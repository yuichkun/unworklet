import ts from "typescript";

/** Every name a binding pattern introduces (`a`, `{ b }`, `[c, ...d]`). */
export function collectBindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(element.name, into);
  }
}

/** Bindings in every authored scope that can capture a generated helper reference. */
export function authoredBindingNames(sourceFile: ts.SourceFile): Set<string> {
  const bound = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      collectBindingNames(node.name, bound);
    } else if (
      (ts.isDeclarationStatement(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassExpression(node) ||
        ts.isImportClause(node) ||
        ts.isImportSpecifier(node) ||
        ts.isNamespaceImport(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      bound.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  return bound;
}
