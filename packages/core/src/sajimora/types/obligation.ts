import { SymbolRef, SymbolKind } from './symbol';
import { ProviderMutationCharacterization } from './mutation';
import type { ContractSignature } from '../compatibility/CompatibilityEvaluator';

export type SemanticScopeReason =
  | 'JAVA_ALL_EXPLICIT'
  | 'TS_VALUE_LEVEL_NO_IMPLICIT'
  | 'TS_INTERFACE_STRUCTURAL_POSSIBLE'
  | 'TS_TYPE_ALIAS_STRUCTURAL_POSSIBLE'
  | 'TS_CLASS_VALUE_LEVEL';

export interface ObligationSemanticScope {
  unsupportedRelationshipPossible: boolean;
  reason: SemanticScopeReason;
}

export interface ProofObligation {
  invariantId: string;
  relation: 'STRUCTURAL_BOUNDARY' | 'INTERFACE_PRESERVATION' | 'STRUCTURAL_CO_EVOLUTION';
  mutatedSymbol: SymbolRef | null;
  /** Required provenance that the provider change was derived from two parsed revisions. */
  providerMutation?: ProviderMutationCharacterization;
  /** Contracts extracted from the parent and candidate declarations. */
  providerContracts?: { before: ContractSignature; after: ContractSignature };
}
