import { GenericRepository, VerificationObligation, VerificationVerdict } from '../../../../../../core/src/sajimora/verification';
import { TypeScriptCandidateContext } from './TypeScriptCandidateContext';
export interface PropertyAccessContextDetails {
  accessMode?: 'READ' | 'WRITE' | 'READ_WRITE';
  propertyName: string;
  assignedValueType?: string;
  expectedReadType?: string;
  receiverType?: string;
  candidatePropertyType?: string;
  isReadonly?: boolean;
  hasSetter?: boolean;
  isDestructuring?: boolean;
  isDynamicDestructuring?: boolean;
  destructuredAlias?: string;
}

export interface HeritageContextDetails {
  clauseKind: 'extends' | 'implements';
  declaringName: string;
  implementedMembers: readonly string[];
  addedRequiredMembers?: readonly string[];
  classPrivateOriginId?: string;
  targetPrivateOriginId?: string;
  nominalPrivateMembers?: readonly string[];
  memberVisibilities?: Readonly<Record<string, 'public' | 'protected' | 'private'>>;
  baseMemberVisibilities?: Readonly<Record<string, 'public' | 'protected' | 'private'>>;
}

export interface CallbackContextDetails {
  paramTypes?: readonly string[];
  returnType?: string;
  expectedParamTypes?: readonly string[];
  expectedReturnType?: string;
}


/** Real source-bound compiler evaluation; metadata cannot authorize a verdict. */
export class TypeScriptContextualSpecializer {
 public static evaluateContextualSpecialization(obligation: VerificationObligation, repository: GenericRepository): VerificationVerdict {
   return TypeScriptCandidateContext.evaluate(obligation, repository);
 }
}
