import ts from "typescript";
import { buildProgram } from "../../../../packages/lang/src/program.ts";
import type { FsSnapshot } from "../../../../packages/lang/src/program.ts";
import { apiEntries } from "./api.ts";
import type { HelpSignature, HelpSignatures } from "./types.ts";

function sourceLink(declaration: ts.Node): string {
  const source = declaration.getSourceFile();
  const relative = source.fileName.match(/packages\/(core|lang)\/src\/.+$/)?.[0];
  if (!relative || source.fileName.endsWith("__uwk_ambient__.d.ts")) {
    return "https://github.com/yuichkun/unworklet/blob/main/packages/lang/src/ambient.ts";
  }
  const line = source.getLineAndCharacterOfPosition(declaration.getStart()).line + 1;
  return `https://github.com/yuichkun/unworklet/blob/main/${relative}#L${line}`;
}

export function createHelpSignatures(snapshot: FsSnapshot): HelpSignatures {
  const source = apiEntries
    .map((entry, index) => `const help_${index} = ${entry.probe ?? entry.name};`)
    .join("\n");
  const { checker, sourceFile, program } = buildProgram(source, { snapshot });
  const errors = program.getSemanticDiagnostics(sourceFile);
  if (errors.length > 0) {
    throw new Error(
      `Invalid help API probe: ${errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, " ")).join("; ")}`,
    );
  }
  const result: HelpSignatures = {};
  const flags = ts.TypeFormatFlags.NoTruncation;
  sourceFile.statements.forEach((statement, index) => {
    const declaration = (statement as ts.VariableStatement).declarationList.declarations[0]!;
    const expression = declaration.initializer!;
    const type = checker.getTypeAtLocation(expression);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
      throw new Error(`Unresolved help API: ${apiEntries[index]!.name}`);
    const entry = apiEntries[index]!;
    const signatures: HelpSignature[] = type
      .getCallSignatures()
      .filter(
        (signature) =>
          !/Node<"f32x4">/.test(checker.signatureToString(signature, expression, flags)),
      )
      .map((signature) => {
        let label = `${entry.name}${checker.signatureToString(signature, expression, flags)}`;
        for (const parameter of signature.parameters) {
          const parameterType = checker.getTypeOfSymbolAtLocation(parameter, expression);
          if (
            parameterType.aliasSymbol &&
            parameterType.getProperties().length > 0 &&
            !parameterType.isUnion()
          ) {
            label += `\n${parameterType.aliasSymbol.name} = ${checker.typeToString(parameterType, expression, flags | ts.TypeFormatFlags.InTypeAlias)}`;
          }
        }
        return { label, source: sourceLink(signature.declaration!) };
      });
    if (signatures.length === 0) {
      const symbol = checker.getSymbolAtLocation(
        ts.isPropertyAccessExpression(expression) ? expression.name : expression,
      );
      signatures.push({
        label: `${entry.name}: ${checker.typeToString(type, expression, flags)}`,
        source: sourceLink(symbol!.declarations![0]!),
      });
    }
    result[entry.id] = signatures;
  });
  return result;
}
