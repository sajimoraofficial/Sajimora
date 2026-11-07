/**
 * Produces the production certification summary from terminal evidence routes.
 * The production route can certify an independently replayed counterexample.
 * Universal preservation and non-applicability await checked domain coverage.
 */
import { ProofResult, AuthorityDecisionReason } from '../types/verdict';
import { CertificationLedger, Reference, SemanticEntity } from './contracts';
import { EvidenceAcceptanceSession } from './AcceptedEvidence';
import { DiscoveryCoverageSession } from './DiscoveryCoverage';

export class VerdictAuthorityBridge {
  public static evaluateAuthoritative(ledger: CertificationLedger, _primaryTargetSymbolId: string,
    acceptance?: EvidenceAcceptanceSession, coverage?: DiscoveryCoverageSession,
    targets: readonly SemanticEntity[] = [], references: readonly Reference[] = []): ProofResult {
    const decision = (
      verdict: ProofResult['verdict'],
      gate: string,
      reason: AuthorityDecisionReason
    ): ProofResult => ({
      verdict,
      auditTrace: {
        authorityDecision: { source: 'PRODUCTION_CERTIFIER', gate, reason, stage: gate },
        consumers: [...ledger.verdicts],
        proofDiagnostics: { certificationStatus: ledger.certificationStatus, conservation: ledger.conservationReport }
      }
    });

    if (!ledger.conservationReport.conservationSatisfied) {
      return decision('UNKNOWN', 'CONSERVATION_GATE', 'DISCOVERY_FAILURE');
    }
    if (ledger.verdicts.some(route => (route.assurance === 'F0_FORMAL' || route.assurance === 'WITNESS') &&
        (!acceptance?.matchesRepository(ledger.repositoryId, ledger.parentSnapshotId, ledger.candidateSnapshotId) || !acceptance.hasVerifiedAttestation(route)))) {
      return decision('UNKNOWN', 'UNVERIFIED_EVIDENCE', 'UNDECIDABLE_COMPATIBILITY');
    }
    if (ledger.verdicts.some(route => route.outcome === 'VIOLATED' &&
        (route.assurance === 'F0_FORMAL' || route.assurance === 'WITNESS'))) {
      return decision('VIOLATED', 'EVIDENCE_ROUTER', 'INCOMPATIBLE_CONSUMER');
    }
    const coveredReferenceIds = new Set(ledger.verdicts.map(route => route.provenance.referenceId).filter(
      (value): value is string => typeof value === 'string'));
    if (ledger.certificationStatus === 'CERTIFIED_PRESERVED' && references.length > 0 &&
        new Set(references.map(reference => reference.referenceId)).size === references.length &&
        references.every(reference => !reference.isUnresolvedBoundary && coveredReferenceIds.has(reference.referenceId)) &&
        ledger.verdicts.length > 0 &&
        ledger.environmentFailures?.length === 0 &&
        ledger.verdicts.every(route => route.outcome === 'PRESERVED' && route.assurance === 'F0_FORMAL' &&
          acceptance?.hasVerifiedAttestation(route)) && coverage?.matchesLedger(ledger, targets, references)) {
      return decision('PRESERVED', 'DISCOVERY_COVERAGE_AND_PROOFS', 'ALL_EVALUABLE_COMPATIBLE');
    }
    return decision('UNKNOWN', 'DISCOVERY_COVERAGE_UNVERIFIED', 'DISCOVERY_FAILURE');
  }
}
