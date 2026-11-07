/**
 * @file contracts.ts
 * Strictly repository-agnostic and language-agnostic production verification core contracts.
 * 
 * Formal pipeline & Stable Provenance Chain:
 * Repository (repositoryId)
 *   -> Project (projectId)
 *     -> Resolution (resolutionId)
 *       -> SymbolIdentity (identityId)
 *         -> Reference / Boundary (referenceId)
 *           -> VerificationObligation (obligationId)
 *             -> VerificationEvidence (evidenceId)
 *               -> VerificationVerdict (verdictId)
 * 
 * Guarantees:
 * - Zero repository, framework, or language hardcoding in core.
 * - Separation of coverage from epistemic assurance.
 * - Separation of API compatibility, consumer compatibility, and behavioral equivalence.
 * - Conservation of obligations with zero silent drops at every stage.
 */

export interface VirtualFileDescriptor {
  path: string;
  byteLength: number;
  hash: string;
  isExecutable?: boolean;
  isSymlink?: boolean;
}

export interface GenericRepositorySnapshot {
  snapshotId: string;
  rootIdentifier: string;
  files: readonly VirtualFileDescriptor[];
  omittedBinaryPaths?: readonly string[];
  readTextFile(path: string): string | undefined;
  readBinaryFile(path: string): Uint8Array | undefined;
}

