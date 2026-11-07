import { VarianceFrame } from '@sajimora/core';

export type VarianceKind = 'COVARIANT' | 'CONTRAVARIANT' | 'INVARIANT';

export class TypeScriptVarianceComposer {
  /**
   * Variance composition algebra through nesting levels (§6.4.9 item 3):
   * Outer \ Inner | Covariant (+) | Contravariant (-) | Invariant (0)
   * Covariant (+) | Covariant (+) | Contravariant (-) | Invariant (0)
   * Contravariant (-)| Contravariant (-)| Covariant (+)  | Invariant (0)
   * Invariant (0) | Invariant (0) | Invariant (0)     | Invariant (0)
   */
  public static composeVariance(outer: VarianceKind, inner: VarianceKind): VarianceKind {
    if (outer === 'INVARIANT' || inner === 'INVARIANT') {
      return 'INVARIANT';
    }
    if (outer === 'COVARIANT') {
      return inner;
    }
    // outer === 'CONTRAVARIANT'
    if (inner === 'COVARIANT') return 'CONTRAVARIANT';
    return 'COVARIANT'; // (-) * (-) = (+)
  }

  public static pushFrame(
    stack: ReadonlyArray<VarianceFrame>,
    position: VarianceFrame['position'],
    localVariance: VarianceKind,
    declarationSyntax: VarianceFrame['declarationSyntax'],
    isActualCallSiteArgument: boolean
  ): VarianceFrame[] {
    const level = stack.length;
    let composedVariance = localVariance;
    if (level > 0) {
      const parent = stack[level - 1];
      composedVariance = this.composeVariance(parent.composedVariance, localVariance);
    }

    const frame: VarianceFrame = {
      level,
      position,
      localVariance,
      composedVariance,
      declarationSyntax,
      isActualCallSiteArgument
    };

    return [...stack, frame];
  }

  /**
   * R4 Blocker 3: Normative Call-Site Argument Rule:
   * At an actual call site (USAGE_ROLE: CALL_SITE), the check between
   * historical argument and candidate parameter is strictly directional:
   *   historicalArgType ASSIGNABLE_TO candidateParamType
   * Reversing this check is prohibited regardless of whether the method was declared
   * with method syntax.
   */
  public static isReverseCheckAllowed(stack: ReadonlyArray<VarianceFrame>): boolean {
    // If any frame on the stack is an actual call-site argument, reverse check is NEVER allowed
    for (const frame of stack) {
      if (frame.isActualCallSiteArgument) {
        return false;
      }
    }
    return false;
  }
}
