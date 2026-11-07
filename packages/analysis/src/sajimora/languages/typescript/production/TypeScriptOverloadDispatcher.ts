import { GenericRepository, VerificationObligation, VerificationVerdict } from '../../../../../../core/src/sajimora/verification';
import { TypeScriptCandidateContext } from './TypeScriptCandidateContext';
export interface OverloadSignatureDesc {
  paramTypes: readonly string[];
  requiredParamsCount: number;
  hasRest?: boolean;
  restType?: string;
  returnType: string;
  typeParameters?: ReadonlyArray<{ name: string; constraint?: string; default?: string }>;
  isImplementation?: boolean;
}

export interface OverloadContextDetails {
  parentOverloads?: readonly OverloadSignatureDesc[];
  candidateOverloads?: readonly OverloadSignatureDesc[];
  selectedParentOverloadIndex?: number;
  isAmbiguousCorrespondence?: boolean;
  isImplementationOnlyChange?: boolean;
}


/** Real source-bound compiler evaluation; metadata cannot authorize a verdict. */
export class TypeScriptOverloadDispatcher {
 public static evaluateOverloadDispatch(obligation: VerificationObligation, repository: GenericRepository): VerificationVerdict {
   return TypeScriptCandidateContext.evaluate(obligation, repository);
 }
}
