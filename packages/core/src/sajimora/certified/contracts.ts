/**
 * @file contracts.ts
 * Wire contracts, typed references, F0 terms, fact/rule/conclusion unions, verification result.
 */

import { SchemaVersion, ArtifactDomain } from './protocol';
import { FactRef, ArtifactRef, Anchor } from './blockers';
import { CanonicalSet } from './canonicalEncoding';

export type F0JsonValue = string | number | boolean | null | F0JsonValue[] | { [key: string]: F0JsonValue };

export interface OpaqueF0Payload {
  _opaqueF0Semantics: 'UNRESOLVED';
  payload: F0JsonValue;
}

export interface Vertex {
  projectId: string;
  fileId: string;
}

export type FileKind = 'SOURCE' | 'DECLARATION' | 'CONFIG' | 'PACKAGE_METADATA' | 'TOOLCHAIN' | 'OTHER';
export type FileOrigin = 'GIT_OBJECT' | 'VERIFIED_PACKAGE_ARCHIVE' | 'RECORDED_GENERATED_OUTPUT' | 'PINNED_TOOLCHAIN_INPUT';

export interface FileEntry {
  fileId: string;
  logicalPath: string;
  byteLength: number;
  bytesRef: ArtifactRef;
  mode: number;
  kind: FileKind;
  origin: FileOrigin;
  provenanceRefs: ArtifactRef[];
}

export interface ProjectEntry {
  projectId: string;
  configFileIds: string[];
  effectiveOptions: OpaqueF0Payload; // JSON representation of options
  optionsDerivationRef: ArtifactRef;
  roots: Vertex[];
  references: string[];
  referenceMode: 'SOURCE' | 'DECLARATION_OUTPUT';
}

export interface PackageEntry {
  packageInstanceId: string;
  logicalRoot: string;
  metadataFileId: string;
  originEvidenceRefs: ArtifactRef[];
  installationMappingRef: ArtifactRef;
  workspaceProjectIdOrNull: string | null;
}

export interface DependencyEdge {
  edgeKind: string;
  from: Vertex;
  anchorOrNull: Anchor | null;
  resolutionFactRefOrNull: ArtifactRef | null;
  targetVertices: Vertex[];
  metadataFileIds: string[];
}

export interface ResolutionFact {
  request: OpaqueF0Payload;
  resolverProfileId: string;
  orderedProbes: { logicalPath: string; exists: boolean }[];
  metadataFileIds: string[];
  selectedTargetOrNull: string | null;
  outcome: 'RESOLVED' | 'UNRESOLVED' | 'UNSUPPORTED' | 'AMBIGUOUS';
}

export interface AmbientRoot {
  vertex: Vertex;
  originKind: 'CONFIG_FILE' | 'TYPES_OPTION' | 'TYPE_ROOT_DISCOVERY' | 'DEFAULT_LIB' | 'TRIPLE_SLASH' | 'GLOBAL_SCRIPT';
  rootSelectionEvidenceRef: ArtifactRef;
}

export interface AugmentationFact {
  sourceAnchor: Anchor;
  targetScopeOrModule: string;
  resolutionFactRefOrNull: ArtifactRef | null;
  declarationAnchors: Anchor[];
  groupId: string;
}

// Environment Manifest
export interface EnvironmentManifest {
  schemaVersion: SchemaVersion;
  repositoryId: string;
  revision: {
    commitId: string;
    treeId: string;
    parentSelection: string;
  };
  environmentBasis: 'RECORDED_BUILD' | 'REPOSITORY_DETERMINED_RECONSTRUCTION';
  historicalBindingEvidenceRefs: ArtifactRef[];
  namespace: {
    pathPolicyId: string;
    caseSensitivity: string;
    unicodePolicy: string;
    files: FileEntry[];
    symlinks: { logicalPath: string; target: string }[];
    directoryInventory: OpaqueF0Payload[];
    completenessEvidenceRefs: CanonicalSet<ArtifactRef>;
  };
  compiler: {
    packageVersion: string;
    distributionDigest: string;
    parserProfileId: string;
    semanticProfileId: string;
  };
  projects: ProjectEntry[];
  packages: PackageEntry[];
  rootSelectionPolicyId: string;
  admittedRoots: CanonicalSet<Vertex>;
  ambientRoots: CanonicalSet<AmbientRoot>;
  generatedArtifacts: CanonicalSet<any>;
  boundaryPolicyId: string;
  inputEvidenceRefs: CanonicalSet<ArtifactRef>;
}

// Closure
export interface DependencyClosureCertificate {
  schemaVersion: SchemaVersion;
  environmentRef: ArtifactRef;
  rootPolicyId: string;
  rootVertices: CanonicalSet<Vertex>;
  reachedVertices: CanonicalSet<Vertex>;
  dependencyEdgeRefs: CanonicalSet<ArtifactRef>;
  resolutionFactRefs: CanonicalSet<ArtifactRef>;
  augmentationFactRefs: CanonicalSet<ArtifactRef>;
  declarationGroups: CanonicalSet<any>;
  traversalCoverage: CanonicalSet<{ vertex: Vertex; parsedSyntaxDigest: string; dependencyAnchorIds: string[] }>;
  boundaryDischarges: CanonicalSet<any>;
  ruleSetId: string;
}

