import * as ts from 'typescript';

export interface OverloadResolutionResult {
  readonly success: boolean;
  readonly selectedSignature?: ts.Signature;
  readonly blockerId?: 'OVERLOAD_SELECTION_UNAVAILABLE';
  readonly failureDetail?: string;
  readonly isImplementationSignature?: boolean;
}

export class OverloadResolver {
  public static resolveSignature(
    callExpr: ts.CallLikeExpression,
    checker: ts.TypeChecker
  ): OverloadResolutionResult {
    try {
      const sig = checker.getResolvedSignature(callExpr);
      if (!sig) {
        return {
          success: false,
          blockerId: 'OVERLOAD_SELECTION_UNAVAILABLE',
          failureDetail: 'TypeChecker returned undefined for resolved signature'
        };
      }

      // Check if signature is an implementation signature
      const decl = sig.getDeclaration();
      if (decl && ts.isFunctionLike(decl)) {
        if ((decl as ts.FunctionLikeDeclaration).body !== undefined) {
          // If declaration has a body, check if there are preceding overload declarations
          const symbol = decl.name ? checker.getSymbolAtLocation(decl.name) : undefined;
          const declarations = symbol?.getDeclarations() ?? [];
          if (declarations.length > 1 && declarations[declarations.length - 1] === decl) {
            // Implementation signature
            return {
              success: false,
              isImplementationSignature: true,
              blockerId: 'OVERLOAD_SELECTION_UNAVAILABLE',
              failureDetail: 'Selected signature is a non-callable implementation signature'
            };
          }
        }
      }

      return {
        success: true,
        selectedSignature: sig
      };
    } catch (err: unknown) {
      return {
        success: false,
        blockerId: 'OVERLOAD_SELECTION_UNAVAILABLE',
        failureDetail: err instanceof Error ? err.message : String(err)
      };
    }
  }
}
