/**
 * index.ts
 * Public surface of the cross-language analysis package.
 * Only add exports that are part of the stable API.
 */

export {
  SCHEMA_VERSION,
  ASSURANCE,
  isCrossLanguageImpactReport,
  buildFindingId,
  buildWorkingTreeSnapshotId,
  makeInconclusiveReport,
  makeErrorReport,
} from './CrossLanguageContracts';

export type {
  SchemaVersion,
  Assurance,
  CrossLanguageVerdict,
  AssessedProperty,
  SnapshotIdentity,
  AnalysisScope,
  FrameworkProfile,
  CodecProfile,
  ClientProfile,
  EvidenceKind,
  EvidenceItem,
  EndpointLocation,
  TsExpectationKind,
  TypeScriptClientRef,
  ConsumerSite,
  CrossLanguageFinding,
  BlockerCode,
  AnalysisBlocker,
  AnalysisCounts,
  CrossLanguageImpactReport,
} from './CrossLanguageContracts';

export {
  captureSnapshotPair,
} from './CrossLanguageSnapshotPair';

export type {
  CapturedFile,
  SnapshotPair,
  CandidateSelector,
  SnapshotPairOptions,
} from './CrossLanguageSnapshotPair';

export {
  serializeReport,
  writeReportAtomic,
  parseReport,
  reportFingerprint,
} from './AgentImpactJson';



export {
  analyzeCrossLanguageImpact,
} from './CrossLanguageImpactAnalyzer';

export type {
  CrossLanguageAnalysisInput,
} from './CrossLanguageImpactAnalyzer';

export * from './CanonicalContractIR';
export * from './EndpointIdentity';
export * from './LombokSynthesizer';
export * from './SpringContainerUnwrapper';
export * from './JavaWireModelEngine';
export * from './TypeScriptContractParser';
export * from './UrlConstantResolver';
export * from './HttpClientAdapters';
export * from './ConsumerImpactGraph';
export * from './FourWayCompatibilityEngine';
export * from './ContractArtifactEnvelope';
export * from './ArtifactAdmission';
export * from './ArtifactComparisonEngine';
export * from './WireInclusion';
export * from './JacksonSnapshotConfig';
