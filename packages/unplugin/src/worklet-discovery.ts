import path from "node:path";

import ts from "typescript";

function projectFiles(config: string, seen = new Set<string>()): string[] {
  if (seen.has(config)) return [];
  seen.add(config);
  const raw = ts.readConfigFile(config, (file) => ts.sys.readFile(file));
  if (raw.error) return [];
  let parsed: ts.ParsedCommandLine;
  try {
    parsed = ts.parseJsonConfigFileContent(
      raw.config,
      ts.sys,
      path.dirname(config),
      undefined,
      config,
    );
  } catch {
    // TypeScript can throw for malformed reference entries while a config is being edited.
    return [];
  }
  return [
    ...parsed.fileNames,
    ...(parsed.projectReferences ?? []).flatMap((ref) =>
      projectFiles(ts.resolveProjectReferencePath(ref), seen),
    ),
  ];
}

export function discoverWorkletImports(root: string): Array<{ source: string; importer: string }> {
  const config = path.join(root, "tsconfig.json");
  const files = ts.sys.fileExists(config)
    ? projectFiles(config)
    : ts.sys.readDirectory(
        root,
        [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
        ["**/node_modules/**", "**/.git/**", "**/.unworklet/**", "**/dist/**"],
      );
  const imports: Array<{ source: string; importer: string }> = [];
  for (const file of [...new Set(files)].sort()) {
    if (/\.d\.[cm]?ts$/.test(file)) continue;
    const text = ts.sys.readFile(file);
    if (!text?.includes("worklet")) continue;
    const visit = (node: ts.Node): void => {
      let specifier: ts.Node | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        specifier = node.moduleSpecifier;
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        specifier = node.arguments[0];
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        specifier = node.argument.literal;
      }
      if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.includes("worklet")) {
        imports.push({ source: specifier.text, importer: file });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), visit);
  }
  return imports;
}
