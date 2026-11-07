/**
 * SAJIMORA V32 — Change Intelligence Domain Types
 * Subordinate to sajimora_v32_foundation_spec.md (Frozen Contract Candidate).
 *
 * Core domain contracts for:
 * 1. Expected Change Model (ECM)
 * 2. AST Structural Diff Engine
 * 3. Change-Scoped Evidence Ledger & Reconciliation
 *
 * All types are deterministic, repository-agnostic, and language-agnostic.
 * Zero ML / Zero LLM / Zero framework-specific constants.
 */

// ── 1. Expected Change Model (ECM) Types ─────────────────────────────────────

export type ChangeId = string; // SHA-256 hex of workspaceId:baseCommitSha:candidateCommitSha

export type ExpectationProvenance =
  | 'DEVELOPER_DECLARED'      // Explicit structured input
  | 'COMMIT_MESSAGE_PARSED'   // Deterministic extraction from commit message
  | 'PR_DESCRIPTION_PARSED'   // Deterministic extraction from PR description
  | 'INFERRED_FROM_HISTORY'   // Derived from co-evolution patterns
  | 'INFERRED_FROM_STRUCTURE' // Derived from structural impact of declared changes
  | 'UNKNOWN';                // Source unknown; confidence capped at 0.3

export type ExpectationConfidence = number; // 0.0 to 1.0

export interface ExpectedFileChange {
  filePath: string;           // workspace-relative POSIX path
  changeType: 'ADDED' | 'MODIFIED' | 'DELETED' | 'RENAMED';
  oldFilePath?: string;
  provenance: ExpectationProvenance;
  confidence: ExpectationConfidence;
}

export type SymbolKind =
  | 'FUNCTION'
  | 'CLASS'
  | 'INTERFACE'
  | 'TYPE_ALIAS'
  | 'ENUM'
  | 'CONSTANT'
  | 'OTHER';

export interface ExpectedSymbolChange {
  filePath: string;
  symbolName: string;
  symbolKind?: SymbolKind;
  changeType: 'ADDED' | 'REMOVED' | 'RENAMED' | 'SIGNATURE_CHANGED';
  oldSymbolName?: string;
  oldSignature?: string;      // sanitized - no raw source
  newSignature?: string;      // sanitized - no raw source
  provenance: ExpectationProvenance;
  confidence: ExpectationConfidence;
}

export interface ExpectedEdgeChange {
  sourceFilePath: string;
  targetFilePath: string;
  edgeKind: string;           // V31 EdgeKind vocabulary - no hardcoded values
  changeType: 'ADDED' | 'REMOVED';
  provenance: ExpectationProvenance;
  confidence: ExpectationConfidence;
}

export interface ExpectedBehavioralObligation {
  obligationId: string;
  description: string;
  verificationStrategy: 'STRUCTURAL_AST' | 'GRAPH_TRAVERSAL' | 'GIT_HISTORY' | 'VCS_HISTORY' | 'INSUFFICIENT';
  targetEntities: string[];
  contentHints: string[];
  provenance: ExpectationProvenance;
  confidence: ExpectationConfidence;
}

export interface ExpectedInvariantTransition {
  invariantDescription: string;
  expectedState: 'PRESERVED' | 'INTENTIONALLY_EVOLVED' | 'NEWLY_ESTABLISHED';
  evolutionReason?: string;   // Required when INTENTIONALLY_EVOLVED
  provenance: ExpectationProvenance;
  confidence: ExpectationConfidence;
}

export interface ChangeBoundary {
  forbiddenPaths: string[];   // Exact prefix match ONLY. No glob, no regex.
  reason: string;
  provenance: ExpectationProvenance;
}

export type EcmSource = 'STRUCTURED_INPUT' | 'SEMI_STRUCTURED_TEXT' | 'INFERRED';

