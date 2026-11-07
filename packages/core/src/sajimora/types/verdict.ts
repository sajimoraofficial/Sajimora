export type AuthoritativeVerdict = 
  | 'VIOLATED'
  | 'PRESERVED'
  | 'UNKNOWN'
  | 'INSUFFICIENT_EVIDENCE'
  | 'NOT_APPLICABLE';

export type InternalVerdictReason = 
  | 'NO_STRUCTURAL_TRIGGER'
  | 'STRUCTURAL_TRIGGER_NO_CONSUMERS';

export interface ProofResult {
  verdict: AuthoritativeVerdict;
  internalReason?: InternalVerdictReason;
  /** Additive diagnostic output. It has no role in verdict evaluation. */
  auditTrace?: AuthoritativeAuditTrace;
}

export type AuthorityDecisionReason =
  | 'INCOMPATIBLE_CONSUMER'
  | 'DISCOVERY_FAILURE'
  | 'PARSE_FAILURE'
  | 'UNREADABLE_INPUT'
  | 'MISSING_ANALYSIS_UNIVERSE'
  | 'INCOMPLETE_CLOSURE'
  | 'UNSUPPORTED_SEMANTIC_SCOPE'
  | 'UNCERTAIN_IDENTITY'
  | 'UNDECIDABLE_COMPATIBILITY'
  | 'STRUCTURAL_TRIGGER_NO_CONSUMERS'
  | 'ALL_EVALUABLE_COMPATIBLE'
  | 'UNKNOWN_FALLTHROUGH'
  | 'ENGINE_RUNTIME_FAILURE';

/**
 * A lossless-at-the-boundary snapshot of evidence already provided to the
 * authority.  This is deliberately observational: no field is used to make
 * a verdict and callers may ignore it.
 */
export interface AuthoritativeAuditTrace {
  authorityDecision: {
    source: 'VERDICT_AUTHORITY' | 'PIPELINE_RUNTIME' | 'PRODUCTION_CERTIFIER';
    gate: string;
    reason: AuthorityDecisionReason;
    stage: string;
  };
  discovery?: unknown;
  target?: unknown;
  mutation?: unknown;
  consumers?: unknown[];
  rawOccurrences?: unknown[];
  proofDiagnostics?: unknown;
  closures?: Record<string, unknown>;
  identity?: unknown[];
  compatibility?: Array<{ usageSiteId: string; result: unknown }>;
  semanticScope?: unknown;
  runtimeFailure?: { name: string; message: string };
}
