/** Closed F0.3 witness for same-module export callability replacement. */
import ts from 'typescript';

export type F0ExportCallability =
  | { status: 'CALLABLE_FUNCTION'; start: number; end: number }
  | { status: 'NONCALLABLE_VALUE'; start: number; end: number }
  | { status: 'ABSENT' | 'AMBIGUOUS' | 'UNSUPPORTED'; reason: string };

/**
 * Does not follow barrels or aliases.  The caller must already have a sealed,
 * exact module path; this prevents an export-name match becoming identity proof.
 */
export function classifyF0DirectExportCallability(fileId: string, bytes: Buffer, exportName: string): F0ExportCallability {
  const sf = ts.createSourceFile(fileId, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
  if ((sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return { status: 'UNSUPPORTED', reason: 'Parse diagnostics' };
  const found: Array<{ callable: boolean; node: ts.Node }> = [];
  for (const statement of sf.statements) {
    const exported = ts.canHaveModifiers(statement) && (ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === exportName) found.push({ callable: true, node: statement });
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === exportName) found.push({ callable: false, node: declaration });
    }
  }
  if (!found.length) return { status: 'ABSENT', reason: 'No direct exported declaration with the requested name' };
  if (found.length !== 1) return { status: 'AMBIGUOUS', reason: 'Multiple direct exported declarations with the requested name' };
  const item = found[0]; const start = item.node.getStart(sf); const end = item.node.getEnd();
  return item.callable ? { status: 'CALLABLE_FUNCTION', start, end } : { status: 'NONCALLABLE_VALUE', start, end };
}
