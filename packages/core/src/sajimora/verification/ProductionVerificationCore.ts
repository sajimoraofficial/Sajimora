/**
 * @file ProductionVerificationCore.ts
 * Repository-agnostic and language-agnostic production verification core orchestrator.
 * 
 * Enforces:
 * 1. Zero repository, framework, or language hardcoding.
 * 2. Multi-project graph topology and asymmetric parent/candidate mapping.
 * 3. Stable provenance chains: Repository -> Project -> Resolution -> Identity -> Reference -> Obligation -> Evidence -> Verdict.
 * 4. Analyzers produce evidence only; VerdictAuthority remains the sole authoritative certifier.
 * 5. ConservationGate enforces zero silent drops at every stage.
 * 6. Insufficient evidence is never promoted to PRESERVED.
 */

import {
  GenericRepository,
  VerificationObligation,
  VerificationVerdict,
  CertificationLedger,
  CertificationStatus
} from './contracts';
import { GenericLanguageAdapter } from './GenericLanguageAdapter';
import { ConservationGate } from './ConservationGate';
import { VerdictAuthorityBridge } from './VerdictAuthorityBridge';
import { ProofResult } from '../types/verdict';
import { PRODUCTION_LIMITS, validateProjectGraphBudget, validateRepositoryBudget } from './ExecutionLimits';
import { EvidenceAcceptanceSession, EvidenceChecker } from './AcceptedEvidence';
import { DiscoveryCoverageChecker, DiscoveryCoverageSession } from './DiscoveryCoverage';

export interface VerificationExecutionResult {
  ledger: CertificationLedger;
  authoritativeVerdict: ProofResult;
  resources?: { durationMs: number; sampledPeakProcessRssBytes: number; workerHeapUsedBytes: number };
}

export class ProductionVerificationCore {
  private readonly adapters: GenericLanguageAdapter[] = [];
  public constructor(private readonly evidenceCheckers: readonly EvidenceChecker[] = [],
    private readonly discoveryCoverageChecker?: DiscoveryCoverageChecker,
    private readonly progress?: (phase: string) => void) {}

  public registerAdapter(adapter: GenericLanguageAdapter): void {
    this.adapters.push(adapter);
  }

  public getAdapterFor(repository: GenericRepository): GenericLanguageAdapter | undefined {
    return this.adapters.find(a => a.canHandle(repository));
  }

