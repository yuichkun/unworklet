import ts from "typescript";

const stableContainers = new WeakMap<ts.VariableDeclaration, boolean>();

function wrappedValue(node: ts.Node): ts.Expression | undefined {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isExpressionWithTypeArguments(node)
  )
    return node.expression;
  return undefined;
}

export function unwrapValue(node: ts.Node): ts.Node {
  let value = wrappedValue(node);
  while (value !== undefined) {
    node = value;
    value = wrappedValue(node);
  }
  return node;
}

export function isConstDeclaration(node: ts.Node): node is ts.VariableDeclaration {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

export function literalKey(node: ts.Node): string | undefined {
  node = unwrapValue(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return String(Number(node.text));
  if (ts.isBigIntLiteral(node)) return String(BigInt(node.text.slice(0, -1)));
  if (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  )
    return ts.tokenToString(node.kind);
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.PlusToken || node.operator === ts.SyntaxKind.MinusToken)
  ) {
    const operand = unwrapValue(node.operand);
    if (ts.isNumericLiteral(operand)) {
      const value = Number(operand.text);
      return String(node.operator === ts.SyntaxKind.MinusToken ? -value : value);
    }
    if (node.operator === ts.SyntaxKind.MinusToken && ts.isBigIntLiteral(operand)) {
      return String(-BigInt(operand.text.slice(0, -1)));
    }
  }
  return undefined;
}

function propertyKey(name: ts.PropertyName): string | undefined {
  if (ts.isComputedPropertyName(name)) return literalKey(name.expression);
  return ts.isNumericLiteral(name) || ts.isBigIntLiteral(name) ? literalKey(name) : name.text;
}

function literalMember(value: ts.Node, key: string): ts.Expression | undefined {
  value = unwrapValue(value);
  if (ts.isArrayLiteralExpression(value)) {
    for (let i = 0; i < value.elements.length; i++) {
      const element = value.elements[i]!;
      if (ts.isSpreadElement(element)) return undefined;
      if (String(i) === key) return ts.isOmittedExpression(element) ? undefined : element;
    }
  }
  if (ts.isObjectLiteralExpression(value) && key !== "__proto__") {
    for (let i = value.properties.length - 1; i >= 0; i--) {
      const property = value.properties[i]!;
      if (ts.isSpreadAssignment(property)) return undefined;
      const name = propertyKey(property.name);
      if (name === undefined) return undefined;
      if (name !== key) continue;
      if (ts.isPropertyAssignment(property)) return property.initializer;
      if (ts.isShorthandPropertyAssignment(property)) return property.name;
      return undefined;
    }
  }
  return undefined;
}

function isContainer(node: ts.Node): boolean {
  node = unwrapValue(node);
  return ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node);
}

function isWrite(node: ts.Node): boolean {
  const parent = node.parent;
  if (
    wrappedValue(parent) === node ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isObjectLiteralExpression(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isSpreadAssignment(parent) ||
    ts.isPropertyAssignment(parent) ||
    (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
    (ts.isElementAccessExpression(parent) && parent.expression === node)
  ) {
    return isWrite(parent);
  }
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === node &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
    ts.isDeleteExpression(parent) ||
    ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node)
  );
}

function isReadOnlyReference(node: ts.Identifier, initializer: ts.Expression): boolean {
  let reference: ts.Node = node;
  let value: ts.Node = unwrapValue(initializer);
  while (isContainer(value)) {
    let parent = reference.parent;
    while (wrappedValue(parent) === reference) {
      reference = parent;
      parent = reference.parent;
    }
    const key =
      ts.isPropertyAccessExpression(parent) && parent.expression === reference
        ? parent.name.text
        : ts.isElementAccessExpression(parent) && parent.expression === reference
          ? literalKey(parent.argumentExpression)
          : undefined;
    if (key === undefined) return false;
    reference = parent;
    if (ts.isArrayLiteralExpression(value) && key === "length") break;
    const selected = literalMember(value, key);
    if (selected === undefined) return false;
    value = unwrapValue(selected);
  }
  // Parentheses preserve the receiver of an own method call.
  while (wrappedValue(reference.parent) === reference) reference = reference.parent;
  const parent = reference.parent;
  return (
    !isWrite(reference) &&
    !(ts.isCallExpression(parent) && parent.expression === reference) &&
    !(ts.isTaggedTemplateExpression(parent) && parent.tag === reference)
  );
}

function isStableContainer(checker: ts.TypeChecker, declaration: ts.VariableDeclaration): boolean {
  const cached = stableContainers.get(declaration);
  if (cached !== undefined) return cached;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  const invalidReference = (node: ts.Node): boolean => {
    // Class heritage and instantiation expressions also satisfy isTypeNode.
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return false;
    if (ts.isExportDeclaration(node) && node.isTypeOnly) return false;
    if (ts.isExportSpecifier(node)) {
      return !node.isTypeOnly && checker.getExportSpecifierLocalTargetSymbol(node) === symbol;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapValue(node.expression);
      if (ts.isIdentifier(callee) && callee.text === "eval") return true;
    }
    if (ts.isIdentifier(node) && node !== declaration.name) {
      const referenceSymbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      if (referenceSymbol === symbol) {
        return !isReadOnlyReference(node, declaration.initializer!);
      }
    }
    return ts.forEachChild(node, invalidReference) ?? false;
  };
  const stable =
    (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) === 0 &&
    !invalidReference(declaration.getSourceFile());
  stableContainers.set(declaration, stable);
  return stable;
}

/** Only literal paths whose container cannot be replaced or escape are origins. */
export function containerValueOrigin(
  checker: ts.TypeChecker,
  node: ts.Node,
): ts.Expression | undefined {
  const path: string[] = [];
  node = unwrapValue(node);
  while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const key = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : literalKey(node.argumentExpression);
    if (key === undefined) return undefined;
    path.unshift(key);
    node = unwrapValue(node.expression);
  }
  if (ts.isIdentifier(node)) {
    let declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (declaration !== undefined && ts.isBindingElement(declaration) && path.length !== 0) {
      return undefined;
    }
    while (declaration !== undefined && ts.isBindingElement(declaration)) {
      if (declaration.dotDotDotToken !== undefined || declaration.initializer !== undefined) {
        return undefined;
      }
      const pattern = declaration.parent;
      const key = ts.isArrayBindingPattern(pattern)
        ? String(pattern.elements.indexOf(declaration))
        : propertyKey(declaration.propertyName ?? (declaration.name as ts.Identifier));
      if (key === undefined) return undefined;
      path.unshift(key);
      declaration = pattern.parent;
    }
    if (
      declaration === undefined ||
      !isConstDeclaration(declaration) ||
      declaration.initializer === undefined ||
      !isContainer(declaration.initializer)
    ) {
      return undefined;
    }
    if (ts.isIdentifier(declaration.name) && !isStableContainer(checker, declaration)) {
      return undefined;
    }
    node = declaration.initializer;
  }
  if (path.length === 0) return undefined;
  for (const key of path) {
    const value = literalMember(node, key);
    if (value === undefined) return undefined;
    node = value;
  }
  return node as ts.Expression;
}
