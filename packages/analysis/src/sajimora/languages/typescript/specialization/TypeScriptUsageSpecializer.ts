import * as ts from 'typescript';
import {
  UsageSite,
  SpecializedUsageContract,
  ArgumentSpecializationContext,
  GenericTypeArgumentContext,
  Phase4BlockerId,
  SpecializationResult,
  canonicalJson
} from '@sajimora/core';
import { TypeScriptTypeIR } from '../ir/TypeScriptTypeIR';
import { TypeScriptTypeIRExtractor } from '../ir/TypeScriptTypeIRExtractor';
import { OverloadResolver } from './OverloadResolver';
import { GenericSpecializer } from './GenericSpecializer';

export interface DualProgramContext {
  readonly parentProgram: ts.Program;
  readonly candidateProgram?: ts.Program;
}

export class TypeScriptUsageSpecializer {
  public static specializeSite(
    site: UsageSite,
    programs: DualProgramContext
  ): SpecializationResult<TypeScriptTypeIR> {
    const parentChecker = programs.parentProgram.getTypeChecker();

    const parentOccurrence = (site as any).parentCanonicalOccurrence ?? site.canonicalOccurrence;
    const { sourceFile: fileName, sourceSpan, usageRole } = parentOccurrence;

    // 1. Locate source file in parent program
    const normalized = fileName.replace(/\\/g, '/');
    let parentSourceFile = programs.parentProgram.getSourceFile(normalized)
      || programs.parentProgram.getSourceFile(fileName);
    if (!parentSourceFile) {
      parentSourceFile = programs.parentProgram.getSourceFiles().find(sf =>
        sf.fileName === normalized || sf.fileName.replace(/\\/g, '/') === normalized ||
        sf.fileName.toLowerCase() === normalized.toLowerCase() ||
        sf.fileName.replace(/\\/g, '/').toLowerCase() === normalized.toLowerCase() ||
        sf.fileName.endsWith(normalized) || normalized.endsWith(sf.fileName.replace(/\\/g, '/'))
      );
    }
    if (!parentSourceFile) {
      return {
        success: false,
        blockerId: 'HISTORICAL_EXPECTATION_UNRECOVERABLE',
        errorDetail: `Source file '${fileName}' not found in parent program`
      };
    }

    // 2. Locate AST node at sourceSpan
    const node = this.findNodeAtSpan(parentSourceFile, sourceSpan.start, sourceSpan.end);
    if (!node) {
      return {
        success: false,
        blockerId: 'CONSUMER_AST_UNRESOLVABLE',
        errorDetail: `AST node at span [${sourceSpan.start}, ${sourceSpan.end}] not found in parent file '${fileName}'`
      };
    }

    // 3. Specialize based on usageRole
    if (usageRole === 'CALL_SITE') {
      return this.specializeCallSite(node, parentChecker);
    }

    if (usageRole === 'JSX_ELEMENT') {
      return this.specializeJsxElement(node, parentChecker);
    }

    if (usageRole === 'METHOD_REFERENCE' || usageRole === 'VALUE_ASSIGNMENT' || usageRole === 'RETURN_VALUE') {
      return this.specializeValueReference(node, parentChecker, usageRole);
    }

    if (usageRole === 'TYPE_ANNOTATION' || usageRole === 'GENERIC_ARGUMENT') {
      return this.specializeTypeReference(node, parentChecker, usageRole);
    }

    if (usageRole === 'INTERFACE_IMPLEMENTATION' || usageRole === 'INHERITANCE' || usageRole === 'METHOD_OVERRIDE') {
      return this.specializeInheritance(node, parentChecker, usageRole);
    }

    // Generic / default fallback specialization
    const expectedType = TypeScriptTypeIRExtractor.extractFromNode(node, parentChecker, 'PARENT');
    const usageContract: SpecializedUsageContract<TypeScriptTypeIR> = {
      schemaVersion: 'SAJIMORA_USAGE_CONTRACT_V1',
      languageId: 'typescript',
      usageRole,
      expectedType,
      isDiscardedReturn: false,
      hasCompleteSpecializationEvidence: true,
      usageHash: expectedType.irContentHash
    };

    return {
      success: true,
      specializedContract: usageContract
    };
  }

