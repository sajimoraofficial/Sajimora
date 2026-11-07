import {
  CompleteProofEvidence,
  UsageSite,
  CompatibilityResult,
  validateProofTree,
  TypeRelationResult,
  IncompatibilityWitness,
  RelationBlocker,
  ClosureResult
} from '@sajimora/core';
import { ProofTreeBuilder } from './ProofTreeBuilder';

export interface Phase4CompatibilityBundle {
  readonly schemaVersion: 'SAJIMORA_COMPATIBILITY_EVIDENCE_V1';
  readonly engineVersion: string;
  readonly consumerResults: Map<string, CompatibilityResult>;
  readonly proofTrees: Map<string, TypeRelationResult>;
  readonly witnesses: ReadonlyArray<IncompatibilityWitness>;
  readonly blockerSummary: ReadonlyArray<RelationBlocker>;
  readonly typeIRStats: {
    readonly totalNodesExtracted: number;
    readonly unsupportedNodes: number;
    readonly cycleBackreferencesUsed: number;
    readonly maxDepthReached: number;
  };
  readonly proofStats: {
    readonly compatibleCount: number;
    readonly incompatibleCount: number;
    readonly undecidableCount: number;
    readonly anyDependencyUndecidableCount: number;
  };
  readonly phase4Outcome: {
    readonly allConsumersEvaluated: boolean;
    readonly coverageGaps: ReadonlyArray<string>;
  };
}

export interface ReconcileOptions {
  readonly isPhase4Mode?: boolean;
  readonly discoveredHistoricalConsumerIds?: ReadonlyArray<string>;
  readonly candidateAddedConsumerIds?: ReadonlyArray<string>;
  readonly ambiguousLifecycleConsumerIds?: ReadonlyArray<string>;
  readonly uncertainExcludedSiteIds?: ReadonlyArray<string>;
  readonly mappedHistoricalConsumerIds?: ReadonlyMap<string, string> | Record<string, string>;
}

