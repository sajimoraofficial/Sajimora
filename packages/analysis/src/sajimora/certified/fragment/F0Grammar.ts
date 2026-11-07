import ts from 'typescript';

export enum F0ProductionId {
  F0_SOURCE_FILE = 'F0_SOURCE_FILE',
  F0_VARIABLE_STATEMENT = 'F0_VARIABLE_STATEMENT',
  F0_VARIABLE_DECLARATION_LIST = 'F0_VARIABLE_DECLARATION_LIST',
  F0_VARIABLE_DECLARATION = 'F0_VARIABLE_DECLARATION',
  F0_FUNCTION_DECLARATION = 'F0_FUNCTION_DECLARATION',
  F0_PARAMETER = 'F0_PARAMETER',
  F0_BLOCK = 'F0_BLOCK',
  F0_RETURN_STATEMENT = 'F0_RETURN_STATEMENT',
  F0_THROW_STATEMENT = 'F0_THROW_STATEMENT',
  F0_LITERAL_ERROR_CONSTRUCTION = 'F0_LITERAL_ERROR_CONSTRUCTION',
  F0_EXPRESSION_STATEMENT = 'F0_EXPRESSION_STATEMENT',
  F0_TYPE_ALIAS_DECLARATION = 'F0_TYPE_ALIAS_DECLARATION',
  F0_INTERFACE_DECLARATION = 'F0_INTERFACE_DECLARATION',
  F0_PROPERTY_SIGNATURE = 'F0_PROPERTY_SIGNATURE',
  F0_IMPORT_DECLARATION = 'F0_IMPORT_DECLARATION',
  F0_IMPORT_CLAUSE = 'F0_IMPORT_CLAUSE',
  F0_NAMESPACE_IMPORT = 'F0_NAMESPACE_IMPORT',
  F0_NAMED_IMPORTS = 'F0_NAMED_IMPORTS',
  F0_IMPORT_SPECIFIER = 'F0_IMPORT_SPECIFIER',
  F0_EXPORT_DECLARATION = 'F0_EXPORT_DECLARATION',
  F0_NAMED_EXPORTS = 'F0_NAMED_EXPORTS',
  F0_EXPORT_SPECIFIER = 'F0_EXPORT_SPECIFIER',
  F0_IDENTIFIER = 'F0_IDENTIFIER',
  F0_STRING_LITERAL = 'F0_STRING_LITERAL',
  F0_NUMERIC_LITERAL = 'F0_NUMERIC_LITERAL',
  F0_TRUE_KEYWORD = 'F0_TRUE_KEYWORD',
  F0_FALSE_KEYWORD = 'F0_FALSE_KEYWORD',
  F0_NULL_KEYWORD = 'F0_NULL_KEYWORD',
  F0_UNDEFINED_KEYWORD = 'F0_UNDEFINED_KEYWORD',
  F0_CALL_EXPRESSION = 'F0_CALL_EXPRESSION',
  F0_PROPERTY_ACCESS_EXPRESSION = 'F0_PROPERTY_ACCESS_EXPRESSION',
  F0_OBJECT_LITERAL_EXPRESSION = 'F0_OBJECT_LITERAL_EXPRESSION',
  F0_PROPERTY_ASSIGNMENT = 'F0_PROPERTY_ASSIGNMENT',
  F0_PARENTHESIZED_EXPRESSION = 'F0_PARENTHESIZED_EXPRESSION',
  F0_NEGATIVE_NUMERIC_LITERAL = 'F0_NEGATIVE_NUMERIC_LITERAL',
  F0_NUMERIC_LITERAL_BINARY_EXPRESSION = 'F0_NUMERIC_LITERAL_BINARY_EXPRESSION',
  F0_KEYWORD_TYPE = 'F0_KEYWORD_TYPE',
  F0_LITERAL_TYPE = 'F0_LITERAL_TYPE',
  F0_UNION_TYPE = 'F0_UNION_TYPE',
  F0_TYPE_REFERENCE = 'F0_TYPE_REFERENCE',
  F0_TYPE_LITERAL = 'F0_TYPE_LITERAL',
  F0_MODIFIER = 'F0_MODIFIER',
  F0_END_OF_FILE = 'F0_END_OF_FILE'
}

export type ClassificationResult =
  | { admitted: true; productionId: F0ProductionId }
  | { admitted: false; reason: string };

