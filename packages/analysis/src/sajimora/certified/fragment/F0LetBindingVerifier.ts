import ts from 'typescript';

export interface F0LetBindingVerification {
  valid: boolean;
  reason?: string;
}

/**
 * F0 admits only initialized identifier `let` bindings that are never written
 * after initialization. The whole source file is scanned for writes so that a
 * use outside the declaration's immediate block cannot evade the check.
 * `declarationRange` narrows which declarations are in scope for experimental
 * target-scoped admission; the write scan itself remains whole-file.
 */
export function verifyF0LetBindings(
  sourceFile: ts.SourceFile,
  declarationRange?: readonly [number, number]
): F0LetBindingVerification {
  const declarations: ts.VariableDeclaration[] = [];
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.Let) !== 0 &&
      (!declarationRange || (node.getStart(sourceFile) >= declarationRange[0] && node.getEnd() <= declarationRange[1]))
    ) declarations.push(...node.declarations);
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const letNames: string[] = [];
  for (const declaration of declarations) {
    if (!ts.isIdentifier(declaration.name)) {
      return { valid: false, reason: 'F0 let declarations must use a simple identifier' };
    }
    if (!declaration.initializer) {
      return { valid: false, reason: `F0 let binding '${declaration.name.text}' must be initialized at declaration` };
    }
    letNames.push(declaration.name.text);
  }

  if (letNames.length === 0) return { valid: true };

  let hasDirectEval = false;
  const scanWrites = (node: ts.Node): F0LetBindingVerification | undefined => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'eval'
    ) hasDirectEval = true;

    if (ts.isIdentifier(node) && letNames.includes(node.text) && !isDeclarationName(node)) {
      if (isWriteReference(node)) {
        return { valid: false, reason: `F0 let binding '${node.text}' is reassigned or updated after initialization` };
      }
    }

    let failure: F0LetBindingVerification | undefined;
    ts.forEachChild(node, child => { failure ??= scanWrites(child); });
    return failure;
  };
  const writeFailure = scanWrites(sourceFile);
  if (writeFailure) return writeFailure;
  if (hasDirectEval) return { valid: false, reason: 'Direct eval is unsupported when F0 let bindings are present' };
  return { valid: true };
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return ts.isVariableDeclaration(parent) && parent.name === node;
}

function isWriteReference(node: ts.Identifier): boolean {
  let target: ts.Node = node;
  while (ts.isParenthesizedExpression(target.parent)) target = target.parent;

  const parent = target.parent;
  if (ts.isBinaryExpression(parent) && parent.left === target && isAssignmentOperator(parent.operatorToken.kind)) return true;
  if (ts.isPrefixUnaryExpression(parent) && parent.operand === target && isIncrementOperator(parent.operator)) return true;
  if (ts.isPostfixUnaryExpression(parent) && parent.operand === target) return true;
  if ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === target) return true;
  return false;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isIncrementOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.PlusPlusToken || kind === ts.SyntaxKind.MinusMinusToken;
}
