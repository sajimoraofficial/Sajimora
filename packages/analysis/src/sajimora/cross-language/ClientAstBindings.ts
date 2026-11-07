import * as ts from 'typescript';
import { WireType, mkObjectWireType } from './CanonicalContractIR';
import { TypeScriptContractParser } from './TypeScriptContractParser';

/** Resolve the nearest lexical declaration, retaining shadowing rather than matching all names. */
export function findBinding(name: string, node: ts.Node): ts.Node | undefined {
  for (let scope: ts.Node | undefined = node; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const parameter = scope.parameters.find(p => ts.isIdentifier(p.name) && p.name.text === name);
      if (parameter) return parameter;
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration;
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
        if (ts.isClassDeclaration(statement) && statement.name?.text === name) return statement;
        if (ts.isEnumDeclaration(statement) && statement.name?.text === name) return statement;
        if (ts.isTypeAliasDeclaration(statement) && statement.name?.text === name) return statement;
        if (ts.isInterfaceDeclaration(statement) && statement.name?.text === name) return statement;
      }
      if (ts.isSourceFile(scope)) for (const statement of scope.statements) {
        if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
        if (statement.importClause.name?.text === name) return statement.importClause;
        const bindings = statement.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) { const specifier = bindings.elements.find(e => e.name.text === name); if (specifier) return specifier; }
        if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) return bindings;
      }
    }
  }
  return undefined;
}
export function importedFrom(binding: ts.Node | undefined, module: string): boolean {
  for (let node = binding; node; node = node.parent) if (ts.isImportDeclaration(node)) return ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === module;
  return false;
}
export function inferPayload(expr: ts.Expression, parser: TypeScriptContractParser, file: string, seen = new Set<ts.Node>()): WireType {
  if (seen.has(expr)) return { kind: 'UNKNOWN', reason: 'Recursive payload expression' };
  seen = new Set([...seen, expr]);
  if (ts.isParenthesizedExpression(expr)) return inferPayload(expr.expression, parser, file, seen);
  if (ts.isAsExpression(expr)) return parser.parseProducerTypeByName(expr.type.getText(), file).wireType;
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.expression.getText() === 'JSON' && expr.expression.name.text === 'stringify' && expr.arguments.length === 1) return inferPayload(expr.arguments[0], parser, file, seen);
  if (ts.isIdentifier(expr)) {
    const binding = findBinding(expr.text, expr);
    if (binding && (ts.isVariableDeclaration(binding) || ts.isParameter(binding)) && binding.type) return parser.parseProducerTypeByName(binding.type.getText(), file).wireType;
    return { kind: 'UNKNOWN', reason: `Payload binding ${expr.text} lacks a qualified type` };
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return { kind: 'LITERAL', value: expr.text };
  if (ts.isNumericLiteral(expr)) return { kind: 'LITERAL', value: Number(expr.text) };
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'LITERAL', value: expr.kind === ts.SyntaxKind.TrueKeyword };
  if (ts.isObjectLiteralExpression(expr)) {
    const properties = [];
    for (const property of expr.properties) {
      if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) properties.push({ wireName: property.name.text, type: inferPayload(property.initializer, parser, file, seen), optional: false, nullable: property.initializer.kind === ts.SyntaxKind.NullKeyword, validationConstraints: [] });
      else if (ts.isShorthandPropertyAssignment(property)) properties.push({ wireName: property.name.text, type: inferPayload(property.name, parser, file, seen), optional: false, nullable: false, validationConstraints: [] });
      else return { kind: 'UNKNOWN', reason: 'Computed/spread payload properties are unresolved' };
    }
    return mkObjectWireType(properties);
  }
  if (ts.isArrayLiteralExpression(expr)) return { kind: 'ARRAY', elementType: { kind: 'UNION', types: expr.elements.map(element => inferPayload(element as ts.Expression, parser, file, seen)) } };
  return { kind: 'UNKNOWN', reason: 'HTTP payload expression is not resolved' };
}
