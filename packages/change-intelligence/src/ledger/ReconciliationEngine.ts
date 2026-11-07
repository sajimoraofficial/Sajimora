/**
 * SAJIMORA V32 — Evidence Reconciliation Engine
 * Subordinate to sajimora_v32_foundation_spec.md §3.3.2 & Final Implementation Plan.
 *
 * Reconciles collected evidence entries against ECM expectations using strictly
 * the frozen specification vocabulary:
 * - ReconciliationState: CONSISTENT | COMPLEMENTARY | CONTRADICTORY | INSUFFICIENT | UNRESOLVED
 * - ExpectationVerdict:  SATISFIED | UNSATISFIED | BOUNDARY_VIOLATED | UNOBSERVED | INSUFFICIENT_EVIDENCE
 *
 * Rules follow strict priority (§3.3.2). Zero ML / Zero LLM.
 */

import {
  ChangeId,
  EvidenceEntry,
  EvidenceGapRecord,
  ExpectationRecord,
  ExpectationVerdict,
  ReconciliationRecord,
  ReconciliationState,
} from '../types';

export class ReconciliationEngine {
  /**
   * Reconciles an expectation against all collected evidence in the ledger.
   */
  reconcileExpectation(
    changeId: ChangeId,
    workspaceId: string,
    expectation: ExpectationRecord,
    allEvidence: EvidenceEntry[],
    gapRecord: EvidenceGapRecord | null
  ): {
    reconciliation: ReconciliationRecord;
    updatedVerdict: ExpectationVerdict;
    updatedState: ReconciliationState;
    verdictReason: string;
  } {
    // 1. Filter evidence related to this expectation
    const relatedEvidence = allEvidence.filter(
      (ev) =>
        ev.relatedExpectationIds.includes(expectation.expectationId) ||
        ev.entityId === expectation.description
    );

    const evidenceIds = relatedEvidence.map((e) => e.evidenceId);
    const conflictingEvidenceIds: string[] = [];

    for (const ev of relatedEvidence) {
      if (ev.contradictingEvidenceIds && ev.contradictingEvidenceIds.length > 0) {
        conflictingEvidenceIds.push(...ev.contradictingEvidenceIds);
      }
    }

    // Evaluate rules by frozen priority (§3.3.2):

    // Rule 1: Any EvidenceEntry has BOUNDARY_VIOLATION -> BOUNDARY_VIOLATED, CONTRADICTORY
    const boundaryViolation = relatedEvidence.find(
      (ev) => ev.sourceType === 'BOUNDARY_VIOLATION' || ev.entityType === 'BOUNDARY'
    );
    if (boundaryViolation) {
      const state: ReconciliationState = 'CONTRADICTORY';
      const verdict: ExpectationVerdict = 'BOUNDARY_VIOLATED';
      const reason = `Change touched forbidden boundary path: ${boundaryViolation.observation}. Unconditional violation.`;
      return {
        reconciliation: this.createRecord(changeId, workspaceId, expectation.expectationId, state, evidenceIds, conflictingEvidenceIds, reason),
        updatedVerdict: verdict,
        updatedState: state,
        verdictReason: reason,
      };
    }

    // Rule 2: contradictingEvidenceIds non-empty -> CONTRADICTORY, UNSATISFIED
    if (conflictingEvidenceIds.length > 0) {
      const state: ReconciliationState = 'CONTRADICTORY';
      const verdict: ExpectationVerdict = 'UNSATISFIED';
      const reason = `Expectation is contradicted by evidence entry ${conflictingEvidenceIds.join(', ')}.`;
      return {
        reconciliation: this.createRecord(changeId, workspaceId, expectation.expectationId, state, evidenceIds, conflictingEvidenceIds, reason),
        updatedVerdict: verdict,
        updatedState: state,
        verdictReason: reason,
      };
    }

    // Rule 3: All evidence has confidence < 0.3 -> INSUFFICIENT, INSUFFICIENT_EVIDENCE
    if (relatedEvidence.length > 0 && relatedEvidence.every((e) => e.confidence < 0.3)) {
      const state: ReconciliationState = 'INSUFFICIENT';
      const verdict: ExpectationVerdict = 'INSUFFICIENT_EVIDENCE';
      const reason = `All collected evidence has low confidence (< 0.30). Evidence is insufficient.`;
      return {
        reconciliation: this.createRecord(changeId, workspaceId, expectation.expectationId, state, evidenceIds, conflictingEvidenceIds, reason),
        updatedVerdict: verdict,
        updatedState: state,
        verdictReason: reason,
      };
    }

    // Rule 4: No EvidenceEntry AND no gap record -> UNOBSERVED (honest absence, not a failure)
    if (relatedEvidence.length === 0 && !gapRecord) {
      const state: ReconciliationState = 'UNRESOLVED';
      const verdict: ExpectationVerdict = 'UNOBSERVED';
      const reason = `No evidence collected and no explicit gap flagged (honest absence).`;
      return {
        reconciliation: this.createRecord(changeId, workspaceId, expectation.expectationId, state, evidenceIds, conflictingEvidenceIds, reason),
        updatedVerdict: verdict,
        updatedState: state,
        verdictReason: reason,
      };
    }

    // Rule 5: No EvidenceEntry AND gap with bounded=false -> INSUFFICIENT_EVIDENCE
    if (relatedEvidence.length === 0 && gapRecord && !gapRecord.bounded) {
      const state: ReconciliationState = 'INSUFFICIENT';
      const verdict: ExpectationVerdict = 'INSUFFICIENT_EVIDENCE';
      const reason = `No evidence observed for unbounded expectation: ${gapRecord.missingFact}`;
      return {
        reconciliation: this.createRecord(changeId, workspaceId, expectation.expectationId, state, evidenceIds, conflictingEvidenceIds, reason),
        updatedVerdict: verdict,
        updatedState: state,
        verdictReason: reason,
      };
    }

    // Rule 6: observed value does not match expected value -> CONTRADICTORY, UNSATISFIED
    const negativeMatch = relatedEvidence.find(
      (ev) =>
        ev.observation.startsWith('MISMATCH') ||
        ev.observation.includes('CONTRADICTED')
    );
    if (negativeMatch) {
      const state: ReconciliationState = 'CONTRADICTORY';
      const verdict: ExpectationVerdict = 'UNSATISFIED';
      const reason = `Observed actual change contradicts expectation: ${negativeMatch.observation}.`;
      return {
        reconciliation: this.createRecord(changeId, workspaceId, expectation.expectationId, state, evidenceIds, conflictingEvidenceIds, reason),
        updatedVerdict: verdict,
        updatedState: state,
        verdictReason: reason,
      };
    }

    // Rule 7: observed value matches expected value -> CONSISTENT, SATISFIED
    const exactMatch = relatedEvidence.find(
      (ev) =>
        (ev.observation.startsWith('MATCH_EXACT') ||
        ev.observation.includes('SATISFIED')) &&
        ev.confidence >= 0.80
    );
    if (exactMatch) {
      const state: ReconciliationState = 'CONSISTENT';
      const verdict: ExpectationVerdict = 'SATISFIED';
      const reason = `Observed structural change matches expectation with high confidence (${exactMatch.confidence.toFixed(2)}): ${exactMatch.observation}.`;
      return {
        reconciliation: this.createRecord(changeId, workspaceId, expectation.expectationId, state, evidenceIds, conflictingEvidenceIds, reason),
        updatedVerdict: verdict,
        updatedState: state,
        verdictReason: reason,
      };
    }

    // Rule 8: Default (evidence exists, partial match) -> COMPLEMENTARY, SATISFIED (at 0.85 weight)
    if (relatedEvidence.length > 0) {
      const state: ReconciliationState = 'COMPLEMENTARY';
      const verdict: ExpectationVerdict = 'SATISFIED';
      const reason = `Partial or complementary evidence observed with medium confidence.`;
      return {
        reconciliation: this.createRecord(changeId, workspaceId, expectation.expectationId, state, evidenceIds, conflictingEvidenceIds, reason),
        updatedVerdict: verdict,
        updatedState: state,
        verdictReason: reason,
      };
    }

    // Fallback: UNRESOLVED / UNOBSERVED
    const state: ReconciliationState = 'UNRESOLVED';
    const verdict: ExpectationVerdict = 'UNOBSERVED';
    const reason = `No conclusive evidence observed for expectation.`;
    return {
      reconciliation: this.createRecord(changeId, workspaceId, expectation.expectationId, state, evidenceIds, conflictingEvidenceIds, reason),
      updatedVerdict: verdict,
      updatedState: state,
      verdictReason: reason,
    };
  }

  private createRecord(
    changeId: ChangeId,
    workspaceId: string,
    expectationId: string,
    state: ReconciliationState,
    evidenceIds: string[],
    conflictingEvidenceIds: string[],
    explanation: string
  ): ReconciliationRecord {
    return {
      reconciliationId: `rec-${expectationId}`,
      expectationId,
      changeId,
      workspaceId,
      reconciledAt: new Date(),
      state,
      evidenceIds,
      conflictingEvidenceIds,
      explanation,
    };
  }
}
