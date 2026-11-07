/**
 * @file JavaPromotionReadiness.ts
 * Evaluates whether an advisory Java capability meets the prerequisites for
 * graduation into a future certified Java profile per casebgoal.md §Phase 10
 * and java_language_track_architecture.md §8 & §11.
 *
 * Strict boundary:
 *   - Current status is ALWAYS 'ADVISORY_ONLY'.
 *   - This is NOT a certification mechanism and NEVER bypasses VerdictAuthority.
 *   - Only signals review eligibility when all 7 certification criteria are met.
 */

import { JavaAdvisoryBenchmarkReport } from './JavaImpactAnalyzer';

export interface JavaCapabilityEvidence {
  readonly capabilityId: string;
  readonly sealedEvidence: boolean;
  readonly deterministicReplay: boolean;
  readonly independentlyVerifiableResolution: boolean;
  readonly completeConsumerCoverage: boolean;
  readonly explicitProofRules: boolean;
  readonly adversarialTests: boolean;
  readonly stableBenchmark: boolean;
  readonly benchmark?: JavaAdvisoryBenchmarkReport;
}

export interface JavaPromotionReadiness {
  readonly capabilityId: string;
  readonly currentStatus: 'ADVISORY_ONLY';
  readonly futureProfile: 'JAVA_CERTIFIED_REVIEW_ONLY';
  readonly readiness: 'NOT_READY' | 'ELIGIBLE_FOR_REVIEW';
  readonly missingRequirements: readonly string[];
  readonly benchmarkSummary: {
    readonly deterministicRepeatability: number;
    readonly falsePositiveRate: number | null;
    readonly falseNegativeRate: number | null;
    readonly unresolvedRate: number;
    readonly consumerDiscoveryRecall: number | null;
  } | null;
}

const JAVA_CERTIFICATION_REQUIREMENTS: ReadonlyArray<[keyof Omit<JavaCapabilityEvidence, 'capabilityId' | 'benchmark'>, string]> = [
  ['sealedEvidence', 'sealed evidence from immutable git snapshot'],
  ['deterministicReplay', 'bit-for-bit deterministic replay'],
  ['independentlyVerifiableResolution', 'independently verifiable FQCN symbol resolution'],
  ['completeConsumerCoverage', 'complete consumer coverage without missing bindings'],
  ['explicitProofRules', 'formal explicit proof rules for nominal type relations'],
  ['adversarialTests', 'adversarial test matrix validation'],
  ['stableBenchmark', 'stable benchmark results with zero false positives/negatives']
];

/**
 * Assesses readiness for eventual certified promotion review.
 * Never elevates to certified on its own.
 */
export function assessJavaPromotionReadiness(evidence: JavaCapabilityEvidence): JavaPromotionReadiness {
  const missingRequirements = JAVA_CERTIFICATION_REQUIREMENTS
    .filter(([key]) => !evidence[key])
    .map(([, label]) => label);

  const metrics = evidence.benchmark?.metrics;

  return {
    capabilityId: evidence.capabilityId,
    currentStatus: 'ADVISORY_ONLY',
    futureProfile: 'JAVA_CERTIFIED_REVIEW_ONLY',
    readiness: missingRequirements.length === 0 ? 'ELIGIBLE_FOR_REVIEW' : 'NOT_READY',
    missingRequirements,
    benchmarkSummary: metrics
      ? {
          deterministicRepeatability: metrics.deterministicRepeatability,
          falsePositiveRate: metrics.falsePositiveRate,
          falseNegativeRate: metrics.falseNegativeRate,
          unresolvedRate: metrics.unresolvedRate,
          consumerDiscoveryRecall: metrics.consumerDiscoveryRecall
        }
      : null
  };
}
