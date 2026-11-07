import {
  ProofObligation,
  UsageSite,
  SpecializedUsageContract,
  LanguageContractIR,
  Phase4BlockerId
} from '@sajimora/core';
import { TypeScriptTypeIR } from '../languages/typescript/ir/TypeScriptTypeIR';

export interface ProviderDeclarationLocation {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
}

export interface ProviderCandidateContract {
  readonly targetSymbolId: string;
  readonly targetName: string;
  readonly declarationLocation?: ProviderDeclarationLocation;
  readonly contractIR?: LanguageContractIR<TypeScriptTypeIR>;
  readonly isDeleted?: boolean;
  readonly blockerId?: Phase4BlockerId;
  readonly errorDetail?: string;
}

export interface ProviderHistoricalObligation {
  readonly usageSiteId: string;
  readonly occurrenceId: string;
  readonly specializedContract?: SpecializedUsageContract<TypeScriptTypeIR>;
  readonly selectedSignatureIndex?: number;
  readonly blockerId?: Phase4BlockerId;
  readonly errorDetail?: string;
}

export interface ProviderTypeNode {
  readonly typeId: string;
  readonly typeIR: TypeScriptTypeIR;
}

/**
 * Pure, compiler-agnostic synchronous semantic provider interface for Phase 4.
 * THIS FILE AND ITS RESULT DTOS MUST CONTAIN ZERO IMPORTS FROM 'typescript' AND ZERO ts.* TYPES.
 */
export interface Phase4SemanticProvider {
  /**
   * Retrieves the candidate declaration contract for a target symbol.
   */
  getCandidateContract(
    targetSymbolId: string,
    targetName: string,
    targetLocation?: string
  ): ProviderCandidateContract;

  /**
   * Specializes historical usage for a consumer usage site.
   */
  getHistoricalObligation(site: UsageSite): ProviderHistoricalObligation;

  /**
   * Optional type node lookup by type identifier.
   */
  getTypeNode?(typeId: string): ProviderTypeNode | undefined;
}
