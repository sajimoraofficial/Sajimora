/**
 * SAJIMORA V32 — ChangeVerdict Calculator
 * Subordinate to sajimora_v32_foundation_spec.md §3.3.4 & Final Implementation Plan.
 *
 * Computes deterministic ChangeVerdict strictly by priority order:
 * 1. Any BOUNDARY_VIOLATED -> BLOCK (unconditional)
 * 2. Any UNSATISFIED AND ecmConfidence > 0.8 -> BLOCK
 * 3. VCS >= 0.80 AND contradictions = 0 -> ALLOW
 * 4. VCS >= 0.55 AND contradictions = 0 AND boundary_violations = 0 -> WARN
 * 5. contradictions > 0 AND no BOUNDARY_VIOLATED -> CLARIFY
 * 6. VCS < 0.40 AND total_expectations > 0 -> INSUFFICIENT_EVIDENCE
 * 7. Default (0.40 <= VCS < 0.55 or mixed) -> WARN
 *
 * Note: ChangeVerdict is an evidence/reconciliation result for a proposed change.
 * It is distinct from the full repository-level Legitimacy Gate (Phase 2/3).
 */

import { ChangeVerdict, ExpectationRecord } from '../types';

export interface VerdictCalculationInput {
  vcs: number;
  expectations: ExpectationRecord[];
  boundaryViolations: number;
  contradictions: number;
  ecmConfidence: number;
}

export interface VerdictCalculationResult {
  verdict: ChangeVerdict;
  verdictReason: string;
}

export function computeChangeVerdict(input: VerdictCalculationInput): VerdictCalculationResult {
  const { vcs, expectations, boundaryViolations, contradictions, ecmConfidence } = input;
  const totalExpectations = expectations.length;

  // Rule 1: Any BOUNDARY_VIOLATED -> BLOCK (unconditional)
  if (boundaryViolations > 0) {
    return {
      verdict: 'BLOCK',
      verdictReason: `Change violates ${boundaryViolations} declared boundary path constraints. Boundary violations block unconditionally.`,
    };
  }

  // Rule 2: Any UNSATISFIED AND ecmConfidence > 0.8 -> BLOCK
  const highConfidenceUnsatisfied = expectations.some(
    (e) => e.verdict === 'UNSATISFIED' && e.ecmConfidence > 0.8
  );
  if (highConfidenceUnsatisfied) {
    return {
      verdict: 'BLOCK',
      verdictReason: 'High-confidence expectation (ecmConfidence > 0.8) was UNSATISFIED by the actual change.',
    };
  }

  // Rule 3: VCS >= 0.80 AND contradictions = 0 -> ALLOW
  if (vcs >= 0.80 && contradictions === 0) {
    return {
      verdict: 'ALLOW',
      verdictReason: `VCS of ${vcs.toFixed(4)} meets ALLOW threshold (>= 0.80) with zero contradictions.`,
    };
  }

  // Rule 4: VCS >= 0.55 AND contradictions = 0 AND boundary_violations = 0 -> WARN
  if (vcs >= 0.55 && contradictions === 0 && boundaryViolations === 0) {
    return {
      verdict: 'WARN',
      verdictReason: `VCS of ${vcs.toFixed(4)} meets baseline threshold (>= 0.55) with zero contradictions; warnings present.`,
    };
  }

  // Rule 5: contradictions > 0 AND no BOUNDARY_VIOLATED -> CLARIFY
  if (contradictions > 0 && boundaryViolations === 0) {
    return {
      verdict: 'CLARIFY',
      verdictReason: `${contradictions} contradiction(s) detected between expectations and actual change. Clarification required.`,
    };
  }

  // Rule 6: VCS < 0.40 AND total_expectations > 0 -> INSUFFICIENT_EVIDENCE
  if (vcs < 0.40 && totalExpectations > 0) {
    return {
      verdict: 'INSUFFICIENT_EVIDENCE',
      verdictReason: `VCS of ${vcs.toFixed(4)} is below minimum evidence threshold (< 0.40). Honest absence of proof.`,
    };
  }

  // Rule 7: Default (0.40 <= VCS < 0.55 or mixed) -> WARN
  return {
    verdict: 'WARN',
    verdictReason: `VCS of ${vcs.toFixed(4)} falls in intermediate range (0.40 <= VCS < 0.55).`,
  };
}
