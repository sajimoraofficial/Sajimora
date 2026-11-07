import * as ts from 'typescript';
import { findBinding, importedFrom } from './ClientAstBindings';
import { UrlConstantResolver } from './UrlConstantResolver';

export interface AxiosBinding { readonly instance?: ts.CallExpression }

/** Resolve only lexical bindings and explicit exports in the sealed source map.
 * No filesystem lookup or matching an arbitrary variable named api/client.
 */
export function resolveAxiosBinding(expr: ts.Expression, resolver: UrlConstantResolver, seen = new Set<ts.Node>()): AxiosBinding | undefined {
  if (seen.size >= 64 || seen.has(expr)) return undefined;
  seen = new Set([...seen, expr]);
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) return resolveAxiosBinding(expr.expression, resolver, seen);
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'create') {
    const root = resolveAxiosBinding(expr.expression.expression, resolver, seen);
    return root && !root.instance ? { instance: expr } : undefined;
  }
  if (!ts.isIdentifier(expr)) return undefined;
  const binding = findBinding(expr.text, expr);
  if (!binding || seen.has(binding)) return undefined;
  seen = new Set([...seen, binding]);
  if (importedFrom(binding, 'axios')) {
    return ts.isImportClause(binding) || ts.isNamespaceImport(binding) || (ts.isImportSpecifier(binding) && binding.propertyName?.text === 'default') ? {} : undefined;
  }
  if (ts.isVariableDeclaration(binding)) {
    return binding.initializer && (binding.parent.flags & ts.NodeFlags.Const) ? resolveAxiosBinding(binding.initializer, resolver, seen) : undefined;
  }
  let declaration: ts.ImportDeclaration | undefined;
  for (let node: ts.Node | undefined = binding; node; node = node.parent) if (ts.isImportDeclaration(node)) { declaration = node; break; }
  if (!declaration || !ts.isStringLiteral(declaration.moduleSpecifier) || declaration.importClause?.isTypeOnly) return undefined;
  const target = resolver.resolveModule(declaration.moduleSpecifier.text, expr.getSourceFile().fileName);
  const name = ts.isImportClause(binding) ? 'default' : ts.isImportSpecifier(binding) && !binding.isTypeOnly ? binding.propertyName?.text ?? binding.name.text : undefined;
  return target && name ? resolveExport(name, target, resolver, seen) : undefined;
}

function resolveExport(name: string, file: string, resolver: UrlConstantResolver, seen: Set<ts.Node>): AxiosBinding | undefined {
  const sf = resolver.getSourceFile(file);
  if (!sf || seen.size >= 64 || seen.has(sf)) return undefined;
  seen = new Set([...seen, sf]);
  for (const statement of sf.statements) {
    if (name === 'default' && ts.isExportAssignment(statement) && !statement.isExportEquals) return resolveAxiosBinding(statement.expression, resolver, seen);
    if (ts.isVariableStatement(statement) && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      const declaration = statement.declarationList.declarations.find(d => ts.isIdentifier(d.name) && d.name.text === name);
      if (declaration?.initializer && (statement.declarationList.flags & ts.NodeFlags.Const)) return resolveAxiosBinding(declaration.initializer, resolver, seen);
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? resolver.resolveModule(statement.moduleSpecifier.text, file) : undefined;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const specifier = statement.exportClause.elements.find(e => !e.isTypeOnly && e.name.text === name);
        if (specifier) return target ? resolveExport(specifier.propertyName?.text ?? specifier.name.text, target, resolver, seen) : resolveAxiosBinding(specifier.propertyName ?? specifier.name, resolver, seen);
      } else if (target && name !== 'default') {
        const result = resolveExport(name, target, resolver, seen);
        if (result) return result;
      }
    }
  }
  return undefined;
}