export class F0Grammar {
  /**
   * Classifies an individual TypeScript AST node into a closed F0 grammar production.
   * Returns admitted: false if the node syntax violates strict straight-line F0 rules.
   */
  public static classifyNode(node: ts.Node): ClassificationResult {
    // 1. SourceFile
    if (ts.isSourceFile(node)) {
      return { admitted: true, productionId: F0ProductionId.F0_SOURCE_FILE };
    }

    // 2. EndOfFileToken
    if (node.kind === ts.SyntaxKind.EndOfFileToken) {
      return { admitted: true, productionId: F0ProductionId.F0_END_OF_FILE };
    }

    // 3. Modifiers (export, default, readonly)
    if (node.kind === ts.SyntaxKind.ExportKeyword || node.kind === ts.SyntaxKind.DefaultKeyword || node.kind === ts.SyntaxKind.ReadonlyKeyword) {
      return { admitted: true, productionId: F0ProductionId.F0_MODIFIER };
    }

    // 4. VariableStatement
    if (ts.isVariableStatement(node)) {
      if (node.modifiers) {
        for (const mod of node.modifiers) {
          if (mod.kind !== ts.SyntaxKind.ExportKeyword && mod.kind !== ts.SyntaxKind.DefaultKeyword) {
            return { admitted: false, reason: `Unsupported modifier on variable statement: ${ts.SyntaxKind[mod.kind]}` };
          }
        }
      }
      return { admitted: true, productionId: F0ProductionId.F0_VARIABLE_STATEMENT };
    }

    // 5. VariableDeclarationList
    if (ts.isVariableDeclarationList(node)) {
      if ((node.flags & ts.NodeFlags.Const) !== 0 || (node.flags & ts.NodeFlags.Let) !== 0) {
        return { admitted: true, productionId: F0ProductionId.F0_VARIABLE_DECLARATION_LIST };
      }
      return { admitted: false, reason: 'Only const and verified single-assignment let declarations are admitted in F0 (var is unsupported)' };
    }

    // 6. VariableDeclaration
    if (ts.isVariableDeclaration(node)) {
      if (!ts.isIdentifier(node.name)) {
        return { admitted: false, reason: 'Destructuring variable declarations are unsupported in F0' };
      }
      if (!node.initializer && !node.type) {
        return { admitted: false, reason: 'Variable declaration must have an initializer or type annotation' };
      }
      return { admitted: true, productionId: F0ProductionId.F0_VARIABLE_DECLARATION };
    }

    // 7. FunctionDeclaration
    if (ts.isFunctionDeclaration(node)) {
      if (!node.name || !ts.isIdentifier(node.name)) {
        return { admitted: false, reason: 'Anonymous function declarations are unsupported in F0' };
      }
      if (node.asteriskToken) {
        return { admitted: false, reason: 'Generator functions are unsupported in F0' };
      }
      if (node.typeParameters && node.typeParameters.length > 0) {
        return { admitted: false, reason: 'Generic functions are unsupported in F0' };
      }
      if (!node.type) {
        return { admitted: false, reason: 'Named functions must have explicit return type annotations in F0' };
      }
      if (node.modifiers) {
        for (const mod of node.modifiers) {
          if (mod.kind !== ts.SyntaxKind.ExportKeyword && mod.kind !== ts.SyntaxKind.DefaultKeyword) {
            return { admitted: false, reason: `Unsupported function modifier: ${ts.SyntaxKind[mod.kind]}` };
          }
        }
      }
      return { admitted: true, productionId: F0ProductionId.F0_FUNCTION_DECLARATION };
    }

    // 8. Parameter
    if (ts.isParameter(node)) {
      if (!ts.isIdentifier(node.name)) {
        return { admitted: false, reason: 'Destructuring parameters are unsupported in F0' };
      }
      if (node.questionToken) {
        return { admitted: false, reason: 'Optional parameters are unsupported in F0' };
      }
      if (node.dotDotDotToken) {
        return { admitted: false, reason: 'Rest parameters are unsupported in F0' };
      }
      if (node.initializer) {
        return { admitted: false, reason: 'Default parameter initializers are unsupported in F0' };
      }
      if (node.modifiers && node.modifiers.length > 0) {
        return { admitted: false, reason: 'Parameter property modifiers are unsupported in F0' };
      }
      if (!node.type) {
        return { admitted: false, reason: 'Parameters must have explicit type annotations in F0' };
      }
      return { admitted: true, productionId: F0ProductionId.F0_PARAMETER };
    }

    // 9. Block
    if (ts.isBlock(node)) {
      return { admitted: true, productionId: F0ProductionId.F0_BLOCK };
    }

    // 10. ReturnStatement
    if (ts.isReturnStatement(node)) {
      return { admitted: true, productionId: F0ProductionId.F0_RETURN_STATEMENT };
    }

    // F0.2 admits only a terminal, side-effect-free literal Error throw.  It
    // is a body-outcome witness, not general exception-flow support.
    if (ts.isThrowStatement(node)) {
      const expression = node.expression;
      if (!expression || !ts.isNewExpression(expression) || !ts.isIdentifier(expression.expression) ||
          expression.expression.text !== 'Error' || (expression.arguments?.length ?? 0) > 1 ||
          (expression.arguments?.[0] && !ts.isStringLiteral(expression.arguments[0]))) {
        return { admitted: false, reason: 'F0.2 admits only throw new Error() or throw new Error("literal")' };
      }
      return { admitted: true, productionId: F0ProductionId.F0_THROW_STATEMENT };
    }
    if (ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'Error' && (node.arguments?.length ?? 0) <= 1 &&
          (!node.arguments?.[0] || ts.isStringLiteral(node.arguments[0]))) {
        return { admitted: true, productionId: F0ProductionId.F0_LITERAL_ERROR_CONSTRUCTION };
      }
      return { admitted: false, reason: 'F0.2 admits only literal Error construction' };
    }

