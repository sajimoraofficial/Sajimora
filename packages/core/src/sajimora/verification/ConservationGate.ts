/**
 * @file ConservationGate.ts
 * Enforces zero-silent-drop conservation, provenance continuity, and evidence integrity invariants.
 * 
 * Formal Invariants Enforced:
 * 1. Conservation of Obligations: |Accounted| = |Discovered Static| + |Discovered Unresolved|
 * 2. Terminal Totality: Every obligation maps to an unambiguous, typed verdict.
 * 3. Provenance Continuity: Every verdict carries a verifiable, unbroken chain:
 *    Repository -> Project -> Resolution -> SymbolIdentity -> Reference -> Obligation -> Evidence -> Verdict.
 * 4. Evidence Integrity: No PRESERVED without proof or diagnostic witness.
 * 5. Purity of Behavioral Preservation: Type-only evidence NEVER promoted to BEHAVIOR_PRESERVED.
 * 6. Ambiguity Demotion: Ambiguous identity or unresolved boundaries NEVER produce PRESERVED.
 */

import {
  VerificationObligation,
  VerificationVerdict,
  ConservationReport,
  Reference
} from './contracts';
import { EvidenceAcceptanceSession } from './AcceptedEvidence';
import { isDeepStrictEqual } from 'node:util';

export class ConservationAbortError extends Error {
  public readonly reason: string;
  public readonly report: ConservationReport;

  constructor(message: string, reason: string, report: ConservationReport) {
    super(`[CONSERVATION_ABORT] ${message} (Reason: ${reason})`);
    this.name = 'ConservationAbortError';
    this.reason = reason;
    this.report = report;
  }
}

