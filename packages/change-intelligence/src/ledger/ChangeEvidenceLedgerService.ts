/**
 * SAJIMORA V32 — Change-Scoped Evidence Ledger Service
 * Subordinate to sajimora_v32_foundation_spec.md §3.1–§3.5 & Final Implementation Plan.
 *
 * Implements ledger lifecycle (OPEN -> RECONCILING -> CLOSED) and enforces all
 * ledger rules LED-R1 through LED-R7:
 * - LED-R1: Rejects UNKNOWN derivation method with confidence > 0.30
 * - LED-R2: Rejects orphan evidence (empty relatedExpectationIds)
 * - LED-R3: Rejects duplicate evidenceId within the same ledger
 * - LED-R4: Ledger transitions to RECONCILING only when at least one expectation exists
 * - LED-R5: Once status = CLOSED, no additional entries may be appended
 * - LED-R6: Specific missingFact in gap records
 * - LED-R7: Strict workspaceId match across all sub-records
 *
 * Phase 1 Prohibitions:
 * - Actively rejects sourceType = 'INVARIANT_TRANSITION' or 'RUNTIME' (fails closed)
 * - Idempotent return of existing CLOSED ledger (no re-calculation)
 */

import * as crypto from 'crypto';
import {
  ChangeEvidenceLedger,
  ChangeId,
  ChangeSetDelta,
  ChangeVerdict,
  EvidenceEntry,
  EvidenceGapRecord,
  EvidenceSourceType,
  ExpectedChangeModel,
  ExpectationRecord,
  ReconciliationRecord,
} from '../types';
import { isPathBoundaryViolated } from '../ecm/validator';
import { computeVcsScore } from './VcsCalculator';
import { computeChangeVerdict } from './VerdictCalculator';
import { ReconciliationEngine } from './ReconciliationEngine';
import { GapDetector } from './GapDetector';

export class ChangeEvidenceLedgerService {
  private reconciliationEngine: ReconciliationEngine;
  private gapDetector: GapDetector;

  constructor() {
    this.reconciliationEngine = new ReconciliationEngine();
    this.gapDetector = new GapDetector();
  }