    // 11. ExpressionStatement
    if (ts.isExpressionStatement(node)) {
      return { admitted: true, productionId: F0ProductionId.F0_EXPRESSION_STATEMENT };
    }

    // 12. TypeAliasDeclaration
    if (ts.isTypeAliasDeclaration(node)) {
      if (!ts.isIdentifier(node.name)) {
        return { admitted: false, reason: 'Type alias must have identifier name' };
      }
      if (node.typeParameters && node.typeParameters.length > 0) {
        return { admitted: false, reason: 'Generic type aliases are unsupported in F0' };
      }
      if (node.modifiers) {
        for (const mod of node.modifiers) {
          if (mod.kind !== ts.SyntaxKind.ExportKeyword) {
            return { admitted: false, reason: `Unsupported type alias modifier: ${ts.SyntaxKind[mod.kind]}` };
          }
        }
      }
      return { admitted: true, productionId: F0ProductionId.F0_TYPE_ALIAS_DECLARATION };
    }

    // 13. InterfaceDeclaration
    if (ts.isInterfaceDeclaration(node)) {
      if (!ts.isIdentifier(node.name)) {
        return { admitted: false, reason: 'Interface must have identifier name' };
      }
      if (node.typeParameters && node.typeParameters.length > 0) {
        return { admitted: false, reason: 'Generic interfaces are unsupported in F0' };
      }
      if (node.heritageClauses && node.heritageClauses.length > 0) {
        return { admitted: false, reason: 'Interface inheritance (extends) is unsupported in F0' };
      }
      if (node.members.length === 0) {
        return { admitted: false, reason: 'Empty interfaces are unsupported in F0' };
      }
      if (node.modifiers) {
        for (const mod of node.modifiers) {
          if (mod.kind !== ts.SyntaxKind.ExportKeyword) {
            return { admitted: false, reason: `Unsupported interface modifier: ${ts.SyntaxKind[mod.kind]}` };
          }
        }
      }
      return { admitted: true, productionId: F0ProductionId.F0_INTERFACE_DECLARATION };
    }