export interface GenericRepository {
  repositoryId: string;
  parentSnapshot: GenericRepositorySnapshot;
  candidateSnapshot: GenericRepositorySnapshot;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface GenericProject {
  projectId: string;
  rootDirectory: string;
  configFile?: string;
  sourceFiles: readonly string[];
  projectReferences: readonly string[];
  options?: Readonly<Record<string, unknown>>;
}

export interface GenericProjectGraph {
  graphId: string;
  projects: readonly GenericProject[];
  edges: ReadonlyArray<{ fromProjectId: string; toProjectId: string }>;
}

export interface AsymmetricProjectMapping {
  matched: ReadonlyArray<{ parentProjectId: string; candidateProjectId: string }>;
  added: readonly GenericProject[];
  deleted: readonly GenericProject[];
}

export interface ResolutionFact {
  resolutionId: string;
  projectId: string;
  importerFile: string;
  importSpecifier: string;
  resolvedTargetFile?: string;
  isExternal: boolean;
  isDynamic: boolean;
  resolutionChain?: readonly string[];
  usageMode?: 'value' | 'type-only' | 'ambient';
  resolverVersion?: string;
  effectiveCompilerOptions?: Readonly<Record<string, unknown>>;
  failedLookupCandidates?: readonly string[];
  successfulLookupCandidate?: string;
  selectedFileHash?: string;
  consultedManifests?: readonly string[];
}

export type SemanticEntityKind =
  | 'FUNCTION'
  | 'METHOD'
  | 'CONSTRUCTOR'
  | 'CLASS'
  | 'INTERFACE'
  | 'TYPE_ALIAS'
  | 'VARIABLE'
  | 'CONSTANT'
  | 'MODULE'
  | 'NAMESPACE'
  | 'ENUM'
  | 'CUSTOM';

export interface SemanticEntity {
  entityId: string;
  projectId: string;
  name: string;
  kind: SemanticEntityKind;
  qualifiedName: string;
  containerId?: string;
  filePath: string;
  signatureFingerprint: string;
  isExported: boolean;
  metadata?: Readonly<Record<string, unknown>>;
}

export type IdentityStatus =
  | 'CONFIRMED_IDENTITY'
  | 'AMBIGUOUS_IDENTITY'
  | 'UNRESOLVED_IDENTITY';

export interface CrossVersionIdentity {
  identityId: string;
  status: IdentityStatus;
  parentEntity?: SemanticEntity;
  candidateEntity?: SemanticEntity;
  confidence: 'CERTAIN' | 'HEURISTIC' | 'NONE';
  lineageEvidence?: Readonly<Record<string, unknown>>;
  ambiguityReasons?: readonly string[];
}

export type SemanticChangeKind =
  | 'ADDED'
  | 'DELETED'
  | 'UNCHANGED'
  | 'SIGNATURE_EXPANDED'
  | 'SIGNATURE_NARROWED'
  | 'BODY_MUTATED'
  | 'TYPE_DEFINITION_CHANGED'
  | 'METADATA_CHANGED';

export interface SemanticChange {
  changeId: string;
  identity: CrossVersionIdentity;
  changeKind: SemanticChangeKind;
  description: string;
  deltaDescriptor?: Readonly<Record<string, unknown>>;
}

export type ReferenceKind =
  | 'STATIC_CALL'
  | 'STATIC_IMPORT'
  | 'STATIC_TYPE_REFERENCE'
  | 'STATIC_PROPERTY_ACCESS'
  | 'STATIC_INHERITANCE'
  | 'STATIC_IMPLEMENTATION'
  | 'STATIC_CALLBACK_REFERENCE'
  | 'STATIC_JSX_REFERENCE'
  | 'DYNAMIC_PROPERTY_ACCESS'
  | 'DYNAMIC_MODULE_LOAD'
  | 'REFLECTION_OR_METAPROGRAMMING'
  | 'AMBIENT_OR_GLOBAL_ACCESS'
  | 'UNRESOLVED_BOUNDARY';

export interface SourceLocation {
  filePath: string;
  line: number;
  character: number;
  length?: number;
}

export interface ConsumerCallContext {
  argumentsCount?: number;
  argumentTypes?: readonly string[];
  returnConsumed?: boolean;
  typeArguments?: readonly string[];
  contextDetails?: Readonly<Record<string, unknown>>;
}

export interface Reference {
  referenceId: string;
  projectId: string;
  resolutionId?: string;
  kind: ReferenceKind;
  targetEntityId: string;
  location: SourceLocation;
  consumerContext?: ConsumerCallContext;
  isUnresolvedBoundary: boolean;
  boundaryTaxonomyReason?: string;
}

export type VerificationQuestion =
  | 'API_COMPATIBILITY'          // Did the provider's public contract change incompatibly?
  | 'CONSUMER_COMPATIBILITY'     // Does a specific consumer site remain syntactically and type-compatible?
  | 'BEHAVIORAL_COMPATIBILITY';  // Does a specific consumer site execute with equivalent runtime behavior?

export interface ProvenanceChain {
  repositoryId: string;
  projectId: string;
  resolutionId?: string;
  identityId: string;
  referenceId?: string;
  obligationId: string;
  evidenceId: string;
  verdictId: string;
}

export interface VerificationObligation {
  obligationId: string;
  projectId: string;
  resolutionId?: string;
  question: VerificationQuestion;
  change: SemanticChange;
  reference?: Reference;
  scope: 'PROVIDER' | 'CONSUMER' | 'REPOSITORY';
  createdAt: string;
}

export type AssuranceTier =
  | 'F0_FORMAL'
  | 'COMPILER_STATIC'
  | 'WITNESS'
  | 'UNRESOLVED';

export type VerifiedProperty =
  | 'API_TYPE'
  | 'CONSUMER_TYPE'
  | 'BEHAVIOR'
  | 'RESOLUTION'
  | 'IDENTITY';

export type VerificationOutcome =
  | 'PRESERVED'
  | 'VIOLATED'
  | 'NOT_APPLICABLE'
  | 'UNKNOWN';

export interface F0FormalEvidence {
  proofTrace: ReadonlyArray<{
    ruleApplied: string;
    stepIndex: number;
    premises: readonly string[];
    conclusion: string;
  }>;
  operationalWitness?: {
    inputDomainWitness: readonly unknown[];
    parentOutcome: string;
    candidateOutcome: string;
  };
}

export interface CompilerStaticEvidence {
  diagnosticDelta: number;
  parentDiagnosticCount: number;
  candidateDiagnosticCount: number;
  introducedDiagnostics: ReadonlyArray<{
    code: string | number;
    message: string;
    location?: SourceLocation;
  }>;
  assignabilityWitness?: {
    sourceType: string;
    targetType: string;
    isAssignable: boolean;
  };
}

export interface UnresolvedBoundaryEvidence {
  taxonomyCode: string;
  description: string;
  astSnippet?: string;
  remediation: {
    code: string;
    suggestion: string;
  };
}

export interface VerificationEvidence {
  evidenceId: string;
  assurance: AssuranceTier;
  property: VerifiedProperty;
  f0Formal?: F0FormalEvidence;
  compilerStatic?: CompilerStaticEvidence;
  unresolvedBoundary?: UnresolvedBoundaryEvidence;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface VerificationVerdict {
  verdictId: string;
  obligationId: string;
  targetEntityId: string;
  outcome: VerificationOutcome;
  assurance: AssuranceTier;
  property: VerifiedProperty;
  scope: 'PROVIDER' | 'CONSUMER' | 'REPOSITORY';
  provenance: ProvenanceChain;
  evidence: VerificationEvidence;
  timestamp: string;
}

export interface ConservationReport {
  totalDiscoveredReferences: number;
  staticReferencesCount: number;
  unresolvedBoundariesCount: number;
  generatedObligationsCount: number;
  accountedObligationsCount: number;
  silentDropsCount: number;
  conservationSatisfied: boolean;
  unaccountedObligationIds: readonly string[];
}

export interface DiscoveryAccounting {
  /** Populated only by an execution-local, independently accepted checker. */
  coverageProfileId?: string;
  targetEntityIds: readonly string[];
  candidateReferencesDiscovered: number;
  confirmedConsumers: number;
  unresolvedPotentialConsumers: number;
  consumerLocations: ReadonlyArray<{
    referenceId: string;
    targetEntityId: string;
    relationshipType: ReferenceKind;
    location: SourceLocation;
    resolutionId?: string;
    status: 'CONFIRMED' | 'UNRESOLVED_POTENTIAL';
  }>;
  resolutionEvidence: readonly ResolutionFact[];
}

export interface EnvironmentFailure {
  failureId: string;
  taxonomyCode: string;
  projectId: string;
  location: SourceLocation;
  referenceId: string;
}

export type CertificationStatus =
  | 'CERTIFIED_PRESERVED'
  | 'CERTIFIED_VIOLATED'
  | 'UNCERTIFIED_UNKNOWN'
  | 'CONSERVATION_ABORT'
  | 'CERTIFIED_NOT_APPLICABLE';

export interface CertificationLedger {
  ledgerId: string;
  repositoryId: string;
  parentSnapshotId: string;
  candidateSnapshotId: string;
  conservationReport: ConservationReport;
  /** Present on every ledger emitted by ProductionVerificationCore. Optional
   * only for decoding legacy/test ledgers created before discovery accounting. */
  discoveryAccounting?: DiscoveryAccounting;
  /** Reconstruction failures are reported independently from semantic
   * verdicts, even though affected obligations still fail closed as UNKNOWN. */
  environmentFailures?: readonly EnvironmentFailure[];
  verdicts: readonly VerificationVerdict[];
  summary: {
    total: number;
    preserved: number;
    violated: number;
    notApplicable: number;
    unknown: number;
  };
  certificationStatus: CertificationStatus;
  issuedAt: string;
}

export interface ScopeExclusionCertificate {
  readonly schemaVersion: 'V33_SCOPE_ISOLATION_PROOF_V1';
  readonly certificateId: string;
  readonly parentSnapshotId: string;
  readonly candidateSnapshotId: string;
  readonly targetProjectId: string;
  readonly targetFiles: readonly string[];
  readonly declaredInventory: readonly string[];
  readonly includedScopeFiles: readonly string[];
  readonly excludedFiles: readonly string[];
  readonly forwardDependencies: readonly string[];
  readonly reverseConsumers: readonly string[];
  readonly ambientAugmentations: readonly string[];
  readonly nonInterferenceProof: {
    readonly isProvablyDisjoint: boolean;
    readonly isolationModel: 'INDEPENDENT_PROJECT_ROOT' | 'SEALED_CONTAINMENT' | 'EMPTY_EXCLUSION';
    readonly exclusionJustifications: Readonly<Record<string, string>>;
  };
  readonly certificateDigest: string;
}

export interface ScopeIsolationVerificationResult {
  readonly status: 'VERIFIED' | 'REJECTED' | 'UNKNOWN_BOUNDARY';
  readonly verifiedScope: readonly string[];
  readonly rejectedExclusions?: ReadonlyArray<{
    readonly filePath: string;
    readonly reason: string;
    readonly blockerCode: string;
  }>;
  readonly unresolvedBoundaries?: readonly Reference[];
  readonly certificate?: ScopeExclusionCertificate;
  readonly justification?: string;
}
