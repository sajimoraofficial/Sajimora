import { AdvisoryImpactResult, AdvisoryVerdict } from './TypeScriptImpactAnalyzer';

/** Input envelope supplied by the frozen certified path; this module never evaluates it. */
export type CertifiedVerdict = 'PRESERVED' | 'VIOLATED' | 'NOT_APPLICABLE' | 'UNKNOWN';
export interface CertifiedOutcome { verdict: CertifiedVerdict; reason: string; evidenceReferences?: readonly string[]; }
export interface ReconciliationConflict { certifiedVerdict: CertifiedVerdict; advisoryVerdict: AdvisoryVerdict; reason: string; }
export interface ReconciledImpactResult {
  certified: CertifiedOutcome;
  advisory: AdvisoryImpactResult;
  final: { certificationStatus: 'CERTIFIED'; verdict: CertifiedVerdict; advisoryFinding: AdvisoryVerdict | null; conflict: ReconciliationConflict | null; };
}

const conflicts = (certified: CertifiedVerdict, advisory: AdvisoryVerdict) =>
  (certified === 'PRESERVED' && advisory === 'LIKELY_VIOLATED') ||
  (certified === 'VIOLATED' && advisory === 'LIKELY_PRESERVED');

/**
 * Phase 7 policy.  It is deliberately a one-way presentation reconciliation:
 * advisory evidence never becomes a certified verdict and never calls authority code.
 */
export function reconcileAdvisoryResult(certified: CertifiedOutcome, advisory: AdvisoryImpactResult): ReconciledImpactResult {
  if (conflicts(certified.verdict, advisory.verdict)) {
    return { certified, advisory, final: { certificationStatus: 'CERTIFIED', verdict: 'UNKNOWN', advisoryFinding: advisory.verdict, conflict: { certifiedVerdict: certified.verdict, advisoryVerdict: advisory.verdict, reason: 'Certified and advisory conclusions conflict; final certified result is fail-closed UNKNOWN.' } } };
  }
  if (certified.verdict === 'UNKNOWN') {
    return { certified, advisory, final: { certificationStatus: 'CERTIFIED', verdict: 'UNKNOWN', advisoryFinding: advisory.verdict, conflict: null } };
  }
  return { certified, advisory, final: { certificationStatus: 'CERTIFIED', verdict: certified.verdict, advisoryFinding: advisory.verdict, conflict: null } };
}
