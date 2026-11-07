/**
 * SAJIMORA — V32 IMPACT ADAPTER TYPES
 *
 * Epistemic contract: Candidate scope != Structurally proven impact.
 * Candidate scope identifies where to look; V32 determines what can be proven.
 */

import { TargetKind, ImpactAnalysisResult } from '../types';
import { ProofObligation, ProofResult, AuthoritativeVerdict, UsageSite } from '@sajimora/core';

export interface CandidateScope {
  targetNode: string;
  targetKind?: TargetKind;
  targetSymbol?: string;
  targetPackage?: string;
  candidateFiles: string[];
  directDependents: string[];
  transitiveDependents: string[];
  affectedTests: string[];
  affectedRoutes: string[];
  affectedSchemas: string[];
  blastRadius: number;
  blockers?: Array<{ code: string; message: string; file?: string; files?: string[] }>;
}

export interface GroundedProofResult {
  target: string;
  candidateScope: CandidateScope;
  v32Verdict: AuthoritativeVerdict;
  provenImpactedFiles: string[];
  provenPreservedFiles: string[];
  uncertainFiles: string[];
  usageSites: UsageSite[];
  allClosureOccurrencesCount: number;
  inputUniverseCount: number;
  candidateUniverseCount: number;
  reductionPercentage: number;
  epistemicNote: string;
}

export interface CandidateNarrowingMetrics {
  inputUniverse: number;
  candidateUniverse: number;
  reduction: string;
  candidatePrioritizedTimeMs: number;
  baselineTimeMs: number;
  speedup: string;
  falseNegatives: 'NONE';
}
