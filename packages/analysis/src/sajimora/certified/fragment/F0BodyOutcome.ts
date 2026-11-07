/**
 * Finite operational outcome extractor for F0.2.  This is deliberately
 * separate from scalar type compatibility: `never` assignability alone is
 * never evidence that a formerly value-producing call still returns.
 */
import ts from 'typescript';

export type F0BodyOutcome =
  | { kind: 'VALUE' }
  | { kind: 'TERMINAL_THROW' }
  | { kind: 'UNKNOWN'; reason: string };

/**
 * Extracts only a whole-body, straight-line witness.  Control flow, multiple
 * statements, implicit returns, and nested functions remain outside F0.2.
 */
export function extractF0BodyOutcome(node: ts.FunctionDeclaration): F0BodyOutcome {
  if (!node.body) return { kind: 'UNKNOWN', reason: 'Function body is absent' };
  if (node.body.statements.length !== 1) return { kind: 'UNKNOWN', reason: 'F0.2 requires exactly one top-level body statement' };
  const statement = node.body.statements[0];
  if (ts.isReturnStatement(statement) && statement.expression) return { kind: 'VALUE' };
  if (ts.isThrowStatement(statement) && statement.expression && ts.isNewExpression(statement.expression) &&
      ts.isIdentifier(statement.expression.expression) && statement.expression.expression.text === 'Error' &&
      (statement.expression.arguments?.length ?? 0) <= 1 &&
      (!statement.expression.arguments?.[0] || ts.isStringLiteral(statement.expression.arguments[0]))) {
    return { kind: 'TERMINAL_THROW' };
  }
  return { kind: 'UNKNOWN', reason: `Unsupported F0.2 body statement: ${ts.SyntaxKind[statement.kind]}` };
}
