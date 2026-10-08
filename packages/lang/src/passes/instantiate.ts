import ts from "typescript";

import { isDspExpr } from "../classify.ts";
import { buildProgram, type BuiltProgram, type BuildProgramOptions } from "../program.ts";

type ScalarConstructor = "f32" | "f64" | "i32" | "bool";

function coreExports({ program, checker }: BuiltProgram): Map<string, ts.Symbol> {
  const ambient = program.getSourceFile(program.getRootFileNames()[0]!)!;
  const coreImport = ambient.statements.find(ts.isImportDeclaration)!;
  const module = checker.getSymbolAtLocation(coreImport.moduleSpecifier);
  return new Map(
    module === undefined
      ? []
      : checker
          .getExportsOfModule(module)
          .map((symbol) => [
            symbol.name,
            symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol,
          ]),
  );
}

function isInstantiate(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  canonical: ts.Symbol,
  ambient: ts.SourceFile,
): boolean {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration === undefined || !canonical.declarations!.includes(declaration)) return false;
  let expression: ts.Expression = call.expression;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (ts.isPropertyAccessExpression(expression)) {
    const receiver = checker.getSymbolAtLocation(expression.expression);
    if (!receiver?.declarations?.some(ts.isNamespaceImport)) return false;
  }
  const binding = checker.getSymbolAtLocation(expression);
  if (binding === undefined) return false;
  const symbol = binding.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(binding) : binding;
  return (
    symbol === canonical ||
    (symbol.name === "instantiate" &&
      symbol.declarations!.every((decl) => decl.getSourceFile() === ambient))
  );
}

function scalarTarget(
  checker: ts.TypeChecker,
  type: ts.Type,
  nodeSymbol: ts.Symbol,
): ScalarConstructor | undefined {
  const members = type.isUnion() ? type.types : [type];
  let scalar: ScalarConstructor | undefined;
  for (const member of members) {
    if (member.flags & ts.TypeFlags.Undefined) continue;
    if (member.symbol !== nodeSymbol) return undefined;
    const target = checker.getTypeArguments(member as ts.TypeReference)[0];
    if (target === undefined || !target.isStringLiteral()) return undefined;
    const value = target.value;
    if (value !== "f32" && value !== "f64" && value !== "i32" && value !== "bool") return undefined;
    if (scalar !== undefined && scalar !== value) return undefined;
    scalar = value;
  }
  return scalar;
}

/** Constructor choices use the original declaration, never LiftArgs' widened context. */
export function instantiateArgumentConstructors(
  source: string,
  original: BuiltProgram,
  options: BuildProgramOptions = {},
): Map<ts.Expression, ScalarConstructor> {
  const result = new Map<ts.Expression, ScalarConstructor>();
  const canonical = coreExports(original).get("instantiate");
  if (canonical === undefined) return result;
  const ambient = original.program.getSourceFile(original.program.getRootFileNames()[0]!)!;
  const candidates = new Map<string, ts.CallExpression>();
  const find = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isInstantiate(original.checker, node, canonical, ambient)) {
      candidates.set(`${node.pos}:${node.end}`, node);
    }
    ts.forEachChild(node, find);
  };
  find(original.sourceFile);
  if (candidates.size === 0) return result;

  // The general sugar checker erases nullability. A separate query keeps
  // undefined arguments unchanged without altering the other sugar passes.
  const precise = buildProgram(source, { ...options, strictNullChecks: true });
  const { checker } = precise;
  const exports = coreExports(precise);
  const subgraphSymbol = exports.get("SubgraphDecl")!;
  const nodeSymbol = exports.get("Node")!;
  const visit = (node: ts.Node): void => {
    const originalCall = candidates.get(`${node.pos}:${node.end}`);
    if (ts.isCallExpression(node) && originalCall !== undefined && node.arguments.length > 0) {
      const subgraph = checker.getTypeAtLocation(node.arguments[0]!);
      if (subgraph.symbol === subgraphSymbol) {
        const args = checker.getTypeArguments(subgraph as ts.TypeReference)[0]!;
        if (!checker.isTupleType(args) && !checker.isArrayType(args)) {
          ts.forEachChild(node, visit);
          return;
        }
        const types = checker.isTupleType(args)
          ? checker.getTypeArguments(args as ts.TypeReference)
          : [];
        const flags = checker.isTupleType(args)
          ? (args as ts.TupleTypeReference).target.elementFlags
          : [];
        const restIndex = flags.findIndex((flag) => (flag & ts.ElementFlags.Rest) !== 0);
        const rest = checker.isTupleType(args)
          ? restIndex < 0
            ? undefined
            : types[restIndex]
          : checker.getIndexTypeOfType(args, ts.IndexKind.Number);
        if (
          flags.some((flag) => (flag & ts.ElementFlags.Variadic) !== 0) ||
          (restIndex >= 0 && restIndex !== flags.length - 1)
        ) {
          ts.forEachChild(node, visit);
          return;
        }
        for (let i = 1; i < node.arguments.length; i++) {
          const arg = node.arguments[i]!;
          // Spreads make subsequent positional matching indeterminate.
          if (ts.isSpreadElement(arg)) break;
          const slot = i - 1;
          const target =
            slot < types.length && (restIndex < 0 || slot < restIndex) ? types[slot] : rest;
          if (target === undefined || isDspExpr(original.checker, originalCall.arguments[i]!))
            continue;
          const scalar = scalarTarget(checker, target, nodeSymbol);
          if (scalar === undefined) continue;
          const actual = checker.getTypeAtLocation(arg);
          const primitiveFlag =
            scalar === "bool" ? ts.TypeFlags.BooleanLike : ts.TypeFlags.NumberLike;
          const members = actual.isUnion() ? actual.types : [actual];
          if (members.every((member) => (member.flags & primitiveFlag) !== 0))
            result.set(originalCall.arguments[i]!, scalar);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(precise.sourceFile);
  return result;
}