export class AuthorityIntegrationLayer {
  public static reconcileAndIntegrate(
    evidence: CompleteProofEvidence<any>,
    options?: ReconcileOptions
  ): CompleteProofEvidence<any> {
    const isPhase4 = options?.isPhase4Mode ?? false;
    const compatibilityResults = new Map<string, CompatibilityResult>(evidence.compatibilityResults);
    let canonicalOccurrences = [...evidence.canonicalOccurrences];
    let unsupportedRelationshipPossible = evidence.semanticScope.unsupportedRelationshipPossible;

    // 1. Filter out candidate-added consumers (§5.1)
    const addedIds = new Set(options?.candidateAddedConsumerIds ?? []);
    if (addedIds.size > 0) {
      canonicalOccurrences = canonicalOccurrences.filter(
        site => !addedIds.has(site.usageSiteId)
      );
    }

    // 2. Retain ambiguous-across-versions consumers (§5.2)
    const ambiguousIds = new Set(options?.ambiguousLifecycleConsumerIds ?? []);
    if (ambiguousIds.size > 0) {
      canonicalOccurrences = canonicalOccurrences.map(site => {
        if (ambiguousIds.has(site.usageSiteId)) {
          compatibilityResults.set(site.usageSiteId, {
            status: 'UNDECIDABLE',
            reason: 'IDENTITY_UNCERTAIN'
          });
          return {
            ...site,
            evaluationStatus: 'EVALUABLE' as const,
            identityResult: 'IDENTITY_UNCERTAIN' as const
          };
        }
        return site;
      });
    }

    // 3. Excluded-Site Identity Verification (§5.4, §10.3.3)
    const uncertainExcluded = new Set(options?.uncertainExcludedSiteIds ?? []);
    canonicalOccurrences = canonicalOccurrences.map(site => {
      const isExcluded =
        site.evaluationStatus === 'EXCLUDED_RE_EXPORTER' ||
        site.evaluationStatus === 'EXCLUDED_REMOVED_VIA_BINDING';

      if (isExcluded && (uncertainExcluded.has(site.usageSiteId) || site.identityResult === 'IDENTITY_UNCERTAIN')) {
        compatibilityResults.set(site.usageSiteId, {
          status: 'UNDECIDABLE',
          reason: 'EXCLUDED_SITE_IDENTITY_UNVERIFIED'
        });
        return {
          ...site,
          evaluationStatus: 'EVALUABLE' as const,
          identityResult: 'IDENTITY_UNCERTAIN' as const
        };
      }
      return site;
    });

    // 4. Omitted Historical Consumer Protection (§5.3, §10.3.2)
    const existingSiteIds = new Set(canonicalOccurrences.map(s => s.usageSiteId));
    const mappedHistMap = options?.mappedHistoricalConsumerIds instanceof Map
      ? options.mappedHistoricalConsumerIds
      : new Map(Object.entries(options?.mappedHistoricalConsumerIds ?? {}));

    const isConsumerIdMatch = (a: string, b: string): boolean => {
      if (a === b) return true;
      const partsA = a.split(':');
      const partsB = b.split(':');
      if (partsA.length >= 4 && partsB.length >= 4) {
        if (partsA.slice(-3).join(':') !== partsB.slice(-3).join(':')) return false;
        const modA = partsA.slice(0, -3).join(':').replace(/\\/g, '/');
        const modB = partsB.slice(0, -3).join(':').replace(/\\/g, '/');
        return modA === modB || modA.endsWith('/' + modB) || modB.endsWith('/' + modA);
      }
      return false;
    };

    for (const histId of options?.discoveredHistoricalConsumerIds ?? []) {
      const mappedCandId = mappedHistMap.get(histId);
      const isHistoricalPresent = existingSiteIds.has(histId) || Array.from(existingSiteIds).some(sid => isConsumerIdMatch(sid, histId));
      const isCandidatePresent = mappedCandId ? (existingSiteIds.has(mappedCandId) || Array.from(existingSiteIds).some(sid => isConsumerIdMatch(sid, mappedCandId))) : false;
      if (isHistoricalPresent || isCandidatePresent) {
        continue;
      }
      // Inject synthetic UsageSite for omitted historical consumer
      canonicalOccurrences.push({
        usageSiteId: histId,
        canonicalOccurrence: {
          occurrenceId: histId,
          referencedSymbol: evidence.obligation.mutatedSymbol?.symbolId ?? evidence.obligation.mutatedSymbol?.persistentSymbolId ?? '<unknown>',
          declarationSymbol: evidence.obligation.mutatedSymbol?.symbolId ?? evidence.obligation.mutatedSymbol?.persistentSymbolId ?? '<unknown>',
          sourceFile: '<omitted-historical>',
          sourceSpan: { start: 0, end: 0, line: 1, column: 1 },
          syntaxKind: 0,
          semanticRole: 'VALUE',
          usageRole: 'CALL_SITE',
          resolutionStatus: 'UNDECIDABLE',
          provenanceTrace: []
        } as any,
        existenceAtParent: 'PRESENT',
        mutationStatus: 'UNCHANGED',
        bindingPresenceAtCandidate: 'ABSENT',
        bindingState: 'WAS_BOUND_NOW_ABSENT',
        evaluationStatus: 'EVALUABLE',
        identityResult: 'IDENTITY_UNCERTAIN',
        enumerationInconsistencyCause: null,
        provenance: 'UNCHANGED'
      });
      compatibilityResults.set(histId, {
        status: 'UNDECIDABLE',
        reason: 'OMITTED_HISTORICAL_CONSUMER'
      });
      unsupportedRelationshipPossible = true;
    }

    // 5. Mandatory Proof Tree Validation (§9.2, §10.4)
    for (const [siteId, res] of compatibilityResults.entries()) {
      if (res.status === 'COMPATIBLE') {
        if (isPhase4) {
          if (!res.phase4Evidence || !res.phase4Evidence.proofTree) {
            // Demote to UNDECIDABLE
            compatibilityResults.set(siteId, {
              status: 'UNDECIDABLE',
              reason: 'INVALID_PROOF_TREE'
            });
            continue;
          }

          // Finding 13: Strict status/evidence consistency
          if (res.phase4Evidence.proofTree.status !== 'COMPATIBLE') {
            compatibilityResults.set(siteId, {
              status: 'UNDECIDABLE',
              reason: 'CONTRADICTORY_PROOF_STATUS'
            });
            continue;
          }

          const validation = validateProofTree(res.phase4Evidence.proofTree);
          if (!validation.isValid) {
            compatibilityResults.set(siteId, {
              status: 'UNDECIDABLE',
              reason: 'INVALID_PROOF_TREE'
            });
          }
        }
      } else if (res.status === 'INCOMPATIBLE') {
        if (isPhase4) {
          if (!res.phase4Evidence || !res.phase4Evidence.proofTree) {
            compatibilityResults.set(siteId, {
              status: 'UNDECIDABLE',
              reason: 'MISSING_INCOMPATIBILITY_WITNESS'
            });
            continue;
          }

          if (res.phase4Evidence.proofTree.status !== 'INCOMPATIBLE') {
            compatibilityResults.set(siteId, {
              status: 'UNDECIDABLE',
              reason: 'CONTRADICTORY_PROOF_STATUS'
            });
            continue;
          }

          if (!res.phase4Evidence.proofTree.witness) {
            compatibilityResults.set(siteId, {
              status: 'UNDECIDABLE',
              reason: 'MISSING_INCOMPATIBILITY_WITNESS'
            });
            continue;
          }

          const validation = validateProofTree(res.phase4Evidence.proofTree);
          if (!validation.isValid) {
            compatibilityResults.set(siteId, {
              status: 'UNDECIDABLE',
              reason: 'INVALID_PROOF_TREE'
            });
          }
        }
      }
    }

    // 6. Evaluable Coverage Verification (§10.3.5)
    for (const site of canonicalOccurrences) {
      if (site.evaluationStatus === 'EVALUABLE') {
        if (!compatibilityResults.has(site.usageSiteId)) {
          compatibilityResults.set(site.usageSiteId, {
            status: 'UNDECIDABLE',
            reason: 'PHASE4_COVERAGE_GAP'
          });
        }
      }
    }

    // 7. A scope certificate must cover the entire historical closure, not
    // merely the evaluable subset. It is diagnostic evidence as well as the
    // sole reason Phase 4 may clear structural-scope uncertainty.
    let semanticScopeReason = evidence.semanticScope.reason;
    const scopeBlockers: string[] = [];
    const closuresComplete = Object.values(evidence.closures).every(closure => {
      if (!closure) return false;
      if ('completeness' in closure && closure.completeness !== undefined) {
        return closure.completeness === 'COMPLETE' &&
          (closure.failures?.length ?? 0) === 0 && (closure.ambiguities?.length ?? 0) === 0 &&
          !(closure.unrecognizedForms ?? []).some((form: any) => form.isTargetRelevant);
      }
      const result = closure as ClosureResult<any>;
      return result.status === 'DISCOVERY_COMPLETE_WITHIN_ANALYSIS_UNIVERSE' &&
        (result.unresolved?.length ?? 0) === 0 && (result.unsupported?.length ?? 0) === 0 &&
        (result.unscannedFiles?.length ?? 0) === 0;
    });
    const historicalCovered = (options?.discoveredHistoricalConsumerIds ?? []).every(histId => {
      const mappedCandId = mappedHistMap.get(histId);
      return existingSiteIds.has(histId) || Array.from(existingSiteIds).some(sid => isConsumerIdMatch(sid, histId)) ||
        Boolean(mappedCandId && (existingSiteIds.has(mappedCandId) || Array.from(existingSiteIds).some(sid => isConsumerIdMatch(sid, mappedCandId))));
    });
    if (!historicalCovered) scopeBlockers.push('HISTORICAL_OCCURRENCE_OMITTED');
    const relevantSites = canonicalOccurrences.filter(site =>
      site.evaluationStatus !== 'EXCLUDED_RE_EXPORTER' && site.evaluationStatus !== 'EXCLUDED_REMOVED_VIA_BINDING');
    if (relevantSites.some(site => site.evaluationStatus !== 'EVALUABLE' || site.identityResult === 'IDENTITY_UNCERTAIN')) {
      scopeBlockers.push('IDENTITY_UNPROVEN');
    }
    const allTreesValid = relevantSites.every(site => {
      const result = compatibilityResults.get(site.usageSiteId);
      if (!result || result.status === 'UNDECIDABLE' || !result.phase4Evidence?.proofTree) return false;
      if (result.phase4Evidence.proofTree.status !== result.status) return false;
      if (result.status === 'INCOMPATIBLE' && !result.phase4Evidence.proofTree.witness) return false;
      return validateProofTree(result.phase4Evidence.proofTree).isValid;
    });
    if (relevantSites.length > 0 && !allTreesValid) scopeBlockers.push('RELATION_PROOF_MISSING');
    const scopeCertificate = {
      status: scopeBlockers.length === 0 ? 'PROVEN' as const : 'UNPROVEN' as const,
      historicalConsumerIds: [...(options?.discoveredHistoricalConsumerIds ?? [])],
      canonicalSiteIds: canonicalOccurrences.map(site => site.usageSiteId),
      blockers: scopeBlockers
    };
    if (isPhase4) {
      if (scopeCertificate.status === 'PROVEN') {
        unsupportedRelationshipPossible = false;
        semanticScopeReason = 'TS_VALUE_LEVEL_NO_IMPLICIT';
      }
    }

    return Object.assign({
      ...evidence,
      canonicalOccurrences,
      compatibilityResults,
      semanticScope: {
        ...evidence.semanticScope,
        unsupportedRelationshipPossible,
        reason: semanticScopeReason
      }
    }, { scopeCertificate });
  }
}