    // 14. PropertySignature
    if (ts.isPropertySignature(node)) {
      if (!ts.isIdentifier(node.name)) {
        return { admitted: false, reason: 'Computed or non-identifier property names are unsupported in F0' };
      }
      if (node.questionToken) {
        return { admitted: false, reason: 'Optional interface properties are unsupported in F0' };
      }
      // Must have readonly modifier
      const hasReadonly = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ReadonlyKeyword);
      if (!hasReadonly) {
        return { admitted: false, reason: 'Interface properties must be declared readonly in F0' };
      }
      if (!node.type) {
        return { admitted: false, reason: 'Interface properties must have explicit type annotations in F0' };
      }
      return { admitted: true, productionId: F0ProductionId.F0_PROPERTY_SIGNATURE };
    }

    // 15. ImportDeclaration
    if (ts.isImportDeclaration(node)) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) {
        return { admitted: false, reason: 'Import module specifier must be string literal' };
      }
      return { admitted: true, productionId: F0ProductionId.F0_IMPORT_DECLARATION };
    }

    // 16. ImportClause
    if (ts.isImportClause(node)) {
      if (node.name) {
        // The sole static default clause is an alias for the explicit named
        // form `import { default as local }`.  Mixed and namespace forms stay
        // outside F0 because this capability deliberately admits one binding.
        if (node.namedBindings) {
          return { admitted: false, reason: 'Default imports combined with named or namespace imports are unsupported in F0' };
        }
        return { admitted: true, productionId: F0ProductionId.F0_IMPORT_CLAUSE };
      }
      if (!node.namedBindings || (!ts.isNamedImports(node.namedBindings) && !ts.isNamespaceImport(node.namedBindings))) {
        return { admitted: false, reason: 'Only named imports are supported in F0' };
      }
      return { admitted: true, productionId: F0ProductionId.F0_IMPORT_CLAUSE };
    }

    // 17. NamedImports
    if (ts.isNamedImports(node)) {
      return { admitted: true, productionId: F0ProductionId.F0_NAMED_IMPORTS };
    }

    if (ts.isNamespaceImport(node)) {
      return { admitted: true, productionId: F0ProductionId.F0_NAMESPACE_IMPORT };
    }

    // 18. ImportSpecifier
    if (ts.isImportSpecifier(node)) {
      return { admitted: true, productionId: F0ProductionId.F0_IMPORT_SPECIFIER };
    }

    // 19. ExportDeclaration
    if (ts.isExportDeclaration(node)) {
      if (!node.exportClause || !ts.isNamedExports(node.exportClause)) {
        return { admitted: false, reason: 'Wildcard exports (export *) are unsupported in F0' };
      }
      return { admitted: true, productionId: F0ProductionId.F0_EXPORT_DECLARATION };
    }

    // 20. NamedExports
    if (ts.isNamedExports(node)) {
      return { admitted: true, productionId: F0ProductionId.F0_NAMED_EXPORTS };
    }

    // 21. ExportSpecifier
    if (ts.isExportSpecifier(node)) {
      return { admitted: true, productionId: F0ProductionId.F0_EXPORT_SPECIFIER };
    }

    // 22. Identifier
    if (ts.isIdentifier(node)) {
      return { admitted: true, productionId: F0ProductionId.F0_IDENTIFIER };
    }

    // 23. Literals
    if (ts.isStringLiteral(node)) {
      return { admitted: true, productionId: F0ProductionId.F0_STRING_LITERAL };
    }
    if (ts.isNumericLiteral(node)) {
      return { admitted: true, productionId: F0ProductionId.F0_NUMERIC_LITERAL };
    }
    // TypeScript represents `-1` as a PrefixUnaryExpression over a numeric
    // literal.  F0 admits precisely this literal form, not general unary
    // arithmetic or mutation operators.
    if (ts.isPrefixUnaryExpression(node)) {
      if (node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
        return { admitted: true, productionId: F0ProductionId.F0_NEGATIVE_NUMERIC_LITERAL };
      }
      return { admitted: false, reason: 'Only negative numeric literals are supported unary expressions in F0' };
    }
    // A closed arithmetic form is useful for implementation-only changes
    // while remaining independently checkable from syntax alone.  Both
    // operands must be numeric literals (possibly the admitted `-N` form),
    // so names, calls, coercion, and side effects stay outside F0.
    if (ts.isBinaryExpression(node)) {
      const numericLiteral = (expression: ts.Expression): boolean =>
        ts.isNumericLiteral(expression) ||
        (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken &&
          ts.isNumericLiteral(expression.operand));
      if (numericLiteral(node.left) && numericLiteral(node.right) &&
          [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
            ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken].includes(node.operatorToken.kind)) {
        return { admitted: true, productionId: F0ProductionId.F0_NUMERIC_LITERAL_BINARY_EXPRESSION };
      }
      return { admitted: false, reason: 'Only arithmetic between numeric literals is supported in F0 binary expressions' };
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) {
      return { admitted: true, productionId: F0ProductionId.F0_TRUE_KEYWORD };
    }
    if (node.kind === ts.SyntaxKind.FalseKeyword) {
      return { admitted: true, productionId: F0ProductionId.F0_FALSE_KEYWORD };
    }
    if (node.kind === ts.SyntaxKind.NullKeyword) {
      return { admitted: true, productionId: F0ProductionId.F0_NULL_KEYWORD };
    }
    if (node.kind === ts.SyntaxKind.UndefinedKeyword) {
      return { admitted: true, productionId: F0ProductionId.F0_KEYWORD_TYPE };
    }

    // 24. CallExpression
    if (ts.isCallExpression(node)) {
      if (node.typeArguments && node.typeArguments.length > 0) {
        return { admitted: false, reason: 'Type arguments on call expressions are unsupported in F0' };
      }
      return { admitted: true, productionId: F0ProductionId.F0_CALL_EXPRESSION };
    }

    // 25. PropertyAccessExpression
    if (ts.isPropertyAccessExpression(node)) {
      if (!ts.isIdentifier(node.name)) {
        return { admitted: false, reason: 'Property access name must be identifier' };
      }
      return { admitted: true, productionId: F0ProductionId.F0_PROPERTY_ACCESS_EXPRESSION };
    }

    // 26. ObjectLiteralExpression
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) {
          return { admitted: false, reason: 'Only explicit property assignments are supported in object literals (no shorthand, methods, or spread)' };
        }
      }
      return { admitted: true, productionId: F0ProductionId.F0_OBJECT_LITERAL_EXPRESSION };
    }

    // 27. PropertyAssignment
    if (ts.isPropertyAssignment(node)) {
      if (!ts.isIdentifier(node.name)) {
        return { admitted: false, reason: 'Object literal property names must be identifiers' };
      }
      return { admitted: true, productionId: F0ProductionId.F0_PROPERTY_ASSIGNMENT };
    }

    // 28. ParenthesizedExpression
    if (ts.isParenthesizedExpression(node)) {
      return { admitted: true, productionId: F0ProductionId.F0_PARENTHESIZED_EXPRESSION };
    }

    // 29. Types
    if (
      node.kind === ts.SyntaxKind.StringKeyword ||
      node.kind === ts.SyntaxKind.NumberKeyword ||
      node.kind === ts.SyntaxKind.BooleanKeyword ||
      node.kind === ts.SyntaxKind.NeverKeyword ||
      node.kind === ts.SyntaxKind.VoidKeyword
    ) {
      return { admitted: true, productionId: F0ProductionId.F0_KEYWORD_TYPE };
    }

    if (ts.isLiteralTypeNode(node)) {
      const lit = node.literal;
      if (
        ts.isStringLiteral(lit) ||
        ts.isNumericLiteral(lit) ||
        lit.kind === ts.SyntaxKind.TrueKeyword ||
        lit.kind === ts.SyntaxKind.FalseKeyword ||
        lit.kind === ts.SyntaxKind.NullKeyword
      ) {
        return { admitted: true, productionId: F0ProductionId.F0_LITERAL_TYPE };
      }
      return { admitted: false, reason: `Unsupported literal type: ${ts.SyntaxKind[lit.kind]}` };
    }

    if (ts.isUnionTypeNode(node)) {
      if (node.types.length < 2) {
        return { admitted: false, reason: 'Union type must have at least 2 member types' };
      }
      return { admitted: true, productionId: F0ProductionId.F0_UNION_TYPE };
    }

    if (ts.isTypeReferenceNode(node)) {
      if (!ts.isIdentifier(node.typeName)) {
        return { admitted: false, reason: 'Qualified type references are unsupported in F0' };
      }
      if (node.typeArguments && node.typeArguments.length > 0) {
        return { admitted: false, reason: 'Generic type references are unsupported in F0' };
      }
      return { admitted: true, productionId: F0ProductionId.F0_TYPE_REFERENCE };
    }

    if (ts.isTypeLiteralNode(node)) {
      if (node.members.length === 0) {
        return { admitted: false, reason: 'Empty F0 type literals are unsupported' };
      }
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name) || member.questionToken || !member.type) {
          return { admitted: false, reason: 'Only required identifier readonly properties with explicit scalar types are supported in F0 type literals' };
        }
        const readonlyProperty = member.modifiers?.some(m => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
        if (!readonlyProperty) {
          return { admitted: false, reason: 'F0 type literal properties must be readonly' };
        }
      }
      return { admitted: true, productionId: F0ProductionId.F0_TYPE_LITERAL };
    }

    // Reject all other syntax forms fail-closed
    return {
      admitted: false,
      reason: `Unsupported syntax node kind: ${ts.SyntaxKind[node.kind]}`
    };
  }
}