  private static specializeCallSite(
    node: ts.Node,
    parentChecker: ts.TypeChecker
  ): SpecializationResult<TypeScriptTypeIR> {
    const callExpr = this.findEnclosingCall(node);
    if (!callExpr) {
      return {
        success: false,
        blockerId: 'CONSUMER_AST_UNRESOLVABLE',
        errorDetail: 'Enclosing CallExpression not found'
      };
    }

    // Overload resolution
    const parentOverload = OverloadResolver.resolveSignature(callExpr, parentChecker);
    if (!parentOverload.success) {
      return {
        success: false,
        blockerId: parentOverload.blockerId,
        errorDetail: parentOverload.failureDetail
      };
    }

    // Arguments specialization
    const argContexts: ArgumentSpecializationContext<TypeScriptTypeIR>[] = [];
    for (let i = 0; i < callExpr.arguments.length; i++) {
      const arg = callExpr.arguments[i];
      const isFreshLiteral = ts.isObjectLiteralExpression(arg);
      const argType = parentChecker.getTypeAtLocation(arg);
      const argTypeIR = TypeScriptTypeIRExtractor.extractFromType(
        argType,
        parentChecker,
        'PARENT',
        arg.getSourceFile(),
        { isFreshLiteral }
      );
      argContexts.push({
        position: i,
        type: argTypeIR,
        isFreshLiteral
      });
    }

    // Generic specialization
    let genericContexts: ReadonlyArray<GenericTypeArgumentContext<TypeScriptTypeIR>> = [];
    const genRes = GenericSpecializer.specializeCallGenerics(callExpr, parentChecker);
    if (!genRes.success) {
      return {
        success: false,
        blockerId: genRes.blockerId,
        errorDetail: genRes.failureDetail
      };
    }
    genericContexts = genRes.genericTypeArguments ?? [];

    // Finding 5: Type predicate and assertion effects on parent signature
    const parentPredicate = parentOverload.selectedSignature
      ? parentChecker.getTypePredicateOfSignature(parentOverload.selectedSignature)
      : undefined;
    let parentPredicateIR: import('../ir/TypeScriptTypeIR').TypeScriptTypePredicateIR | undefined;
    if (parentPredicate) {
      let kind: import('../ir/TypeScriptTypeIR').TypeScriptTypePredicateIR['kind'] = 'IDENTIFIER';
      const pKind = parentPredicate.kind as number;
      if (pKind === 2) {
        kind = 'ASSERTS_IDENTIFIER';
      } else if (pKind === 3) {
        kind = 'THIS';
      } else if (pKind === 4) {
        kind = 'ASSERTS_THIS';
      }
      const targetType = parentPredicate.type ? TypeScriptTypeIRExtractor.extractFromType(parentPredicate.type, parentChecker, 'PARENT') : undefined;
      parentPredicateIR = {
        kind,
        parameterName: parentPredicate.parameterName,
        parameterIndex: parentPredicate.parameterIndex,
        targetType
      };
    }

    // Return obligation verification (§5.2.1.1 & §6.5.4)
    const parentNode = callExpr.parent;
    let isDiscardedReturn = false;
    let expectedReturnType: TypeScriptTypeIR;

    let hasDownstreamInferredUses = false;
    let hasDownstreamWrites = false;
    let downstreamWrittenProps: string[] | undefined;

    if (ts.isExpressionStatement(parentNode)) {
      // Case 1: Statement-level call, return is discarded unless an assertion or predicate effect is present
      if (parentPredicateIR) {
        isDiscardedReturn = false;
        expectedReturnType = TypeScriptTypeIRExtractor.createPrimitiveIR('void', 'PARENT');
      } else {
        isDiscardedReturn = true;
        expectedReturnType = TypeScriptTypeIRExtractor.createPrimitiveIR('void', 'PARENT');
      }
    } else if (ts.isVariableDeclaration(parentNode) && parentNode.type) {
      // Case 2a: Explicit type annotation on binding
      const annotatedType = parentChecker.getTypeFromTypeNode(parentNode.type);
      expectedReturnType = TypeScriptTypeIRExtractor.extractFromType(annotatedType, parentChecker, 'PARENT');
    } else if (ts.isCallExpression(parentNode)) {
      // Case 2a: Consumed as argument with contextual type
      const contextualType = parentChecker.getContextualType(callExpr);
      if (contextualType) {
        expectedReturnType = TypeScriptTypeIRExtractor.extractFromType(contextualType, parentChecker, 'PARENT');
      } else {
        const parentRetType = parentOverload.selectedSignature!.getReturnType();
        expectedReturnType = TypeScriptTypeIRExtractor.extractFromType(parentRetType, parentChecker, 'PARENT');
      }
    } else if (ts.isVariableDeclaration(parentNode) && !parentNode.type) {
      // Case 3: Inferred variable binding
      // Check if downstream statements exist in the enclosing block
      const hasDownstreamStatements = this.hasDownstreamUses(parentNode);
      const parentRetType = parentOverload.selectedSignature!.getReturnType();
      expectedReturnType = TypeScriptTypeIRExtractor.extractFromType(parentRetType, parentChecker, 'PARENT');

      if (hasDownstreamStatements) {
        hasDownstreamInferredUses = true;
        downstreamWrittenProps = this.getDownstreamPropertyWrites(parentNode);
        hasDownstreamWrites = downstreamWrittenProps.length > 0;
      }
    } else {
      const parentRetType = parentOverload.selectedSignature!.getReturnType();
      expectedReturnType = TypeScriptTypeIRExtractor.extractFromType(parentRetType, parentChecker, 'PARENT');
    }

    // Receiver requirement type
    let receiverRequirementType: TypeScriptTypeIR | undefined;
    if (ts.isPropertyAccessExpression(callExpr.expression)) {
      const receiverType = parentChecker.getTypeAtLocation(callExpr.expression.expression);
      receiverRequirementType = TypeScriptTypeIRExtractor.extractFromType(receiverType, parentChecker, 'PARENT');
    }

    const usageContract: SpecializedUsageContract<TypeScriptTypeIR> = {
      schemaVersion: 'SAJIMORA_USAGE_CONTRACT_V1',
      languageId: 'typescript',
      usageRole: 'CALL_SITE',
      expectedType: expectedReturnType,
      arguments: argContexts,
      genericTypeArguments: genericContexts,
      receiverRequirementType,
      isDiscardedReturn,
      hasCompleteSpecializationEvidence: true,
      hasDownstreamInferredUses,
      hasDownstreamWrites,
      downstreamWrittenProperties: downstreamWrittenProps,
      parentPredicate: parentPredicateIR,
      usageHash: expectedReturnType.irContentHash
    };

    return {
      success: true,
      specializedContract: usageContract
    };
  }