export interface ExpectedChangeModel {
  changeId: ChangeId;
  workspaceId: string;
  baseCommitSha: string;
  candidateCommitSha: string; // Required per resolved decision OQ-4
  createdAt: Date;
  ecmSource: EcmSource;
  expectedFiles: ExpectedFileChange[];
  expectedSymbols: ExpectedSymbolChange[];
  expectedEdges: ExpectedEdgeChange[];
  expectedBehavioralObligations: ExpectedBehavioralObligation[];
  expectedInvariantTransitions: ExpectedInvariantTransition[];
  changeBoundary: ChangeBoundary | null;
  overallConfidence: number;  // unweighted mean; capped at 0.5 when ecmSource=INFERRED
  validationStatus: 'VALID' | 'INVALID' | 'PARTIAL';
  validationErrors: string[];
  baseRevisionId?: string;    // VCS-agnostic alias for baseCommitSha
  candidateRevisionId?: string; // VCS-agnostic alias for candidateCommitSha
}

// ── 2. AST Structural Diff Engine Types ───────────────────────────────────────

export interface ChangedFile {
  filePath: string;             // workspace-relative POSIX path
  changeType: 'ADDED' | 'MODIFIED' | 'DELETED' | 'RENAMED';
  oldFilePath?: string;
}

export type GitChangedFile = ChangedFile; // Backward compatibility alias

export type DiffConfidence = 'DETERMINISTIC' | 'PARTIAL' | 'UNPARSEABLE';

export interface SymbolDelta {
  changeType: 'ADDED' | 'REMOVED' | 'RENAMED' | 'SIGNATURE_CHANGED';
  symbolName: string;
  symbolKind: SymbolKind;
  oldSymbolName?: string;       // RENAMED only
  oldSignature?: string;        // SIGNATURE_CHANGED only (sanitized)
  newSignature?: string;        // SIGNATURE_CHANGED only (sanitized)
  startLine?: number;           // From AFTER state; absent when REMOVED
  endLine?: number;
}

export interface ImportDelta {
  changeType: 'ADDED' | 'REMOVED';
  moduleSpecifier: string;
  resolvedTarget: string | 'EXTERNAL' | 'UNRESOLVED';
}

export interface ExportDelta {
  changeType: 'ADDED' | 'REMOVED';
  exportedName: string;
}

export interface FileDelta {
  filePath: string;             // workspace-relative POSIX path
  fileChangeType: 'ADDED' | 'MODIFIED' | 'DELETED' | 'RENAMED' | 'UNCHANGED';
  oldFilePath?: string;
  symbolDeltas: SymbolDelta[];
  importDeltas: ImportDelta[];
  exportDeltas: ExportDelta[];
  diffConfidence: DiffConfidence;
  confidenceReasons: string[];  // empty when DETERMINISTIC
}

export interface ChangeSetSummary {
  totalFilesChanged: number;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  filesRenamed: number;
  symbolsAdded: number;
  symbolsRemoved: number;
  symbolsRenamed: number;
  symbolsSignatureChanged: number;
  importsAdded: number;
  importsRemoved: number;
  exportsAdded: number;
  exportsRemoved: number;
  deterministicFileCount: number;
  partialFileCount: number;
  unparseableFileCount: number;
}

export interface ChangeSetDelta {
  changeId: ChangeId;
  workspaceId: string;
  baseCommitSha: string;
  candidateCommitSha: string;
  computedAt: Date;
  fileDeltas: FileDelta[];      // stable sort by filePath
  summary: ChangeSetSummary;
  overallConfidence: DiffConfidence;
}

// ── 3. Change-Scoped Evidence Ledger Types ───────────────────────────────────

export type EvidenceSourceType =
  | 'AST_STRUCTURAL'       // From ChangeSetDelta (Component 2)
  | 'GRAPH_EDGE'           // From V31 EdgeGenerator / GraphStorageProvider
  | 'GIT_HISTORICAL'       // From GitIntelligenceService / RegressionTracker
  | 'VCS_HISTORICAL'       // VCS-agnostic history / RegressionTracker
  | 'IMPACT_TRAVERSAL'     // From V31 ImpactAnalyzer
  | 'BOUNDARY_VIOLATION'   // From ECM.changeBoundary check
  | 'RUNTIME'              // RESERVED - V33 only. Rejected in Phase 1.
  | 'INVARIANT_TRANSITION' // RESERVED - Phase 3 only. Rejected in Phase 1.
  | 'DECLARED';            // From ECM (developer-declared)

export type DerivationMethod =
  | 'AST_PARSE_DIFF'
  | 'GRAPH_TRAVERSAL'
  | 'GIT_LOG_QUERY'
  | 'VCS_LOG_QUERY'
  | 'BLAST_RADIUS_TRAVERSAL'
  | 'PATH_PREFIX_MATCH'
  | 'DIRECT_DECLARATION'
  | 'UNKNOWN';             // confidence capped at 0.3

