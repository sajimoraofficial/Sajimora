import { UsageSite, Phase4BlockerId } from '@sajimora/core';
import {
  Phase4SemanticProvider,
  ProviderCandidateContract,
  ProviderHistoricalObligation
} from '../compatibility/Phase4SemanticProvider';
import { SemanticIndexDatabase } from './SemanticIndexDatabase';

export interface PersistentSemanticProviderContext {
  readonly db: SemanticIndexDatabase;
  readonly repoName: string;
  readonly parentSha: string;
  readonly candidateSha: string;
  readonly projectKey?: string;
}

/**
 * Phase 3 Persistent Semantic Provider.
 * Implements Phase4SemanticProvider backed strictly by SQLite SemanticIndexDatabase.
 * Emits ONLY Phase 2 serializable DTOs with zero compiler runtime calls.
 */
export class PersistentSemanticProvider implements Phase4SemanticProvider {
  private readonly db: SemanticIndexDatabase;
  private readonly repoName: string;
  private readonly parentSha: string;
  private readonly candidateSha: string;
  private readonly projectKey: string;

  constructor(context: PersistentSemanticProviderContext) {
    this.db = context.db;
    this.repoName = context.repoName;
    this.parentSha = context.parentSha;
    this.candidateSha = context.candidateSha;
    this.projectKey = context.projectKey ?? 'root';
  }

  public getCandidateContract(
    targetSymbolId: string,
    targetName: string,
    targetLocation?: string
  ): ProviderCandidateContract {
    const contract = this.db.getCandidateContract(
      this.repoName,
      this.candidateSha,
      this.projectKey,
      targetSymbolId
    );

    if (!contract) {
      return {
        targetSymbolId,
        targetName,
        blockerId: 'CANDIDATE_DECLARATION_MISSING',
        errorDetail: `Candidate contract for '${targetSymbolId}' not found in persistent semantic index`
      };
    }

    return contract;
  }

  public getHistoricalObligation(site: UsageSite): ProviderHistoricalObligation {
    const obligation = this.db.getHistoricalObligation(site.usageSiteId);

    if (!obligation) {
      return {
        usageSiteId: site.usageSiteId,
        occurrenceId: site.canonicalOccurrence.occurrenceId,
        blockerId: 'HISTORICAL_EXPECTATION_UNRECOVERABLE',
        errorDetail: `Historical usage obligation for site '${site.usageSiteId}' not found in persistent semantic index`
      };
    }

    return obligation;
  }
}
