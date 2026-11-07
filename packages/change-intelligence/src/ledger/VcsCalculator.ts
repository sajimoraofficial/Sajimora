/**
 * SAJIMORA V32 — Verification Confidence Score (VCS) Calculator
 * Subordinate to sajimora_v32_foundation_spec.md §3.3.3.
 *
 * Closed-form deterministic score calculation. Zero ML / Zero LLM.
 */

export interface VcsInputCounts {
  totalExpectations: number;
  satisfiedCount: number;
  complementarySatisfiedCount: number;
  unsatisfiedCount: number;
  boundaryViolatedCount: number;
  contradictoryCount: number;
  totalEvidenceEntries: number;
  deterministicEvidenceEntries: number;
}

export function computeVcsScore(counts: VcsInputCounts): number {
  if (counts.totalExpectations === 0) {
    return 0.0;
  }

  // 1. BASE_SCORE
  const baseScore =
    (counts.satisfiedCount + counts.complementarySatisfiedCount * 0.85) /
    counts.totalExpectations;

  // 2. CONFIDENCE_WEIGHT
  let confidenceWeight = 0.70;
  if (counts.totalEvidenceEntries > 0) {
    const ratio = counts.deterministicEvidenceEntries / counts.totalEvidenceEntries;
    if (ratio >= 0.80) {
      confidenceWeight = 1.00;
    } else if (ratio >= 0.50) {
      confidenceWeight = 0.90;
    } else {
      confidenceWeight = 0.70;
    }
  }

  // 3. PENALTY
  // Unsatisfied non-boundary count
  const nonBoundaryUnsatisfied = Math.max(
    0,
    counts.unsatisfiedCount - counts.boundaryViolatedCount
  );
  const penalty =
    0.15 * counts.boundaryViolatedCount +
    0.10 * counts.contradictoryCount +
    0.05 * nonBoundaryUnsatisfied;

  // 4. VCS calculation & clamping
  const rawVcs = baseScore * confidenceWeight - penalty;
  const clamped = Math.max(0.0, Math.min(1.0, rawVcs));

  return Number(clamped.toFixed(4));
}
