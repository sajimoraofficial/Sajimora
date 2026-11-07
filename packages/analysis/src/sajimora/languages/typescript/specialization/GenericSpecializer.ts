import * as ts from 'typescript';
import { GenericTypeArgumentContext } from '@sajimora/core';
import { TypeScriptTypeIR } from '../ir/TypeScriptTypeIR';
import { TypeScriptTypeIRExtractor } from '../ir/TypeScriptTypeIRExtractor';

export interface GenericSpecializationResult {
  readonly success: boolean;
  readonly genericTypeArguments?: ReadonlyArray<GenericTypeArgumentContext<TypeScriptTypeIR>>;
  readonly blockerId?: 'GENERIC_BINDING_UNAVAILABLE';
  readonly failureDetail?: string;
}

export class GenericSpecializer {
  public static specializeCallGenerics(
    callExpr: ts.CallLikeExpression,
    parentChecker: ts.TypeChecker
  ): GenericSpecializationResult {
    const contexts: GenericTypeArgumentContext<TypeScriptTypeIR>[] = [];

    // 1. Explicit generic type arguments
    const typeArgs = (callExpr as any).typeArguments as ts.NodeArray<ts.TypeNode> | undefined;
    if (typeArgs && typeArgs.length > 0) {
      for (let i = 0; i < typeArgs.length; i++) {
        const typeNode = typeArgs[i];
        const type = parentChecker.getTypeFromTypeNode(typeNode);
        const typeIR = TypeScriptTypeIRExtractor.extractFromType(
          type,
          parentChecker,
          'PARENT',
          callExpr.getSourceFile()
        );
        contexts.push({
          position: i,
          type: typeIR,
          provenance: 'EXPLICIT'
        });
      }
      return {
        success: true,
        genericTypeArguments: contexts
      };
    }

    // 2. Inferred generic type arguments from parent call site
    try {
      const parentSig = parentChecker.getResolvedSignature(callExpr);
      if (parentSig && (parentSig as any).typeParameters && (parentSig as any).typeParameters.length > 0) {
        const typeParams = (parentSig as any).typeParameters as ts.TypeParameter[];
        const typeArgs = (parentSig as any).typeArguments as ts.Type[] | undefined;

        if (typeArgs && typeArgs.length === typeParams.length) {
          for (let i = 0; i < typeArgs.length; i++) {
            const typeIR = TypeScriptTypeIRExtractor.extractFromType(
              typeArgs[i],
              parentChecker,
              'PARENT',
              callExpr.getSourceFile()
            );
            contexts.push({
              position: i,
              type: typeIR,
              provenance: 'INFERRED',
              typeParameterName: typeParams[i].getSymbol()?.getName()
            });
          }
          return {
            success: true,
            genericTypeArguments: contexts
          };
        }
      }

      return {
        success: true,
        genericTypeArguments: []
      };
    } catch (err: unknown) {
      return {
        success: false,
        blockerId: 'GENERIC_BINDING_UNAVAILABLE',
        failureDetail: err instanceof Error ? err.message : String(err)
      };
    }
  }
}