  /**
   * Initializes an OPEN ledger from an immutable ExpectedChangeModel.
   */
  initializeLedger(ecm: ExpectedChangeModel): ChangeEvidenceLedger {
    const expectations: ExpectationRecord[] = [];

    // Map file expectations
    for (let i = 0; i < ecm.expectedFiles.length; i++) {
      const ef = ecm.expectedFiles[i];
      expectations.push({
        expectationId: `exp-file-${i}-${ef.filePath}`,
        changeId: ecm.changeId,
        workspaceId: ecm.workspaceId,
        expectationType: 'FILE_CHANGE',
        description: `${ef.changeType}:${ef.filePath}`,
        ecmConfidence: ef.confidence,
        ecmProvenance: ef.provenance,
        collectedEvidenceIds: [],
        reconciliationState: 'UNRESOLVED',
        verdict: 'UNOBSERVED',
        verdictReason: 'Pending evidence collection',
      });
    }

    // Map symbol expectations
    for (let i = 0; i < ecm.expectedSymbols.length; i++) {
      const es = ecm.expectedSymbols[i];
      expectations.push({
        expectationId: `exp-sym-${i}-${es.symbolName}`,
        changeId: ecm.changeId,
        workspaceId: ecm.workspaceId,
        expectationType: 'SYMBOL_CHANGE',
        description: `${es.changeType}:${es.filePath}#${es.symbolName}`,
        ecmConfidence: es.confidence,
        ecmProvenance: es.provenance,
        collectedEvidenceIds: [],
        reconciliationState: 'UNRESOLVED',
        verdict: 'UNOBSERVED',
        verdictReason: 'Pending evidence collection',
      });
    }

    // Map edge expectations
    for (let i = 0; i < ecm.expectedEdges.length; i++) {
      const ee = ecm.expectedEdges[i];
      expectations.push({
        expectationId: `exp-edge-${i}-${ee.sourceFilePath}->${ee.targetFilePath}`,
        changeId: ecm.changeId,
        workspaceId: ecm.workspaceId,
        expectationType: 'EDGE_CHANGE',
        description: `${ee.changeType}:${ee.sourceFilePath}->${ee.targetFilePath}`,
        ecmConfidence: ee.confidence,
        ecmProvenance: ee.provenance,
        collectedEvidenceIds: [],
        reconciliationState: 'UNRESOLVED',
        verdict: 'UNOBSERVED',
        verdictReason: 'Pending evidence collection',
      });
    }

    // Map behavioral obligations
    for (let i = 0; i < ecm.expectedBehavioralObligations.length; i++) {
      const bo = ecm.expectedBehavioralObligations[i];
      expectations.push({
        expectationId: `exp-bo-${i}-${bo.obligationId}`,
        changeId: ecm.changeId,
        workspaceId: ecm.workspaceId,
        expectationType: 'BEHAVIORAL_OBLIGATION',
        description: `${bo.obligationId}: ${bo.description}`,
        ecmConfidence: bo.confidence,
        ecmProvenance: bo.provenance,
        collectedEvidenceIds: [],
        reconciliationState: 'UNRESOLVED',
        verdict: 'UNOBSERVED',
        verdictReason: 'Pending evidence collection',
      });
    }

    // Map invariant transitions (schema data only in Phase 1)
    for (let i = 0; i < ecm.expectedInvariantTransitions.length; i++) {
      const it = ecm.expectedInvariantTransitions[i];
      expectations.push({
        expectationId: `exp-inv-${i}`,
        changeId: ecm.changeId,
        workspaceId: ecm.workspaceId,
        expectationType: 'INVARIANT_TRANSITION',
        description: `${it.expectedState}: ${it.invariantDescription}`,
        ecmConfidence: it.confidence,
        ecmProvenance: it.provenance,
        collectedEvidenceIds: [],
        reconciliationState: 'UNRESOLVED',
        verdict: 'UNOBSERVED',
        verdictReason: 'Pending evidence collection',
      });
    }

    const now = new Date();
    return {
      changeId: ecm.changeId,
      workspaceId: ecm.workspaceId,
      baseCommitSha: ecm.baseCommitSha,
      candidateCommitSha: ecm.candidateCommitSha,
      createdAt: now,
      lastUpdatedAt: now,
      status: 'OPEN',
      ecmSource: ecm.ecmSource,
      ecmConfidence: ecm.overallConfidence,
      expectations,
      evidence: [],
      reconciliations: [],
      gaps: [],
      vcs: 0.0,
      counts: {
        totalExpectations: expectations.length,
        satisfied: 0,
        unsatisfied: 0,
        boundaryViolations: 0,
        unobserved: expectations.length,
        insufficientEvidence: 0,
        totalEvidenceEntries: 0,
        deterministicEntries: 0,
        contradictions: 0,
        gaps: 0,
      },
      verdict: null,
      verdictReason: 'Ledger initialized in OPEN state.',
      verdictComputedAt: null,
    };
  }

  /**
   * Appends an EvidenceEntry to the ledger, enforcing LED-R1 through LED-R7
   * and Phase 1 prohibitions.
   */
  appendEvidence(ledger: ChangeEvidenceLedger, entry: EvidenceEntry): void {
    // LED-R5: Once status = CLOSED, no additional entries may be appended
    if (ledger.status === 'CLOSED') {
      throw new Error('IMMUTABLE_LEDGER_ERROR: Cannot append evidence to a CLOSED ledger (LED-R5).');
    }

    // Phase 1 Prohibition: INVARIANT_TRANSITION and RUNTIME are prohibited
    if (entry.sourceType === 'INVARIANT_TRANSITION' || entry.sourceType === 'RUNTIME') {
      throw new Error(
        `PROHIBITED_SOURCE_TYPE: sourceType "${entry.sourceType}" is reserved and prohibited in Phase 1.`
      );
    }

    // LED-R7: Workspace scoping check
    if (entry.workspaceId !== ledger.workspaceId) {
      throw new Error(
        `CROSS_TENANT_ERROR: Evidence entry workspaceId "${entry.workspaceId}" does not match ledger workspaceId "${ledger.workspaceId}" (LED-R7).`
      );
    }

    // LED-R1: UNKNOWN derivationMethod capped at 0.30
    if (entry.derivationMethod === 'UNKNOWN' && entry.confidence > 0.30) {
      throw new Error(
        `VALIDATION_ERROR: EvidenceEntry with derivationMethod=UNKNOWN and confidence > 0.30 is rejected (LED-R1).`
      );
    }

    // LED-R2: No orphan evidence
    if (!entry.relatedExpectationIds || entry.relatedExpectationIds.length === 0) {
      throw new Error(
        `VALIDATION_ERROR: EvidenceEntry with empty relatedExpectationIds is rejected (LED-R2).`
      );
    }

    // LED-R3: Reject duplicate evidenceId
    if (ledger.evidence.some((e) => e.evidenceId === entry.evidenceId)) {
      throw new Error(
        `DUPLICATE_EVIDENCE_ERROR: Duplicate evidenceId "${entry.evidenceId}" in ledger (LED-R3).`
      );
    }

    ledger.evidence.push(entry);
    ledger.lastUpdatedAt = new Date();
  }

