import {
  ProofObligation,
  ProofResult,
  VerdictAuthority,
  SemanticScopeCalculator,
  CompleteProofEvidence,
  UsageSite,
  CompatibilityResult,
  isProviderMutationValidlyCharacterized,
  ClosureEvidence,
  ClosureName
} from '@sajimora/core';
import { SemanticIndexDatabase, CompletenessMetadata } from '../storage/SemanticIndexDatabase';
import { PersistentSemanticProvider } from '../storage/PersistentSemanticProvider';
import { TypeScriptCompatibility } from '../compatibility/TypeScriptCompatibility';
import { AuthorityIntegrationLayer, ReconcileOptions } from '../compatibility/AuthorityIntegrationLayer';

export interface WarmQueryOptions {
  readonly repoName: string;
  readonly parentSha: string;
  readonly candidateSha: string;
  readonly projectKey?: string;
  readonly subject?: string;
  readonly db: SemanticIndexDatabase;
}

export interface WarmEvaluationRecord {
  readonly targetSymbol: string;
  readonly targetKind: string;
  readonly targetFile: string;
  readonly classification: string;
  readonly verdict: 'PRESERVED' | 'VIOLATED' | 'UNKNOWN' | 'NOT_APPLICABLE' | 'INSUFFICIENT_EVIDENCE' | string;
  readonly authorityGate?: string;
  readonly authorityReason?: string;
  readonly authoritySource?: string;
  readonly hasSemanticCompatibility?: boolean;
  readonly evaluatedConsumerCount?: number;
  readonly compatibilityStatuses?: Record<string, number>;
  readonly witnesses?: string[];
  readonly isUnsafePositive: boolean;
  readonly durationMs: number;
  readonly peakRssBytes: number;
}

export interface WarmQueryResult {
  readonly repository: string;
  readonly parentSha: string;
  readonly candidateSha: string;
  readonly subject: string;
  readonly analyzable: boolean;
  readonly nonAnalyzableReason?: string;
  readonly mutationsCount: number;
  readonly evaluations: WarmEvaluationRecord[];
}

/**
 * Phase 5 Warm Indexed Query Path Orchestrator.
 * 
 * Invariants strictly enforced:
 * - ZERO Git operations
 * - ZERO repository snapshot materialization
 * - ZERO ts.Program creation
 * - ZERO TypeChecker creation
 * - ZERO AST traversal
 * - ZERO TypeScript compiler imports in this query execution path
 * - ZERO full-repository scans
 * - Uses PersistentSemanticProvider + Phase 4 pure evaluator only
 * - Fails closed on missing or incomplete artifacts
 */
export class WarmIndexedQueryEngine {
  public static readonly REQUIRED_CLOSURES: readonly ClosureName[] = [
    'ValueReferenceClosure',
    'TypeReferenceClosure',
    'InheritanceClosure',
    'InterfaceImplClosure',
    'OverrideClosure',
    'ReExportClosure',
    'AmbientReferenceClosure'
  ];

