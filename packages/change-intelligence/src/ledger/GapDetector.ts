/**
 * SAJIMORA V32 — Evidence Gap Detector
 * Subordinate to sajimora_v32_foundation_spec.md §3.2 & §3.5 (LED-R6).
 *
 * Identifies unverified expectations and constructs actionable EvidenceGapRecords.
 * Rejects vague placeholders per LED-R6 ("Evidence not found", "No data", "Insufficient").
 */

import { ChangeId, EvidenceGapRecord, EvidenceSourceType, ExpectationRecord } from '../types';

export class GapDetector {
  /**
   * Detects evidence gaps for an expectation.
   */
  detectGap(
    changeId: ChangeId,
    workspaceId: string,
    expectation: ExpectationRecord
  ): EvidenceGapRecord | null {
    if (expectation.verdict === 'SATISFIED' || expectation.verdict === 'BOUNDARY_VIOLATED') {
      return null;
    }

    let missingType: EvidenceSourceType = 'AST_STRUCTURAL';
    let missingFact = '';
    let bounded = true;

    switch (expectation.expectationType) {
      case 'FILE_CHANGE':
        missingType = 'AST_STRUCTURAL';
        missingFact = `Observed AST or Git delta for file "${expectation.description}" was not found or was UNPARSEABLE.`;
        break;
      case 'SYMBOL_CHANGE':
        missingType = 'AST_STRUCTURAL';
        missingFact = `Symbol definition or signature mutation matching "${expectation.description}" was absent from actual AST parse.`;
        break;
      case 'EDGE_CHANGE':
        missingType = 'GRAPH_EDGE';
        missingFact = `Expected dependency import or reference edge "${expectation.description}" was not observed in AST imports.`;
        break;
      case 'BEHAVIORAL_OBLIGATION':
        missingType = 'GIT_HISTORICAL';
        missingFact = `Behavioral obligation "${expectation.description}" lacks structural AST or historical commit proof.`;
        bounded = false;
        break;
      case 'INVARIANT_TRANSITION':
        // Handled purely as schema data in Phase 1
        missingType = 'DECLARED';
        missingFact = `Invariant transition "${expectation.description}" is declared in ECM but unverified by static AST evidence.`;
        bounded = false;
        break;
      default:
        missingType = 'AST_STRUCTURAL';
        missingFact = `Expectation "${expectation.description}" was unobserved in actual change-scoped evidence.`;
        break;
    }

    const gapId = `gap-${expectation.expectationId}`;

    return {
      gapId,
      expectationId: expectation.expectationId,
      changeId,
      workspaceId,
      detectedAt: new Date(),
      missingEvidenceType: missingType,
      missingFact,
      bounded,
    };
  }
}