  /**
   * Ingests AST Structural Diff and boundary checks into the ledger.
   */
  ingestAstDiffAndBoundary(
    ledger: ChangeEvidenceLedger,
    ecm: ExpectedChangeModel,
    diff: ChangeSetDelta
  ): void {
    if (ledger.status === 'CLOSED') {
      throw new Error('Cannot ingest into a CLOSED ledger.');
    }

    // 1. Boundary checking against all touched files
    if (ecm.changeBoundary && ecm.changeBoundary.forbiddenPaths.length > 0) {
      for (const fd of diff.fileDeltas) {
        for (const forbidden of ecm.changeBoundary.forbiddenPaths) {
          if (isPathBoundaryViolated(fd.filePath, forbidden)) {
            // Find all expectations to link
            const relatedIds = ledger.expectations.map((e) => e.expectationId);
            const evidenceId = crypto
              .createHash('sha256')
              .update(`${ledger.changeId}:BOUNDARY_VIOLATION:${fd.filePath}:${forbidden}:PATH_PREFIX_MATCH`)
              .digest('hex');

            this.appendEvidence(ledger, {
              evidenceId,
              changeId: ledger.changeId,
              workspaceId: ledger.workspaceId,
              entityId: fd.filePath,
              entityType: 'BOUNDARY',
              observation: `BOUNDARY_VIOLATION: File ${fd.filePath} violates forbidden prefix ${forbidden} (${ecm.changeBoundary.reason})`,
              sourceType: 'BOUNDARY_VIOLATION',
              derivationMethod: 'PATH_PREFIX_MATCH',
              observedAt: new Date(),
              observationWindow: {
                kind: 'COMMIT_RANGE',
                from: ledger.baseCommitSha,
                to: ledger.candidateCommitSha,
              },
              confidence: 1.0,
              structuralConfidence: 'DETERMINISTIC',
              relatedExpectationIds: relatedIds.length > 0 ? relatedIds : ['boundary-root'],
              supportingEvidenceIds: [],
              contradictingEvidenceIds: [],
            });
          }
        }
      }
    }

    // 2. Ingest AST file & symbol deltas
    for (const fd of diff.fileDeltas) {
      // Look for matching file expectations
      const matchingFileExp = ledger.expectations.filter((e) => {
        if (e.expectationType !== 'FILE_CHANGE') return false;
        const colonIdx = e.description.indexOf(':');
        const expFilePath = colonIdx >= 0 ? e.description.substring(colonIdx + 1) : e.description;
        return expFilePath === fd.filePath;
      });
      const relatedIds = matchingFileExp.map((e) => e.expectationId);

      const fileEvidenceId = crypto
        .createHash('sha256')
        .update(`${ledger.changeId}:AST_STRUCTURAL:${fd.filePath}:AST_PARSE_DIFF`)
        .digest('hex');

      // Check if file status matches expectation
      let observation = `MATCH_EXACT: File ${fd.filePath} was ${fd.fileChangeType}`;
      let confidence = fd.diffConfidence === 'DETERMINISTIC' ? 0.95 : fd.diffConfidence === 'PARTIAL' ? 0.60 : 0.10;

      if (matchingFileExp.length > 0 && !matchingFileExp.some((e) => e.description.startsWith(fd.fileChangeType))) {
        observation = `MISMATCH: File ${fd.filePath} was ${fd.fileChangeType} but expected different change`;
      }

      if (relatedIds.length > 0) {
        this.appendEvidence(ledger, {
          evidenceId: fileEvidenceId,
          changeId: ledger.changeId,
          workspaceId: ledger.workspaceId,
          entityId: fd.filePath,
          entityType: 'FILE',
          observation,
          sourceType: 'AST_STRUCTURAL',
          derivationMethod: 'AST_PARSE_DIFF',
          observedAt: new Date(),
          observationWindow: {
            kind: 'COMMIT_RANGE',
            from: ledger.baseCommitSha,
            to: ledger.candidateCommitSha,
          },
          confidence,
          structuralConfidence: fd.diffConfidence,
          relatedExpectationIds: relatedIds,
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
        });
      }

      // Symbol deltas
      for (const sd of fd.symbolDeltas) {
        const matchingSymExp = ledger.expectations.filter((e) => {
          if (e.expectationType !== 'SYMBOL_CHANGE') return false;
          const colonIdx = e.description.indexOf(':');
          const rest = colonIdx >= 0 ? e.description.substring(colonIdx + 1) : e.description;
          const hashIdx = rest.indexOf('#');
          const expFilePath = hashIdx >= 0 ? rest.substring(0, hashIdx) : '';
          const expSymbolName = hashIdx >= 0 ? rest.substring(hashIdx + 1) : rest;
          return expSymbolName === sd.symbolName && (!expFilePath || expFilePath === fd.filePath);
        });
        const symRelatedIds = matchingSymExp.map((e) => e.expectationId);

        if (symRelatedIds.length > 0) {
          const symEvidenceId = crypto
            .createHash('sha256')
            .update(`${ledger.changeId}:AST_STRUCTURAL:${fd.filePath}#${sd.symbolName}:${sd.changeType}`)
            .digest('hex');

          let symObs = `MATCH_EXACT: Symbol ${sd.symbolName} was ${sd.changeType}`;
          if (matchingSymExp.length > 0 && !matchingSymExp.some((e) => e.description.startsWith(sd.changeType))) {
            symObs = `MISMATCH: Symbol ${sd.symbolName} was ${sd.changeType} but expected different change`;
          }

          this.appendEvidence(ledger, {
            evidenceId: symEvidenceId,
            changeId: ledger.changeId,
            workspaceId: ledger.workspaceId,
            entityId: `${fd.filePath}#${sd.symbolName}`,
            entityType: 'SYMBOL',
            observation: symObs,
            sourceType: 'AST_STRUCTURAL',
            derivationMethod: 'AST_PARSE_DIFF',
            observedAt: new Date(),
            observationWindow: {
              kind: 'COMMIT_RANGE',
              from: ledger.baseCommitSha,
              to: ledger.candidateCommitSha,
            },
            confidence: fd.diffConfidence === 'DETERMINISTIC' ? 0.95 : fd.diffConfidence === 'PARTIAL' ? 0.60 : 0.10,
            structuralConfidence: fd.diffConfidence,
            relatedExpectationIds: symRelatedIds,
            supportingEvidenceIds: [],
            contradictingEvidenceIds: [],
          });
        }
      }
    }
  }