  private static getDownstreamPropertyWrites(varDecl: ts.VariableDeclaration): string[] {
    if (!ts.isIdentifier(varDecl.name)) return [];
    const varName = varDecl.name.text;
    const varStatement = varDecl.parent?.parent;
    if (!varStatement || !ts.isVariableStatement(varStatement)) return [];
    const block = varStatement.parent;
    if (!block || (!ts.isBlock(block) && !ts.isSourceFile(block))) return [];

    const statements = (block as any).statements as ts.NodeArray<ts.Statement>;
    const idx = statements.indexOf(varStatement);
    if (idx === -1) return [];

    const aliases = new Set<string>([varName]);
    const writtenProps: string[] = [];
    const checkNode = (node: ts.Node): void => {
      // Track variable declarations that alias one of our tracked variables: const a = r;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer)) {
        if (aliases.has(node.initializer.text)) {
          aliases.add(node.name.text);
        }
      }
      // Track assignments: a = r;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(node.left) && ts.isIdentifier(node.right) && aliases.has(node.right.text)) {
          aliases.add(node.left.text);
        }
      }

      if (ts.isBinaryExpression(node)) {
        const isAssignment =
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.AsteriskEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.SlashEqualsToken;
        if (isAssignment) {
          const left = node.left;
          if (ts.isPropertyAccessExpression(left)) {
            if (ts.isIdentifier(left.expression) && aliases.has(left.expression.text)) {
              writtenProps.push(left.name.text);
            }
          } else if (ts.isElementAccessExpression(left)) {
            if (ts.isIdentifier(left.expression) && aliases.has(left.expression.text)) {
              if (left.argumentExpression && ts.isStringLiteral(left.argumentExpression)) {
                writtenProps.push(left.argumentExpression.text);
              } else {
                writtenProps.push('*');
              }
            }
          }
        }
      }
      ts.forEachChild(node, checkNode);
    };

    for (let i = idx + 1; i < statements.length; i++) {
      checkNode(statements[i]);
    }
    return writtenProps;
  }

  private static hasDownstreamUses(varDecl: ts.VariableDeclaration): boolean {
    const varStatement = varDecl.parent?.parent;
    if (!varStatement || !ts.isVariableStatement(varStatement)) return false;
    const block = varStatement.parent;
    if (!block || (!ts.isBlock(block) && !ts.isSourceFile(block))) return false;

    const statements = (block as any).statements as ts.NodeArray<ts.Statement>;
    const idx = statements.indexOf(varStatement);
    return idx !== -1 && idx < statements.length - 1;
  }

  private static specializeValueReference(
    node: ts.Node,
    parentChecker: ts.TypeChecker,
    usageRole: SpecializedUsageContract<TypeScriptTypeIR>['usageRole']
  ): SpecializationResult<TypeScriptTypeIR> {
    const contextualType = parentChecker.getContextualType(node as ts.Expression);
    let expectedType: TypeScriptTypeIR;

    if (contextualType) {
      expectedType = TypeScriptTypeIRExtractor.extractFromType(contextualType, parentChecker, 'PARENT');
      // If contextual type is a generic function reference, check for polymorphic requirement
      if (contextualType.getCallSignatures().some(s => (s as any).typeParameters && (s as any).typeParameters.length > 0)) {
        return {
          success: false,
          blockerId: 'POLYMORPHIC_FUNCTION_REFERENCE_UNSUPPORTED',
          errorDetail: 'Polymorphic function reference requires universally quantified proof'
        };
      }
    } else {
      expectedType = TypeScriptTypeIRExtractor.extractFromNode(node, parentChecker, 'PARENT');
    }

    const usageContract: SpecializedUsageContract<TypeScriptTypeIR> = {
      schemaVersion: 'SAJIMORA_USAGE_CONTRACT_V1',
      languageId: 'typescript',
      usageRole,
      expectedType,
      isDiscardedReturn: false,
      hasCompleteSpecializationEvidence: true,
      usageHash: expectedType.irContentHash
    };

    return {
      success: true,
      specializedContract: usageContract
    };
  }

  private static specializeTypeReference(
    node: ts.Node,
    parentChecker: ts.TypeChecker,
    usageRole: SpecializedUsageContract<TypeScriptTypeIR>['usageRole']
  ): SpecializationResult<TypeScriptTypeIR> {
    const expectedType = TypeScriptTypeIRExtractor.extractFromNode(node, parentChecker, 'PARENT');
    const usageContract: SpecializedUsageContract<TypeScriptTypeIR> = {
      schemaVersion: 'SAJIMORA_USAGE_CONTRACT_V1',
      languageId: 'typescript',
      usageRole,
      expectedType,
      isDiscardedReturn: false,
      hasCompleteSpecializationEvidence: true,
      usageHash: expectedType.irContentHash
    };

    return {
      success: true,
      specializedContract: usageContract
    };
  }

  private static specializeInheritance(
    node: ts.Node,
    parentChecker: ts.TypeChecker,
    usageRole: SpecializedUsageContract<TypeScriptTypeIR>['usageRole']
  ): SpecializationResult<TypeScriptTypeIR> {
    const expectedType = TypeScriptTypeIRExtractor.extractFromNode(node, parentChecker, 'PARENT');
    const usageContract: SpecializedUsageContract<TypeScriptTypeIR> = {
      schemaVersion: 'SAJIMORA_USAGE_CONTRACT_V1',
      languageId: 'typescript',
      usageRole,
      expectedType,
      isDiscardedReturn: false,
      hasCompleteSpecializationEvidence: true,
      usageHash: expectedType.irContentHash
    };

    return {
      success: true,
      specializedContract: usageContract
    };
  }

  private static findEnclosingCall(node: ts.Node): ts.CallExpression | undefined {
    let curr: ts.Node | undefined = node;
    while (curr) {
      if (ts.isCallExpression(curr)) return curr;
      curr = curr.parent;
    }

    let foundCall: ts.CallExpression | undefined;
    const searchDown = (n: ts.Node): void => {
      if (foundCall) return;
      if (ts.isCallExpression(n)) {
        foundCall = n;
        return;
      }
      ts.forEachChild(n, searchDown);
    };
    searchDown(node);
    return foundCall;
  }

  private static findEnclosingJsxElement(node: ts.Node): ts.JsxOpeningLikeElement | undefined {
    let curr: ts.Node | undefined = node;
    while (curr) {
      if (ts.isJsxOpeningLikeElement(curr)) return curr as ts.JsxOpeningLikeElement;
      curr = curr.parent;
    }

    let foundJsx: ts.JsxOpeningLikeElement | undefined;
    const searchDown = (n: ts.Node): void => {
      if (foundJsx) return;
      if (ts.isJsxOpeningLikeElement(n)) {
        foundJsx = n;
        return;
      }
      ts.forEachChild(n, searchDown);
    };
    searchDown(node);
    return foundJsx;
  }

  private static specializeJsxElement(
    node: ts.Node,
    parentChecker: ts.TypeChecker
  ): SpecializationResult<TypeScriptTypeIR> {
    const jsxExpr = this.findEnclosingJsxElement(node);
    if (!jsxExpr) {
      return {
        success: false,
        blockerId: 'CONSUMER_AST_UNRESOLVABLE',
        errorDetail: 'Enclosing JSX element not found'
      };
    }

    // Overload resolution
    const parentOverload = OverloadResolver.resolveSignature(jsxExpr, parentChecker);
    if (!parentOverload.success) {
      return {
        success: false,
        blockerId: parentOverload.blockerId,
        errorDetail: parentOverload.failureDetail
      };
    }

    // Arguments specialization
    // For JSX, the first and only parameter in the signature represents the props requirement.
    // We extract the effective props requirement exactly as TypeScript compiler sees it for JSX checking.
    const argContexts: ArgumentSpecializationContext<TypeScriptTypeIR>[] = [];
    if (parentOverload.selectedSignature) {
      const parameters = parentOverload.selectedSignature.getParameters();
      if (parameters.length > 0) {
        const propsParam = parameters[0];
        const propsType = parentChecker.getTypeOfSymbolAtLocation(propsParam, jsxExpr);
        const propsTypeIR = TypeScriptTypeIRExtractor.extractFromType(
          propsType,
          parentChecker,
          'PARENT',
          jsxExpr.getSourceFile(),
          { isFreshLiteral: true }
        );
        argContexts.push({
          position: 0,
          type: propsTypeIR,
          isFreshLiteral: true
        });
      }
    }

    // Generic specialization
    let genericContexts: ReadonlyArray<GenericTypeArgumentContext<TypeScriptTypeIR>> = [];
    const genRes = GenericSpecializer.specializeCallGenerics(jsxExpr, parentChecker);
    if (!genRes.success) {
      return {
        success: false,
        blockerId: genRes.blockerId,
        errorDetail: genRes.failureDetail
      };
    }
    genericContexts = genRes.genericTypeArguments ?? [];

    const expectedType = TypeScriptTypeIRExtractor.extractFromNode(jsxExpr, parentChecker, 'PARENT');

    const usageContract: SpecializedUsageContract<TypeScriptTypeIR> = {
      schemaVersion: 'SAJIMORA_USAGE_CONTRACT_V1',
      languageId: 'typescript',
      usageRole: 'JSX_ELEMENT',
      expectedType,
      arguments: argContexts,
      genericTypeArguments: genericContexts,
      isDiscardedReturn: false,
      hasCompleteSpecializationEvidence: true,
      hasDownstreamInferredUses: false,
      hasDownstreamWrites: false,
      usageHash: expectedType.irContentHash
    };

    return {
      success: true,
      specializedContract: usageContract
    };
  }

  private static findNodeAtSpan(
    sf: ts.SourceFile,
    start: number,
    end: number
  ): ts.Node | undefined {
    let match: ts.Node | undefined;
    const visit = (node: ts.Node): void => {
      if (node.getStart(sf) <= start && node.getEnd() >= end) {
        match = node;
        ts.forEachChild(node, visit);
      }
    };
    visit(sf);
    return match;
  }
}
