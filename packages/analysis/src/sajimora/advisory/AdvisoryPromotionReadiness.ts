import { AdvisoryBenchmarkReport } from './AdvisoryValidationBenchmark';

export interface AdvisoryCapabilityEvidence {
  capabilityId: string;
  sealedEvidence: boolean;
  deterministicReplay: boolean;
  independentlyVerifiableResolution: boolean;
  completeConsumerCoverage: boolean;
  explicitProofRules: boolean;
  adversarialTests: boolean;
  stableBenchmark: boolean;
  benchmark?: AdvisoryBenchmarkReport;
}
export interface AdvisoryPromotionReadiness {
  capabilityId: string;
  currentStatus: 'ADVISORY_ONLY';
  futureProfile: 'F1_REVIEW_ONLY';
  readiness: 'NOT_READY' | 'ELIGIBLE_FOR_REVIEW';
  missingRequirements: readonly string[];
  benchmarkSummary: { deterministicRepeatability: number; falsePositiveRate: number | null; falseNegativeRate: number | null; unresolvedRate: number; } | null;
}

const requirements: ReadonlyArray<[keyof Omit<AdvisoryCapabilityEvidence, 'capabilityId' | 'benchmark'>, string]> = [
  ['sealedEvidence', 'sealed evidence'], ['deterministicReplay', 'deterministic replay'], ['independentlyVerifiableResolution', 'independently verifiable resolution'], ['completeConsumerCoverage', 'complete consumer coverage'], ['explicitProofRules', 'explicit proof rules'], ['adversarialTests', 'adversarial tests'], ['stableBenchmark', 'stable benchmark results']
];

/** This is deliberately not a certification mechanism or VerdictAuthority input. */
export function assessAdvisoryPromotionReadiness(evidence: AdvisoryCapabilityEvidence): AdvisoryPromotionReadiness {
  const missingRequirements = requirements.filter(([key]) => !evidence[key]).map(([, label]) => label);
  const metrics = evidence.benchmark?.metrics;
  return { capabilityId: evidence.capabilityId, currentStatus: 'ADVISORY_ONLY', futureProfile: 'F1_REVIEW_ONLY', readiness: missingRequirements.length ? 'NOT_READY' : 'ELIGIBLE_FOR_REVIEW', missingRequirements, benchmarkSummary: metrics ? { deterministicRepeatability: metrics.deterministicRepeatability, falsePositiveRate: metrics.falsePositiveRate, falseNegativeRate: metrics.falseNegativeRate, unresolvedRate: metrics.unresolvedRate } : null };
}