export class ConservationGate {
  /**
   * Reconciles all discovered references, generated obligations, and evaluated verdicts.
   * Throws ConservationAbortError on any discrepancy, silent drop, or illicit verdict promotion.
   */
  public static reconcileAndEnforce(
    discoveredReferences: readonly Reference[],
    generatedObligations: readonly VerificationObligation[],
    evaluatedVerdicts: readonly VerificationVerdict[],
    acceptance?: EvidenceAcceptanceSession
  ): ConservationReport {
    const staticReferencesCount = discoveredReferences.filter(r => !r.isUnresolvedBoundary).length;
    const unresolvedBoundariesCount = discoveredReferences.filter(r => r.isUnresolvedBoundary).length;
    const totalDiscoveredReferences = discoveredReferences.length;
    const referenceMap = new Map<string, Reference>();
    for (const reference of discoveredReferences) {
      if (referenceMap.has(reference.referenceId)) throw new Error(`Duplicate discovered reference ID: ${reference.referenceId}`);
      referenceMap.set(reference.referenceId, reference);
    }

    const generatedIds = new Set<string>();
    const obligationMap = new Map<string, VerificationObligation>();
    for (const ob of generatedObligations) {
      if (ob.reference && !isDeepStrictEqual(referenceMap.get(ob.reference.referenceId), ob.reference)) {
        throw new Error(`Obligation references an undiscovered or altered consumer: ${ob.obligationId}`);
      }
      if (generatedIds.has(ob.obligationId)) {
        throw new Error(`Duplicate obligation ID detected: ${ob.obligationId}`);
      }
      generatedIds.add(ob.obligationId);
      obligationMap.set(ob.obligationId, ob);
    }

    const accountedIds = new Set<string>();
    const duplicateVerdictIds = new Set<string>();

    for (const verdict of evaluatedVerdicts) {
      if (accountedIds.has(verdict.obligationId)) {
        duplicateVerdictIds.add(verdict.obligationId);
      }
      accountedIds.add(verdict.obligationId);

      // Invariant Check: Validate evidence backing, semantic honesty, and provenance continuity
      const obligation = obligationMap.get(verdict.obligationId);
      this.validateVerdictIntegrity(verdict, obligation, acceptance);
    }

    if (duplicateVerdictIds.size > 0) {
      const report: ConservationReport = {
        totalDiscoveredReferences,
        staticReferencesCount,
        unresolvedBoundariesCount,
        generatedObligationsCount: generatedObligations.length,
        accountedObligationsCount: accountedIds.size,
        silentDropsCount: 0,
        conservationSatisfied: false,
        unaccountedObligationIds: []
      };
      throw new ConservationAbortError(
        `Multiple verdicts received for the same obligation(s): ${Array.from(duplicateVerdictIds).join(', ')}`,
        'DUPLICATE_VERDICTS',
        report
      );
    }

    const unaccountedObligationIds: string[] = [];
    for (const obId of generatedIds) {
      if (!accountedIds.has(obId)) {
        unaccountedObligationIds.push(obId);
      }
    }

    // Check for rogue verdicts that were never generated obligations
    for (const v of evaluatedVerdicts) {
      if (!generatedIds.has(v.obligationId)) {
        const report: ConservationReport = {
          totalDiscoveredReferences,
          staticReferencesCount,
          unresolvedBoundariesCount,
          generatedObligationsCount: generatedObligations.length,
          accountedObligationsCount: accountedIds.size,
          silentDropsCount: unaccountedObligationIds.length,
          conservationSatisfied: false,
          unaccountedObligationIds
        };
        throw new ConservationAbortError(
          `Verdict emitted for unknown/unregistered obligation: ${v.obligationId}`,
          'ROGUE_VERDICT_EMITTED',
          report
        );
      }
    }

    const coveredReferences = new Set(generatedObligations.flatMap(ob => ob.reference ? [ob.reference.referenceId] : []));
    const missingReferences = discoveredReferences.filter(ref => !coveredReferences.has(ref.referenceId));
    const silentDropsCount = unaccountedObligationIds.length + missingReferences.length;
    const conservationSatisfied = silentDropsCount === 0 && generatedObligations.length === evaluatedVerdicts.length;

    const report: ConservationReport = {
      totalDiscoveredReferences,
      staticReferencesCount,
      unresolvedBoundariesCount,
      generatedObligationsCount: generatedObligations.length,
      accountedObligationsCount: accountedIds.size,
      silentDropsCount,
      conservationSatisfied,
      unaccountedObligationIds: [...unaccountedObligationIds, ...missingReferences.map(ref => `reference:${ref.referenceId}`)]
    };

    if (!conservationSatisfied) {
      throw new ConservationAbortError(
        `Conservation failure: ${silentDropsCount} obligations were silently dropped or missing terminal verdicts.`,
        'SILENT_DROP_DETECTED',
        report
      );
    }

    return report;
  }

