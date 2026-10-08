import path from "node:path";
import { readFileSync } from "node:fs";

import MagicString from "magic-string";
import ts from "typescript";

const flag = "__UNWORKLET_SELFCHECK__";

export function defineDevSelfcheck(code: string, id: string) {
  const file = id.split("?")[0]!;
  const directory = path.dirname(file);
  const filename = path.basename(file);
  if (
    !(path.basename(directory) === "src" && filename === "worklet.ts") &&
    !(path.basename(directory) === "dist" && /^worklet-[^/]+\.mjs$/.test(filename))
  )
    return undefined;
  try {
    const manifest = JSON.parse(readFileSync(path.join(directory, "../package.json"), "utf8")) as {
      name?: string;
    };
    if (manifest.name !== "@unworklet/core") return undefined;
  } catch {
    return undefined;
  }
  if (!code.includes(flag)) return undefined;

  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const options = { noLib: true, noResolve: true, allowJs: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === file ? source : undefined);
  const checker = ts.createProgram([file], options, host).getTypeChecker();
  const edits = new MagicString(code);
  let changed = false;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && node.text === flag) {
      const parent = node.parent;
      if (
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) &&
          parent.name === node)
      )
        return;
      const symbol = checker.getSymbolAtLocation(node);
      const declarations = symbol?.declarations;
      const ambient = declarations?.every(
        (declaration) =>
          ts.isVariableDeclaration(declaration) &&
          ts.isVariableDeclarationList(declaration.parent) &&
          ts.isVariableStatement(declaration.parent.parent) &&
          declaration.parent.parent.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
          ),
      );
      if (
        (!symbol || ambient) &&
        !declarations?.some(
          (declaration) => ts.isVariableDeclaration(declaration) && declaration.name === node,
        )
      ) {
        edits.overwrite(node.getStart(source), node.end, "true");
        changed = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!changed) return undefined;
  return {
    code: edits.toString(),
    map: edits.generateMap({ source: file, includeContent: true, hires: true }),
  };
}