export type ReconciliationState =
  | 'CONSISTENT'
  | 'COMPLEMENTARY'
  | 'CONTRADICTORY'
  | 'INSUFFICIENT'
  | 'UNRESOLVED';

export type ExpectationVerdict =
  | 'SATISFIED'
  | 'UNSATISFIED'
  | 'BOUNDARY_VIOLATED'
  | 'UNOBSERVED'
  | 'INSUFFICIENT_EVIDENCE';

export type ChangeVerdict =
  | 'ALLOW'
  | 'WARN'
  | 'CLARIFY'
  | 'BLOCK'
  | 'INSUFFICIENT_EVIDENCE';

export interface EvidenceEntry {
  evidenceId: string;       // SHA-256(changeId:sourceType:entityId:derivationMethod)
  changeId: ChangeId;
  workspaceId: string;
  entityId: string;
  entityType: 'FILE' | 'SYMBOL' | 'IMPORT_EDGE' | 'EXPORT' | 'GRAPH_EDGE' | 'CHANGE_SET' | 'BOUNDARY';
  observation: string;      // CLOSED vocabulary only. No free-form text.
  sourceType: EvidenceSourceType;
  derivationMethod: DerivationMethod;
  observedAt: Date;
  observationWindow: {
    kind: 'COMMIT_RANGE' | 'REVISION_RANGE' | 'TIME_RANGE' | 'POINT_IN_TIME';
    from: string;
    to: string;
  };
  confidence: number;
  structuralConfidence?: DiffConfidence;
  relatedExpectationIds: string[];    // Must be non-empty (LED-R2)
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}

export interface ExpectationRecord {
  expectationId: string;
  changeId: ChangeId;
  workspaceId: string;
  expectationType: 'FILE_CHANGE' | 'SYMBOL_CHANGE' | 'EDGE_CHANGE' | 'BEHAVIORAL_OBLIGATION' | 'INVARIANT_TRANSITION';
  description: string;
  ecmConfidence: number;
  ecmProvenance: ExpectationProvenance;
  collectedEvidenceIds: string[];
  reconciliationState: ReconciliationState;
  verdict: ExpectationVerdict;
  verdictReason: string;    // Deterministic, machine-generated
}

export interface ReconciliationRecord {
  reconciliationId: string;
  expectationId: string;
  changeId: ChangeId;
  workspaceId: string;
  reconciledAt: Date;
  state: ReconciliationState;
  evidenceIds: string[];
  conflictingEvidenceIds: string[];
  explanation: string;      // Deterministic
}

export interface EvidenceGapRecord {
  gapId: string;
  expectationId: string;
  changeId: ChangeId;
  workspaceId: string;
  detectedAt: Date;
  missingEvidenceType: EvidenceSourceType;
  missingFact: string;      // Must be specific enough to act on
  bounded: boolean;
  boundedExperiment?: {
    action: string;
    requiredInput: string;
    expectedOutput: string;
    acquisitionMethod: DerivationMethod;
  };
}

export interface ChangeEvidenceLedger {
  changeId: ChangeId;
  workspaceId: string;
  baseCommitSha: string;
  candidateCommitSha: string;
  createdAt: Date;
  lastUpdatedAt: Date;
  status: 'OPEN' | 'RECONCILING' | 'CLOSED' | 'FAILED';
  failureReason?: string;
  ecmSource: EcmSource;
  ecmConfidence: number;
  expectations: ExpectationRecord[];
  evidence: EvidenceEntry[];
  reconciliations: ReconciliationRecord[];
  gaps: EvidenceGapRecord[];
  vcs: number;              // Verification Confidence Score (0.0 when status != CLOSED)
  counts: {
    totalExpectations: number;
    satisfied: number;
    unsatisfied: number;
    boundaryViolations: number;
    unobserved: number;
    insufficientEvidence: number;
    totalEvidenceEntries: number;
    deterministicEntries: number;
    contradictions: number;
    gaps: number;
  };
  verdict: ChangeVerdict | null;    // null until CLOSED
  verdictReason: string;
  verdictComputedAt: Date | null;
}