  /**
   * Reconciles all expectations, calculates VCS, derives ChangeVerdict,
   * and closes the ledger.
   */
  reconcileAndClose(ledger: ChangeEvidenceLedger): ChangeEvidenceLedger {
    if (ledger.status === 'CLOSED') {
      return ledger; // Idempotent return if already closed
    }

    // LED-R4: Ledger transitions to RECONCILING only when at least one expectation exists
    if (ledger.expectations.length === 0) {
      const hasBoundaryViolation = ledger.evidence.some(
        (e) => e.sourceType === 'BOUNDARY_VIOLATION' || e.entityType === 'BOUNDARY'
      );
      if (hasBoundaryViolation) {
        ledger.status = 'CLOSED';
        ledger.vcs = 0.0;
        ledger.verdict = 'BLOCK';
        ledger.verdictReason = 'Change violates declared boundary path constraints. Boundary violations block unconditionally.';
        ledger.verdictComputedAt = new Date();
        ledger.lastUpdatedAt = new Date();
        return ledger;
      }
      ledger.status = 'CLOSED';
      ledger.vcs = 0.0;
      ledger.verdict = 'INSUFFICIENT_EVIDENCE';
      ledger.verdictReason = 'Honest absence: ECM contained zero expectations.';
      ledger.verdictComputedAt = new Date();
      ledger.lastUpdatedAt = new Date();
      return ledger;
    }

    ledger.status = 'RECONCILING';

    const reconciliations: ReconciliationRecord[] = [];
    const gaps: EvidenceGapRecord[] = [];

    let satisfied = 0;
    let complementarySatisfied = 0;
    let unsatisfied = 0;
    let boundaryViolations = 0;
    let unobserved = 0;
    let insufficientEvidence = 0;
    let contradictions = 0;

    for (const exp of ledger.expectations) {
      // Check for gap
      const gap = this.gapDetector.detectGap(ledger.changeId, ledger.workspaceId, exp);
      if (gap) {
        gaps.push(gap);
      }

      // Reconcile
      const recResult = this.reconciliationEngine.reconcileExpectation(
        ledger.changeId,
        ledger.workspaceId,
        exp,
        ledger.evidence,
        gap
      );

      exp.verdict = recResult.updatedVerdict;
      exp.reconciliationState = recResult.updatedState;
      exp.verdictReason = recResult.verdictReason;
      reconciliations.push(recResult.reconciliation);

      if (exp.verdict === 'SATISFIED') {
        if (exp.reconciliationState === 'COMPLEMENTARY') {
          complementarySatisfied++;
        } else {
          satisfied++;
        }
      } else if (exp.verdict === 'BOUNDARY_VIOLATED') {
        boundaryViolations++;
      } else if (exp.verdict === 'UNSATISFIED') {
        unsatisfied++;
      } else if (exp.verdict === 'UNOBSERVED') {
        unobserved++;
      } else if (exp.verdict === 'INSUFFICIENT_EVIDENCE') {
        insufficientEvidence++;
      }

      if (exp.reconciliationState === 'CONTRADICTORY') {
        contradictions++;
      }
    }

    ledger.reconciliations = reconciliations;
    ledger.gaps = gaps;

    // Count deterministic entries
    const deterministicEntries = ledger.evidence.filter(
      (e) => e.structuralConfidence === 'DETERMINISTIC'
    ).length;

    // VCS Calculation (§3.3.3)
    const vcs = computeVcsScore({
      totalExpectations: ledger.expectations.length,
      satisfiedCount: satisfied,
      complementarySatisfiedCount: complementarySatisfied,
      unsatisfiedCount: unsatisfied,
      boundaryViolatedCount: boundaryViolations,
      contradictoryCount: contradictions,
      totalEvidenceEntries: ledger.evidence.length,
      deterministicEvidenceEntries: deterministicEntries,
    });

    // ChangeVerdict Calculation (§3.3.4)
    const verdictResult = computeChangeVerdict({
      vcs,
      expectations: ledger.expectations,
      boundaryViolations,
      contradictions,
      ecmConfidence: ledger.ecmConfidence,
    });

    ledger.vcs = vcs;
    ledger.counts = {
      totalExpectations: ledger.expectations.length,
      satisfied: satisfied + complementarySatisfied,
      unsatisfied,
      boundaryViolations,
      unobserved,
      insufficientEvidence,
      totalEvidenceEntries: ledger.evidence.length,
      deterministicEntries,
      contradictions,
      gaps: gaps.length,
    };
    ledger.verdict = verdictResult.verdict;
    ledger.verdictReason = verdictResult.verdictReason;
    ledger.verdictComputedAt = new Date();
    ledger.status = 'CLOSED';
    ledger.lastUpdatedAt = new Date();

    return ledger;
  }
}