  /**
   * Enforces that no verdict violates epistemic integrity or provenance continuity.
   */
  private static validateVerdictIntegrity(
    verdict: VerificationVerdict,
    obligation?: VerificationObligation,
    acceptance?: EvidenceAcceptanceSession
  ): void {
    // Invariant Check 1: Provenance Chain Continuity
    if (!verdict.provenance) {
      throw new Error(`Missing provenance chain on verdict ${verdict.verdictId}`);
    }
    const prov = verdict.provenance;
    if (!prov.repositoryId || !prov.projectId || !prov.identityId || !prov.obligationId || !prov.verdictId) {
      throw new Error(`Broken provenance chain on verdict ${verdict.verdictId}: missing required provenance identifiers`);
    }
    if (prov.obligationId !== verdict.obligationId) {
      throw new Error(`Provenance mismatch on verdict ${verdict.verdictId}: provenance obligationId (${prov.obligationId}) !== verdict obligationId (${verdict.obligationId})`);
    }
    if (prov.verdictId !== verdict.verdictId) {
      throw new Error(`Provenance mismatch on verdict ${verdict.verdictId}: provenance verdictId (${prov.verdictId}) !== verdictId (${verdict.verdictId})`);
    }
    if (obligation) {
      if (obligation.projectId !== prov.projectId) {
        throw new Error(`Provenance mismatch on verdict ${verdict.verdictId}: obligation projectId (${obligation.projectId}) !== provenance projectId (${prov.projectId})`);
      }
      const isBoundary = obligation.reference?.isUnresolvedBoundary;
      if (!isBoundary) {
        const expectedTargetId = obligation.reference?.targetEntityId ??
          obligation.change.identity.parentEntity?.entityId ??
          obligation.change.identity.candidateEntity?.entityId;
        if (expectedTargetId && verdict.targetEntityId !== expectedTargetId) {
          throw new Error(`Target entity mismatch on verdict ${verdict.verdictId}: verdict targetEntityId (${verdict.targetEntityId}) !== obligation targetEntityId (${expectedTargetId})`);
        }
      }
      const expectedRefId = obligation.reference?.referenceId;
      if (expectedRefId && prov.referenceId !== expectedRefId) {
        throw new Error(`Consumer reference mismatch on verdict ${verdict.verdictId}: provenance referenceId (${prov.referenceId}) !== obligation consumer referenceId (${expectedRefId})`);
      }
    }

    if ((verdict.assurance === 'F0_FORMAL' || verdict.assurance === 'WITNESS') && !acceptance?.hasVerifiedAttestation(verdict, obligation)) {
      throw new Error(`Unverified evidence on ${verdict.obligationId}: proof/witness must be independently checked in this execution; serialized flags and metadata are not evidence.`);
    }

    // Invariant Check 2: Behavior Preservation Purity
    if (verdict.outcome === 'PRESERVED' && verdict.property === 'BEHAVIOR') {
      if (verdict.assurance !== 'F0_FORMAL') {
        throw new Error(
          `Epistemic violation on obligation ${verdict.obligationId}: BEHAVIOR preservation claimed under non-formal assurance tier (${verdict.assurance}). Compiler diagnostics, static analysis, or sampled witnesses can only prove VIOLATION or TYPE preservation.`
        );
      }
      if (!verdict.evidence.f0Formal) {
        throw new Error(
          `Missing evidence on obligation ${verdict.obligationId}: BEHAVIOR preservation claimed without formal proof trace.`
        );
      }
    }

    // Invariant Check 2b: Operational Witness Integrity
    if (verdict.assurance === 'WITNESS') {
      if (verdict.outcome === 'PRESERVED') {
        throw new Error(
          `Illegal outcome on obligation ${verdict.obligationId}: WITNESS assurance tier cannot prove PRESERVED. Sampled operational executions can only establish concrete VIOLATED counterexamples.`
        );
      }
      if (verdict.outcome === 'VIOLATED') {
        const hasWitness = Boolean(
          verdict.evidence.f0Formal?.operationalWitness ||
          verdict.evidence.metadata?.['behavioralWitness'] ||
          verdict.evidence.metadata?.['counterexample']
        );
        if (!hasWitness) {
          throw new Error(
            `Missing counterexample on obligation ${verdict.obligationId}: VIOLATED verdict under WITNESS assurance requires concrete operational counterexample evidence.`
          );
        }
      }
    }

    // Invariant Check 3: Compiler Static Scope
    if (verdict.assurance === 'COMPILER_STATIC') {
      if (verdict.property === 'BEHAVIOR') {
        throw new Error(
          `Illegal tier promotion on obligation ${verdict.obligationId}: Compiler static analysis cannot claim BEHAVIOR preservation.`
        );
      }
      if (verdict.outcome === 'PRESERVED' && !verdict.evidence.compilerStatic) {
        throw new Error(
          `Missing evidence on obligation ${verdict.obligationId}: COMPILER_STATIC PRESERVED verdict requires diagnostic receipts.`
        );
      }
    }

    // Invariant Check 4: Unresolved Boundary Handling
    if (verdict.assurance === 'UNRESOLVED') {
      if (verdict.outcome === 'PRESERVED') {
        throw new Error(
          `Illegal outcome on obligation ${verdict.obligationId}: UNRESOLVED boundary can never produce PRESERVED verdict.`
        );
      }
      if (!verdict.evidence.unresolvedBoundary) {
        throw new Error(
          `Missing taxonomy on obligation ${verdict.obligationId}: UNRESOLVED verdict must specify taxonomy code and remediation.`
        );
      }
    }
  }
}