  /**
   * Executes verification over arbitrary repository snapshots using the matching language adapter.
   */
  public async verifyRepository(repository: GenericRepository): Promise<VerificationExecutionResult> {
    validateRepositoryBudget(repository);
    const adapter = this.getAdapterFor(repository);
    if (!adapter) {
      throw new Error(`No registered language adapter capable of handling repository ${repository.repositoryId}`);
    }

    // Stage 1 & 2: Project Graph Discovery & Asymmetric Mapping
    const parentGraph = await adapter.discoverProjectGraph(repository.parentSnapshot);
    const candidateGraph = await adapter.discoverProjectGraph(repository.candidateSnapshot);
    validateProjectGraphBudget(parentGraph);
    validateProjectGraphBudget(candidateGraph);
    const projectMapping = await adapter.mapProjectGraphs(parentGraph, candidateGraph);
    this.progress?.('ENTITY_EXTRACTION');

    // Stage 3: Entity Extraction & Multi-Faceted Identity Mapping
    const { entities, changes } = await adapter.identifyEntitiesAndChanges(repository, projectMapping);
    this.progress?.('REFERENCE_DISCOVERY');

    // Stage 4: Sealed Reference & Boundary Discovery. Reference discovery is
    // rooted in semantic changes, not in the complete entity inventory.
    const changedEntities = changes
      .filter(change => change.changeKind !== 'UNCHANGED')
      .flatMap(change => change.identity.parentEntity
        ? [change.identity.parentEntity]
        : change.identity.candidateEntity ? [change.identity.candidateEntity] : []);
    const { staticReferences, unresolvedBoundaries, resolutionFacts = [] } = await adapter.discoverReferences(
      repository.parentSnapshot,
      parentGraph,
      changedEntities
    );
    this.progress?.('COVERAGE_AND_OBLIGATIONS');
    const allDiscoveredReferences = [...staticReferences, ...unresolvedBoundaries];
    const coverage = new DiscoveryCoverageSession(repository, this.discoveryCoverageChecker);
    const coverageAccepted = await coverage.verifyAndAccept({ parentGraph, candidateGraph, projectMapping,
      changes, targetEntities: changedEntities, references: allDiscoveredReferences });
    const environmentFailures = unresolvedBoundaries
      .filter(reference => /(?:UNAVAILABLE|ENVIRONMENT_INVALID|CONFIGURATION_INVALID|DEPENDENCY_CLOSURE)/.test(
        reference.boundaryTaxonomyReason ?? ''))
      .map(reference => ({ failureId: `environment_${reference.referenceId}`,
        taxonomyCode: reference.boundaryTaxonomyReason!, projectId: reference.projectId,
        location: reference.location, referenceId: reference.referenceId }));

    // Stage 5: Obligation Generation with Provenance
    const obligations = await adapter.generateObligations(changes, allDiscoveredReferences);
    if (obligations.length > PRODUCTION_LIMITS.obligations || allDiscoveredReferences.length > PRODUCTION_LIMITS.obligations) {
      throw new Error('RESOURCE_LIMIT_OBLIGATIONS');
    }

    // Stage 6: Obligation Evaluation & Graded Evidence Production
    const evaluatedVerdicts: VerificationVerdict[] = [];
    const acceptance = new EvidenceAcceptanceSession(repository, this.evidenceCheckers);
    this.progress?.('OBLIGATION_EVALUATION');
    for (const obligation of obligations) {
      let verdict = await adapter.evaluateObligation(obligation, repository);
      if ((verdict.assurance === 'F0_FORMAL' || verdict.assurance === 'WITNESS') && !acceptance.verifyAndAccept(obligation, verdict)) {
        verdict = { ...verdict, outcome: 'UNKNOWN', assurance: 'UNRESOLVED',
          evidence: { evidenceId: verdict.provenance.evidenceId, assurance: 'UNRESOLVED', property: verdict.property,
          unresolvedBoundary: { taxonomyCode: 'EVIDENCE_VERIFICATION_FAILED',
            description: 'No registered independent verifier accepted this exact source-bound obligation.',
            remediation: { code: 'PROVIDE_VERIFIED_EVIDENCE', suggestion: 'Retain existing checks until an admitted proof or witness is verified.' } } } };
      }
      evaluatedVerdicts.push(verdict);
    }

    // Stage 7: Conservation & Provenance Integrity Gate
    const conservationReport = ConservationGate.reconcileAndEnforce(
      allDiscoveredReferences,
      obligations,
      evaluatedVerdicts,
      acceptance
    );

    // Stage 8: Summarize Certification Ledger
    let preserved = 0;
    let violated = 0;
    let notApplicable = 0;
    let unknown = 0;

    for (const v of evaluatedVerdicts) {
      if (v.outcome === 'PRESERVED') preserved++;
      else if (v.outcome === 'VIOLATED') violated++;
      else if (v.outcome === 'NOT_APPLICABLE') notApplicable++;
      else unknown++;
    }

    let certificationStatus: CertificationStatus;
    if (!conservationReport.conservationSatisfied) {
      certificationStatus = 'CONSERVATION_ABORT';
    } else if (evaluatedVerdicts.some(verdict => verdict.outcome === 'VIOLATED' &&
        (verdict.assurance === 'F0_FORMAL' || verdict.assurance === 'WITNESS') && acceptance.hasVerifiedAttestation(verdict))) {
      certificationStatus = 'CERTIFIED_VIOLATED';
    } else if (coverageAccepted && allDiscoveredReferences.length > 0 && evaluatedVerdicts.length > 0 &&
        unresolvedBoundaries.length === 0 &&
        environmentFailures.length === 0 && evaluatedVerdicts.every(verdict => verdict.outcome === 'PRESERVED' &&
          verdict.assurance === 'F0_FORMAL' && acceptance.hasVerifiedAttestation(verdict))) {
      certificationStatus = 'CERTIFIED_PRESERVED';
    } else {
      // A local proof is not a proof that discovery found every relevant
      // consumer. Without an accepted domain receipt, neither universal
      // preservation nor empty-domain applicability promotes.
      certificationStatus = 'UNCERTIFIED_UNKNOWN';
    }

    const ledger: CertificationLedger = {
      ledgerId: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      repositoryId: repository.repositoryId,
      parentSnapshotId: repository.parentSnapshot.snapshotId,
      candidateSnapshotId: repository.candidateSnapshot.snapshotId,
      conservationReport,
      discoveryAccounting: {
        coverageProfileId: coverageAccepted ? coverage.acceptedProfileId : undefined,
        targetEntityIds: changedEntities.map(entity => entity.entityId),
        candidateReferencesDiscovered: allDiscoveredReferences.length,
        confirmedConsumers: staticReferences.length,
        unresolvedPotentialConsumers: unresolvedBoundaries.length,
        consumerLocations: allDiscoveredReferences.map(reference => ({
          referenceId: reference.referenceId,
          targetEntityId: reference.targetEntityId,
          relationshipType: reference.kind,
          location: reference.location,
          resolutionId: reference.resolutionId,
          status: reference.isUnresolvedBoundary ? 'UNRESOLVED_POTENTIAL' : 'CONFIRMED'
        })),
        resolutionEvidence: resolutionFacts
      },
      environmentFailures,
      verdicts: evaluatedVerdicts,
      summary: {
        total: evaluatedVerdicts.length,
        preserved,
        violated,
        notApplicable,
        unknown
      },
      certificationStatus,
      issuedAt: new Date().toISOString()
    };

    // Stage 9: Authoritative Gate Verification via Frozen VerdictAuthority
    const primaryTargetId = changedEntities[0]?.entityId ?? entities[0]?.entityId ?? 'root_entity';
    const authoritativeVerdict = VerdictAuthorityBridge.evaluateAuthoritative(ledger, primaryTargetId,
      acceptance, coverage, changedEntities, allDiscoveredReferences);

    return {
      ledger,
      authoritativeVerdict
    };
  }
}
