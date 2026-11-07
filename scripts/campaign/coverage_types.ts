/**
 * @file coverage_types.ts
 * Shared types and helpers for Sajimora TypeScript Semantic Coverage Specification v1.
 */

export interface CoverageQuery {
  id: string;
  tier: number;
  level: 'L1_SINGLE' | 'L2_PAIRWISE' | 'L3_THREE_WAY' | 'L4_FOUR_WAY' | 'L5_HIGH_RISK';
  family: string;
  features: string[];
  description: string;
  parentFiles: Record<string, string>;
  candidateFiles: Record<string, string>;
  expectedVerdict: 'PRESERVED' | 'VIOLATED' | 'UNKNOWN' | 'NOT_APPLICABLE';
  expectedTsError?: number;
  staticProvable: boolean;
}

export interface CoverageResult {
  id: string;
  tier: number;
  level: string;
  family: string;
  features: string[];
  expectedVerdict: string;
  actualVerdict: string;
  certificationStatus?: string;
  match: boolean;
  verdictDetails: {
    totalObligations: number;
    preserved: number;
    violated: number;
    unknown: number;
    notApplicable: number;
  };
  conservation?: {
    generatedObligations: number;
    accountedObligations: number;
    unaccountedObligations: number;
    silentDrops: number;
    satisfied: boolean;
  };
  discovery?: {
    candidateReferences: number;
    confirmedConsumers: number;
    unresolvedPotentialConsumers: number;
  };
  environmentFailures?: Record<string, number>;
  error?: string;
  durationMs: number;
}