// Fragment
export interface FragmentAdmissionCertificate {
  schemaVersion: SchemaVersion;
  environmentRef: ArtifactRef;
  closureRef: ArtifactRef;
  profileId: string;
  syntaxCoverage: CanonicalSet<{ vertex: Vertex; syntaxNodeId: string; admittedProductionId: string }>;
  declarationTableRef: ArtifactRef;
  bindingProofRefs: CanonicalSet<ArtifactRef>;
  typeDerivationRefs: CanonicalSet<ArtifactRef>;
  aliasTopologicalOrder: string[]; // ordered
  consumerContextAnchors: CanonicalSet<Anchor>;
  /** Optional V33 target-scoped admission envelope; absent in legacy/full-file mode. */
  targetScopedEnvelope?: unknown;
}

// Obligation
export interface SemanticObligation {
  schemaVersion: SchemaVersion;
  parentEnvironmentRef: ArtifactRef;
  candidateEnvironmentRef: ArtifactRef;
  targetIdentityEvidenceRef: ArtifactRef;
  historicalOccurrenceAnchor: Anchor;
  lifecycleEvidenceRef: ArtifactRef;
  relevanceEvidenceRef: ArtifactRef;
  contextKind: string;
  historicalEvidenceRefs: CanonicalSet<ArtifactRef>;
  candidateEvidenceRefs: CanonicalSet<ArtifactRef>;
  parentValidityProofRef: ArtifactRef;
  requiredRelations: CanonicalSet<{
    relationId: string;
    kind: 'ASSIGNMENT_ACCEPTS' | 'PARAMETER_ACCEPTS_ARGUMENT' | 'RETURN_SATISFIES_CONTEXT' | 'MEMBER_AVAILABLE' | 'FRESH_OBJECT_ACCEPTANCE' | 'ARITY' | 'OPERATIONAL_RETURN_AVAILABLE' | 'CALLABLE_REQUIRED';
    sourceTermRefOrNull: ArtifactRef | null;
      targetTermRefOrNull: ArtifactRef | null;
      sourceTermValueOrNull?: unknown | null;
      targetTermValueOrNull?: unknown | null;
      position: string;
    contextFactRefs: CanonicalSet<FactRef>;
  }>;
}

// Proof
export interface ProofNode {
  nodeId: string;
  ruleId: string;
  premises: string[];
  conclusion: any;
}

export interface SemanticProof {
  schemaVersion: SchemaVersion;
  obligationRef: ArtifactRef;
  ruleSetId: string;
  nodes: CanonicalSet<ProofNode>;
  rootNodeIds: CanonicalSet<string>;
    claimedConclusion: 'COMPATIBLE' | 'INCOMPATIBLE';
    witnessContext?: {
      parentEnvironmentRef: ArtifactRef;
      candidateEnvironmentRef: ArtifactRef;
      targetIdentityEvidenceRef: ArtifactRef;
      occurrenceAnchor: Anchor;
      consumerFile: string;
    };
    relationBindings?: Array<{
      relationId: string;
      kind: string;
      position: string;
      sourceTermValueOrNull: unknown | null;
      targetTermValueOrNull: unknown | null;
      proofNodeId: string;
    }>;
}

// Coverage
export interface CoverageCertificate {
  schemaVersion: SchemaVersion;
  parentEnvironmentRef: ArtifactRef;
  candidateEnvironmentRef: ArtifactRef;
  targetIdentityEvidenceRef: ArtifactRef;
  fragmentAdmissionRefs: CanonicalSet<ArtifactRef>;
  mode: 'EXACT';
  historicalSyntaxDomainRef: ArtifactRef;
  actualOccurrenceRefs: CanonicalSet<ArtifactRef>;
  analysisOccurrenceRefs: CanonicalSet<ArtifactRef>;
  dependencyGraphRef: ArtifactRef;
  transferRuleSetId: string;
  contextDispositionLedger: CanonicalSet<any>;
  occurrenceToObligationMap: CanonicalSet<any>;
  exactProjectionProofRef: ArtifactRef;
  nonemptyActualWitnessRefOrNull: ArtifactRef | null;
  exclusionProofRefs: CanonicalSet<ArtifactRef>;
}

// Bundle
export interface Phase5EvidenceBundle {
  schemaVersion: SchemaVersion;
  claimKind: 'HISTORICAL_TYPED_CONTRACT_PRESERVATION';
  repositoryId: string;
  parentEnvironmentRef: ArtifactRef;
  candidateEnvironmentRef: ArtifactRef;
  obligationRequestRef: ArtifactRef;
  identityEvidenceRef: ArtifactRef;
  dependencyClosureRefs: CanonicalSet<ArtifactRef>;
  fragmentAdmissionRefs: CanonicalSet<ArtifactRef>;
  semanticObligationRefs: CanonicalSet<ArtifactRef>;
  semanticProofRefs: CanonicalSet<ArtifactRef>;
  coverageRef: ArtifactRef;
  normalizationProfileId: string;
  ruleSetId: string;
  resourceProfileId: string;
}
