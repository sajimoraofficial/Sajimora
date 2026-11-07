import { ProofObligation } from '../types/obligation';
import { CanonicalReferenceOccurrence, ReferenceExpressionContext } from '../types/usage';
import { CompatibilityResult } from '../types/compatibility';

export interface ContractParameter {
  name: string;
  type: string;
  isRequired: boolean;
}

export interface ContractSignature {
  parameters?: ContractParameter[];
  returnType?: string;
  // Extensible for future semantic checks
}

export interface CompatibilityEvaluator {
  evaluate(
    obligation: ProofObligation,
    usageRole: CanonicalReferenceOccurrence['usageRole'],
    expressionContext: ReferenceExpressionContext | null,
    oldContract: ContractSignature,
    newContract: ContractSignature,
    consumerEvidence: any // Consumer's AST / type resolution context
  ): CompatibilityResult;
}
