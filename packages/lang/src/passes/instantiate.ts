import ts from "typescript";

import { isDspExpr } from "../classify.ts";
import { unwrapValue } from "../container-values.ts";
import type { BuiltProgram } from "../program.ts";

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
  const expression = unwrapValue(call.expression);
  if (ts.isPropertyAccessExpression(expression)) {
    const receiverSymbol = checker.getSymbolAtLocation(unwrapValue(expression.expression));
    if (!receiverSymbol?.declarations?.some(ts.isNamespaceImport)) return false;
    const module = checker.getAliasedSymbol(receiverSymbol);
    const exported = checker
      .getExportsOfModule(module)
      .find((symbol) => symbol.name === expression.name.text);
    if (exported === undefined) return false;
    return (
      (exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported) ===
      canonical
    );
  }
  if (!ts.isIdentifier(expression)) return false;
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

function subgraphArguments(
  checker: ts.TypeChecker,
  type: ts.Type,
  brandName: ts.__String,
  location: ts.Node,
): ts.Type | undefined {
  if (type.isUnion() || (type.flags & ts.TypeFlags.TypeParameter) !== 0) return undefined;
  const brand = type.getProperties().find((property) => property.escapedName === brandName);
  if (brand === undefined) return undefined;
  const witness = checker.getTypeOfSymbolAtLocation(brand, location);
  if (witness.isUnion()) return undefined;
  const args = witness.getProperty("args");
  return args === undefined ? undefined : checker.getTypeOfSymbolAtLocation(args, location);
}

/** Constructor choices use the original declaration, never LiftArgs' widened context. */
export function instantiateArgumentConstructors(
  original: BuiltProgram,
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
  const precise = original.withStrictNullChecks();
  const { checker } = precise;
  const exports = coreExports(precise);
  const subgraphSymbol = exports.get("SubgraphDecl")!;
  const brands = checker
    .getDeclaredTypeOfSymbol(subgraphSymbol)
    .getProperties()
    .filter((property) =>
      property.declarations?.some(
        (declaration) =>
          ts.isPropertySignature(declaration) && ts.isComputedPropertyName(declaration.name),
      ),
    );
  if (brands.length !== 1) return result;
  const brandName = brands[0]!.escapedName;
  const nodeSymbol = exports.get("Node")!;
  const visit = (node: ts.Node): void => {
    const originalCall = candidates.get(`${node.pos}:${node.end}`);
    if (ts.isCallExpression(node) && originalCall !== undefined && node.arguments.length > 0) {
      const location = node.arguments[0]!;
      const args = subgraphArguments(
        checker,
        checker.getTypeAtLocation(location),
        brandName,
        location,
      );
      if (args !== undefined) {
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