  public static evaluateCommitPair(options: WarmQueryOptions): WarmQueryResult {
    const { repoName, parentSha, candidateSha, db } = options;
    const projectKey = options.projectKey ?? 'root';
    const subject = options.subject ?? 'Warm indexed evaluation';

    if (!repoName || !parentSha || !candidateSha || !db) {
      throw new Error('WARM_QUERY_ARGUMENT_ERROR: Missing required options (repoName, parentSha, candidateSha, db)');
    }

    // 1. Authoritative Completeness Gate across all 7 closures
    for (const closureKind of WarmIndexedQueryEngine.REQUIRED_CLOSURES) {
      const cert = db.getCompletenessCertificate(repoName, parentSha, projectKey, closureKind);
      if (!cert) {
        throw new Error(
          `COMPLETENESS_CERTIFICATE_MISSING: Authoritative certificate for ${closureKind} not found on commit ${parentSha}. Missing records cannot be interpreted as proof of absence.`
        );
      }
    }

    // 2. Retrieve proof obligations from persistent store
    const obligations = db.getObligations(repoName, parentSha, candidateSha);
    obligations.sort(SemanticIndexDatabase.compareObligations);
    if (obligations.length === 0) {
      return {
        repository: repoName,
        parentSha,
        candidateSha,
        subject,
        analyzable: false,
        nonAnalyzableReason: 'No proof obligations found in persistent semantic index',
        mutationsCount: 0,
        evaluations: []
      };
    }

    // 3. Construct persistent semantic provider
    const provider = new PersistentSemanticProvider({
      db,
      repoName,
      parentSha,
      candidateSha,
      projectKey
    });

    const evaluations: WarmEvaluationRecord[] = [];

    // 4. Evaluate each obligation compiler-free from indexed artifacts
    for (const obligation of obligations) {
      const startTime = Date.now();

      const targetSymbol = obligation.mutatedSymbol;
      const targetId = targetSymbol?.persistentSymbolId ?? targetSymbol?.symbolId;

      // Gate 1: Applicability Gate
      if (obligation.relation !== 'STRUCTURAL_CO_EVOLUTION' && obligation.relation !== 'INTERFACE_PRESERVATION') {
        const preflight = VerdictAuthority.evaluatePreflight('NOT_APPLICABLE', 'APPLICABILITY', 'STRUCTURAL_TRIGGER_NO_CONSUMERS', 'NO_STRUCTURAL_TRIGGER');
        evaluations.push(this.buildEvaluationRecord(obligation, preflight, 'unknown', Date.now() - startTime));
        continue;
      }

      if (!targetSymbol) {
        const preflight = VerdictAuthority.evaluatePreflight('NOT_APPLICABLE', 'APPLICABILITY', 'STRUCTURAL_TRIGGER_NO_CONSUMERS', 'NO_STRUCTURAL_TRIGGER');
        evaluations.push(this.buildEvaluationRecord(obligation, preflight, 'unknown', Date.now() - startTime));
        continue;
      }

      if (!obligation.providerMutation || !isProviderMutationValidlyCharacterized(obligation.providerMutation)) {
        const preflight = VerdictAuthority.evaluatePreflight('UNKNOWN', 'OBLIGATION_VALIDITY', 'UNKNOWN_FALLTHROUGH');
        evaluations.push(this.buildEvaluationRecord(obligation, preflight, 'unknown', Date.now() - startTime));
        continue;
      }

      // Gate 2: Completeness Metadata Retrieval
      const meta = targetId ? db.getCompletenessMetadata(repoName, parentSha, projectKey, targetId) : undefined;
      if (!meta || meta.isPoisoned || !meta.discovery || !meta.sites) {
        const preflight = VerdictAuthority.evaluatePreflight('UNKNOWN', 'COVERAGE', 'DISCOVERY_FAILURE');
        evaluations.push(this.buildEvaluationRecord(obligation, preflight, meta?.targetFile ?? 'unknown', Date.now() - startTime));
        continue;
      }

      const targetFile = meta.targetFile ?? 'unknown';

      // Gate 3: Evaluate compatibility of each site using PersistentSemanticProvider
      const compatibilityResults = new Map<string, CompatibilityResult>();
      const defaultCompatibility = new TypeScriptCompatibility(undefined, obligation, {
        isPhase4Mode: true,
        provider
      });

      for (const site of meta.sites) {
        if (site.evaluationStatus === 'EVALUABLE') {
          const result = defaultCompatibility.evaluateSite(site);
          compatibilityResults.set(
            site.usageSiteId,
            result ?? { status: 'UNDECIDABLE', reason: null }
          );
        }
      }

      // Gate 4: Build CompleteProofEvidence
      const semanticScope = SemanticScopeCalculator.calculate(obligation, 'typescript', targetSymbol.kind);
      const identityResults = meta.sites.map(site => ({
        usageSiteId: site.usageSiteId,
        referencedSymbol: site.canonicalOccurrence.referencedSymbol,
        declarationSymbol: site.canonicalOccurrence.declarationSymbol,
        resolutionStatus: site.canonicalOccurrence.resolutionStatus,
        identityResult: site.identityResult,
        evaluationStatus: site.evaluationStatus
      }));

      const findClosure = (name: ClosureName): ClosureEvidence => {
        const found = meta.discovery.closures.find((c: ClosureEvidence) => c.closureName === name);
        if (found) return found;
        const cert = db.getCompletenessCertificate(repoName, parentSha, projectKey, name);
        return {
          closureName: name,
          occurrences: [],
          completeness: cert?.isComplete ? 'COMPLETE' : 'INCOMPLETE',
          failures: cert && !cert.isComplete ? [{ file: 'unknown', cause: 'Closure marked incomplete in certificate' }] : [],
          ambiguities: [],
          unrecognizedForms: [],
          provenance: []
        };
      };

      const completeEvidence: CompleteProofEvidence<any> = {
        triggerData: null,
        obligation,
        analysisUniverse: {
          rootPath: '',
          discoveredFiles: [],
          discoveredFileSet: new Set<string>(),
          excludedFiles: new Map<string, string>(),
          unsupportedFiles: [],
          unreadableFiles: [],
          parseFailures: new Map<string, string>(),
          discoveryStatus: 'DISCOVERY_COMPLETE',
          discoveryEvidence: 'Persisted universe'
        },
        closures: {
          valueReference: findClosure('ValueReferenceClosure'),
          typeReference: findClosure('TypeReferenceClosure'),
          inheritance: findClosure('InheritanceClosure'),
          interfaceImpl: findClosure('InterfaceImplClosure'),
          override: findClosure('OverrideClosure'),
          reExport: findClosure('ReExportClosure'),
          ambientReference: findClosure('AmbientReferenceClosure')
        },
        canonicalOccurrences: meta.sites,
        identityResults,
        compatibilityResults,
        semanticScope
      };

      // Gate 5: Reconcile coverage & validate proof trees
      const pairLifecycle = targetId
        ? db.getPairLifecycle(repoName, parentSha, candidateSha, projectKey, targetId)
        : undefined;
      const lifecycle = pairLifecycle ?? meta.lifecycleEvidence;

      const mappedHistMap = new Map<string, string>();
      if (lifecycle?.mappedHistoricalConsumerIds) {
        for (const [k, v] of lifecycle.mappedHistoricalConsumerIds) {
          mappedHistMap.set(k, v);
        }
      }

      const reconcileOpts: ReconcileOptions = {
        isPhase4Mode: true,
        discoveredHistoricalConsumerIds: lifecycle?.discoveredHistoricalConsumerIds ?? [],
        candidateAddedConsumerIds: lifecycle?.candidateAddedConsumerIds ?? [],
        ambiguousLifecycleConsumerIds: lifecycle?.ambiguousLifecycleConsumerIds ?? [],
        mappedHistoricalConsumerIds: mappedHistMap
      };

      const reconciledEvidence = AuthorityIntegrationLayer.reconcileAndIntegrate(
        completeEvidence,
        reconcileOpts
      );

      // Gate 6: Authoritative Verdict Evaluation
      const proof = VerdictAuthority.evaluateProof(reconciledEvidence);

      evaluations.push(this.buildEvaluationRecord(obligation, proof, targetFile, Date.now() - startTime));
    }

    return {
      repository: repoName,
      parentSha,
      candidateSha,
      subject,
      analyzable: true,
      mutationsCount: obligations.length,
      evaluations
    };
  }

