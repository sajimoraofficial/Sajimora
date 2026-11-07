import { GenericRepository, VerificationObligation, VerificationVerdict } from '../../../../../../core/src/sajimora/verification';
import { TypeScriptCandidateContext } from './TypeScriptCandidateContext';
export interface JsxAttributeEntry {
  name?: string;
  type?: string;
  isSpread?: boolean;
  spreadType?: string;
  spreadProperties?: Record<string, { type: string; isOptional: boolean }>;
}

export interface JsxContextDetails {
  componentName?: string;
  attributes?: readonly JsxAttributeEntry[];
  childrenType?: string;
  childrenCount?: number;
  hasKeyAttribute?: boolean;
  hasRefAttribute?: boolean;
  isPolymorphicAs?: boolean;
  isDynamicSpread?: boolean;
  isHocWrapped?: boolean;
  isBarrelImport?: boolean;
  candidateProps?: Record<string, { type: string; isRequired: boolean }>;
  expectedChildrenType?: string;
  expectedChildrenCount?: number;
}


/** Real source-bound compiler evaluation; metadata cannot authorize a verdict. */
export class TypeScriptJsxSpecializer {
 public static evaluateJsxSpecialization(obligation: VerificationObligation, repository: GenericRepository): VerificationVerdict {
   return TypeScriptCandidateContext.evaluate(obligation, repository);
 }
}
