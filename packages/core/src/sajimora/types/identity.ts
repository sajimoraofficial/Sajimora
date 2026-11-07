export type IdentityResolution =
  | 'SAME'
  | 'RENAMED'
  | 'MUTATED'
  | 'NEW'
  | 'DELETED'
  | 'IDENTITY_UNCERTAIN';

/** Diagnostic state of one obligation; never a substitute for identity proof. */
export interface ObligationProofStatus {
  parentDeclarationId: string | null;
  parentBindingEvidenceId: string | null;
  candidateCorrespondence: 'PROVEN' | 'UNPROVEN' | 'AMBIGUOUS';
  completeness: 'COMPLETE' | 'INCOMPLETE';
  blockers: string[];
}

export interface CanonicalSiteProofStatus {
  occurrenceId: string;
  coverage: 'PROVEN' | 'BLOCKED';
  identity: 'PROVEN' | 'UNPROVEN' | 'AMBIGUOUS';
  semanticScope: 'PROVEN' | 'BLOCKED';
  compatibility: 'PROVEN' | 'BLOCKED' | 'NOT_EVALUATED';
  blockers: string[];
}

export type CrossVersionSymbolStatus =
  | 'SAME_DECLARATION' | 'MOVED_DECLARATION' | 'RENAMED_DECLARATION'
  | 'ADDED_DECLARATION' | 'REMOVED_DECLARATION' | 'AMBIGUOUS' | 'UNRESOLVED';

export interface CanonicalSymbolIdentity {
  identityId: string;
  projectId: string;
  moduleIdentity: string;
  ownerChain: string[];
  localName: string;
  declarationKind: string;
  declarationOrdinal: number;
  sourceSpan: { start: number; end: number; line: number; column: number; endLine: number; endColumn: number };
  exportPaths: string[];
  parameterShape: string;
  astFingerprint: string;
}

export interface IdentityEvidence {
  evidenceId: string;
  kind: 'DIFF_CORRESPONDENCE' | 'DECLARATION_KIND' | 'OWNER_CHAIN' | 'EXPORT_PATH'
    | 'PARAMETER_SHAPE' | 'AST_FINGERPRINT' | 'ENCLOSING_DECLARATION'
    | 'SYNTAX_ROLE' | 'TARGET_BINDING' | 'AST_NEIGHBORHOOD' | 'CONTEXT_POSITION'
    | 'MISSING_EVIDENCE';
  parentLocation?: { file: string; line: number; column: number };
  candidateLocation?: { file: string; line: number; column: number };
  detail: string;
}

export interface CrossVersionSymbolMapping {
  parent?: CanonicalSymbolIdentity;
  candidate?: CanonicalSymbolIdentity;
  status: CrossVersionSymbolStatus;
  evidence: IdentityEvidence[];
  plausibleCandidateIds: string[];
}

export type ConsumerLifecycle = 'STABLE_UNCHANGED' | 'STABLE_CHANGED_SAME_COMMIT'
  | 'ADDED_IN_CANDIDATE' | 'REMOVED_IN_CANDIDATE' | 'BINDING_REMOVED_IN_CANDIDATE'
  | 'AMBIGUOUS_ACROSS_VERSIONS';

export interface CrossVersionConsumerMapping {
  mappingId: string;
  lifecycle: ConsumerLifecycle;
  parentOccurrenceId?: string;
  candidateOccurrenceId?: string;
  targetIdentity: 'SAME' | 'DIFFERENT' | 'UNCERTAIN';
  evidence: IdentityEvidence[];
}

export interface CrossVersionIdentityBundle {
  targetMappings: CrossVersionSymbolMapping[];
  consumerMappings: CrossVersionConsumerMapping[];
  status: 'COMPLETE' | 'INCOMPLETE';
  blockers: string[];
  phaseOutcome: { verdict: 'UNKNOWN'; reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' };
  boundaryAudit: { compilerObjectsInArtifact: number; crossProgramCompilerObjectComparisons: 0 };
  certifiedCorrespondences?: CertifiedDeclarationCorrespondence[];
}

/** A proposed correspondence, never a verdict. Its digest is checked against sealed revisions. */
export interface CertifiedDeclarationCorrespondence {
  schemaVersion: string;
  parentEnvironmentDigest: string;
  candidateEnvironmentDigest: string;
  parentFileDigest: string;
  candidateFileDigest: string;
  parent: CanonicalSymbolIdentity;
  candidate: CanonicalSymbolIdentity;
  diffEvidence: {
    parentChangedStart: number;
    parentChangedEnd: number;
    candidateChangedStart: number;
    candidateChangedEnd: number;
    parentChangedDigest: string;
    candidateChangedDigest: string;
  };
  diffDigest: string;
  digest: string;
}
