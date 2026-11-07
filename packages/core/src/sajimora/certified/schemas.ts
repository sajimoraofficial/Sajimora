/**
 * @file schemas.ts
 * Runtime validation of all tagged contracts; structural validation only.
 */

import { z } from 'zod';
import { SAJIMORA_CERTIFIED_EVIDENCE_V1 } from './protocol';
import { CanonicalSet } from './canonicalEncoding';

const CanonicalSetZod = <T extends z.ZodTypeAny>(schema: T) => z.array(schema).transform(a => new CanonicalSet(...a));

const SchemaVersionZod = z.literal(SAJIMORA_CERTIFIED_EVIDENCE_V1);

export const AnchorZod = z.object({
  projectId: z.string(),
  fileId: z.string(),
  utf16Start: z.number().min(0),
  utf16End: z.number().min(0),
  syntaxKind: z.number()
}).strict();

export const ArtifactRefZod = z.object({
  domain: z.string(), // Validated against ArtifactDomain enum in higher layer
  digest: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

// Recursive Zod type for F0JsonValue
export const F0JsonValueZod: z.ZodType<any> = z.lazy(() =>
  z.union([
    z.string().refine(s => !(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(s)), { message: "Unpaired surrogate in string" }),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(F0JsonValueZod),
    z.record(F0JsonValueZod)
  ])
);

export const OpaqueF0PayloadZod = z.object({
  _opaqueF0Semantics: z.literal('UNRESOLVED'),
  payload: F0JsonValueZod
}).strict();

export const FactRefZod = z.object({
  kind: z.enum(['BYTE', 'ROOT', 'BINDING', 'TYPE', 'IDENTITY', 'LIFECYCLE', 'RELEVANCE', 'PARENT_VALIDITY', 'CONSTRAINT', 'COVERAGE']),
  digest: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export const VertexZod = z.object({
  projectId: z.string(),
  fileId: z.string()
}).strict();

export const FileEntryZod = z.object({
  fileId: z.string(),
  logicalPath: z.string(),
  byteLength: z.number().min(0),
  bytesRef: ArtifactRefZod,
  mode: z.number(),
  kind: z.enum(['SOURCE', 'DECLARATION', 'CONFIG', 'PACKAGE_METADATA', 'TOOLCHAIN', 'OTHER']),
  origin: z.enum(['GIT_OBJECT', 'VERIFIED_PACKAGE_ARCHIVE', 'RECORDED_GENERATED_OUTPUT', 'PINNED_TOOLCHAIN_INPUT']),
  provenanceRefs: z.array(ArtifactRefZod)
}).strict();

export const ProjectEntryZod = z.object({
  projectId: z.string(),
  configFileIds: z.array(z.string()),
  effectiveOptions: OpaqueF0PayloadZod,
  optionsDerivationRef: ArtifactRefZod,
  roots: z.array(VertexZod),
  references: z.array(z.string()),
  referenceMode: z.enum(['SOURCE', 'DECLARATION_OUTPUT'])
}).strict();

export const PackageEntryZod = z.object({
  packageInstanceId: z.string(),
  logicalRoot: z.string(),
  metadataFileId: z.string(),
  originEvidenceRefs: z.array(ArtifactRefZod),
  installationMappingRef: ArtifactRefZod,
  workspaceProjectIdOrNull: z.string().nullable()
}).strict();

export const DependencyEdgeZod = z.object({
  edgeKind: z.string(),
  from: VertexZod,
  anchorOrNull: AnchorZod.nullable(),
  resolutionFactRefOrNull: ArtifactRefZod.nullable(),
  targetVertices: z.array(VertexZod),
  metadataFileIds: z.array(z.string())
}).strict();

export const ResolutionFactZod = z.object({
  request: OpaqueF0PayloadZod,
  resolverProfileId: z.string(),
  orderedProbes: z.array(z.object({
    logicalPath: z.string(),
    exists: z.boolean()
  }).strict()),
  metadataFileIds: z.array(z.string()),
  selectedTargetOrNull: z.string().nullable(),
  outcome: z.enum(['RESOLVED', 'UNRESOLVED', 'UNSUPPORTED', 'AMBIGUOUS'])
}).strict();

export const AmbientRootZod = z.object({
  vertex: VertexZod,
  originKind: z.enum(['CONFIG_FILE', 'TYPES_OPTION', 'TYPE_ROOT_DISCOVERY', 'DEFAULT_LIB', 'TRIPLE_SLASH', 'GLOBAL_SCRIPT']),
  rootSelectionEvidenceRef: ArtifactRefZod
}).strict();

export const EnvironmentManifestSchema = z.object({
  schemaVersion: SchemaVersionZod,
  repositoryId: z.string(),
  revision: z.object({
    commitId: z.string(),
    treeId: z.string(),
    parentSelection: z.string()
  }).strict(),
  environmentBasis: z.enum(['RECORDED_BUILD', 'REPOSITORY_DETERMINED_RECONSTRUCTION']),
  historicalBindingEvidenceRefs: z.array(ArtifactRefZod),
  namespace: z.object({
    pathPolicyId: z.string(),
    caseSensitivity: z.string(),
    unicodePolicy: z.string(),
    files: z.array(FileEntryZod),
    symlinks: z.array(z.object({
      logicalPath: z.string(),
      target: z.string()
    }).strict()),
    directoryInventory: z.array(OpaqueF0PayloadZod),
    completenessEvidenceRefs: CanonicalSetZod(ArtifactRefZod)
  }).strict(),
  compiler: z.object({
    packageVersion: z.string(),
    distributionDigest: z.string(),
    parserProfileId: z.string(),
    semanticProfileId: z.string()
  }).strict(),
  projects: z.array(ProjectEntryZod),
  packages: z.array(PackageEntryZod),
  rootSelectionPolicyId: z.string(),
  admittedRoots: CanonicalSetZod(VertexZod),
  ambientRoots: CanonicalSetZod(AmbientRootZod),
  generatedArtifacts: CanonicalSetZod(z.any()),
  boundaryPolicyId: z.string(),
  inputEvidenceRefs: CanonicalSetZod(ArtifactRefZod)
}).strict();

export const Phase5EvidenceBundleSchema = z.object({
  schemaVersion: SchemaVersionZod,
  claimKind: z.literal('HISTORICAL_TYPED_CONTRACT_PRESERVATION'),
  repositoryId: z.string(),
  parentEnvironmentRef: ArtifactRefZod,
  candidateEnvironmentRef: ArtifactRefZod,
  obligationRequestRef: ArtifactRefZod,
  identityEvidenceRef: ArtifactRefZod,
  dependencyClosureRefs: CanonicalSetZod(ArtifactRefZod),
  fragmentAdmissionRefs: CanonicalSetZod(ArtifactRefZod),
  semanticObligationRefs: CanonicalSetZod(ArtifactRefZod),
  semanticProofRefs: CanonicalSetZod(ArtifactRefZod),
  coverageRef: ArtifactRefZod,
  normalizationProfileId: z.string(),
  ruleSetId: z.string(),
  resourceProfileId: z.string()
}).strict();

export const ResourceProfileSchema = z.object({
  maxInputBytes: z.number().min(0),
  maxFileBytes: z.number().min(0),
  maxVertices: z.number().min(0),
  maxEdges: z.number().min(0),
  maxSyntaxNesting: z.number().min(0),
  maxAliasDepth: z.number().min(0),
  maxProofNodes: z.number().min(0),
  maxCertificateBytes: z.number().min(0),
  maxWorkUnits: z.number().min(0),
  workerMemoryMb: z.number().min(0),
  deadlineMs: z.number().min(0)
}).strict();
