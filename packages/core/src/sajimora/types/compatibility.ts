import {
  CompatibilityProofEvidence,
  IncompatibleEvidence,
  UndecidableEvidence
} from './proofTree';

export type CompatibilityReason = 
  | 'REQUIRED_PARAMETER_ADDED'
  | 'PARAMETER_TYPE_CHANGED_INCOMPATIBLE'
  | 'SYMBOL_DELETED'
  | 'VISIBILITY_NARROWED'
  | 'INTERFACE_CONTRACT_BROKEN'
  | 'UNDECIDABLE_OVERLOAD_RESOLUTION'
  | 'UNDECIDABLE_RETURN_VARIANCE'
  | 'OMITTED_HISTORICAL_CONSUMER'
  | 'EXCLUDED_SITE_IDENTITY_UNVERIFIED'
  | 'PHASE4_PREREQUISITES_UNAVAILABLE'
  | 'PHASE4_COVERAGE_GAP'
  | 'INVALID_PROOF_TREE'
  | 'HISTORICAL_EXPECTATION_UNRECOVERABLE'
  | 'RETURN_OBLIGATION_REQUIRES_DOWNSTREAM_ANALYSIS'
  | 'PRIVATE_MEMBER_ORIGIN_MISMATCH'
  | 'EXCESS_PROPERTY_REJECTED'
  | 'REQUIRED_PROPERTY_MISSING'
  | 'DEPTH_BUDGET_EXCEEDED'
  | 'WORK_BUDGET_EXCEEDED'
  | string;

export type CompatibilityResult =
  | { status: 'COMPATIBLE'; reason: null; phase4Evidence?: CompatibilityProofEvidence }
  | { status: 'INCOMPATIBLE'; reason: CompatibilityReason; phase4Evidence?: IncompatibleEvidence }
  | { status: 'UNDECIDABLE'; reason: CompatibilityReason | null; phase4Evidence?: UndecidableEvidence };