  private static buildEvaluationRecord(
    obligation: ProofObligation,
    result: ProofResult,
    targetFile: string,
    durationMs: number
  ): WarmEvaluationRecord {
    const verdict = result.verdict;
    const authorityGate = result.auditTrace?.authorityDecision?.gate;
    const authorityReason = result.auditTrace?.authorityDecision?.reason;
    const authoritySource = result.auditTrace?.authorityDecision?.source;

    const compEntries: any[] = result.auditTrace?.compatibility ?? [];
    const hasSemanticCompatibility = compEntries.length > 0;
    const evaluatedConsumerCount = result.auditTrace?.consumers?.length ?? 0;
    const compatibilityStatuses: Record<string, number> = {};
    const witnesses: string[] = [];

    for (const c of compEntries) {
      const status = c.result?.status ?? 'UNKNOWN';
      compatibilityStatuses[status] = (compatibilityStatuses[status] || 0) + 1;
      if (c.result?.witness) {
        witnesses.push(JSON.stringify(c.result.witness));
      } else if (c.result?.phase4Evidence?.witness) {
        witnesses.push(JSON.stringify(c.result.phase4Evidence.witness));
      }
    }

    let isUnsafePositive = false;
    if (verdict === 'PRESERVED') {
      if (obligation.providerMutation?.classification === 'SYMBOL_DELETED' && (result.auditTrace?.consumers?.length ?? 0) > 0) {
        isUnsafePositive = true;
      }
    }

    return {
      targetSymbol: obligation.mutatedSymbol?.qualifiedName ?? 'unknown',
      targetKind: obligation.mutatedSymbol?.kind ?? 'unknown',
      targetFile,
      classification: obligation.providerMutation?.classification ?? 'unknown',
      verdict,
      authorityGate,
      authorityReason,
      authoritySource,
      hasSemanticCompatibility,
      evaluatedConsumerCount,
      compatibilityStatuses,
      witnesses,
      isUnsafePositive,
      durationMs,
      peakRssBytes: process.memoryUsage().rss
    };
  }
}
