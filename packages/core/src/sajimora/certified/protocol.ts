/**
 * @file protocol.ts
 * Protocol, profile, and rule IDs, artifact domains, resource profiles, and sorting contracts for SAJIMORA_CERTIFIED_EVIDENCE_V1.
 */

export const SAJIMORA_CERTIFIED_EVIDENCE_V1 = 'SAJIMORA_CERTIFIED_EVIDENCE_V1';

export type SchemaVersion = typeof SAJIMORA_CERTIFIED_EVIDENCE_V1;

export enum ArtifactDomain {
  MANIFEST = 'MANIFEST',
  CLOSURE = 'CLOSURE',
  ADMISSION = 'ADMISSION',
  OBLIGATION = 'OBLIGATION',
  PROOF = 'PROOF',
  COVERAGE = 'COVERAGE',
  BUNDLE = 'BUNDLE',
  SOURCE_BYTES = 'SOURCE_BYTES',
  PUBLICATION = 'PUBLICATION',
    QUERY_KEY = 'QUERY_KEY',
    IDENTITY = 'IDENTITY'
}

export enum ResolverProfileId {
  F0_NODE10_STATIC_V1 = 'F0_NODE10_STATIC_V1'
}

export enum ParserProfileId {
  TS_5_9_3_STRICT = 'TS_5_9_3_STRICT'
}

export enum SemanticProfileId {
  TS_FINITE_CONTRACTS_F0 = 'TS_FINITE_CONTRACTS_F0'
}

export enum RootPolicyId {
  F0_ENV_GIT_SEALED_V1 = 'F0_ENV_GIT_SEALED_V1'
}

export enum BoundaryPolicyId {
  F0_STRICT_BOUNDARY_V1 = 'F0_STRICT_BOUNDARY_V1'
}

export enum RuleSetId {
  F0_RULES_V1 = 'F0_RULES_V1'
}

export enum TransferRuleSetId {
  F0_TRANSFER_RULES_V1 = 'F0_TRANSFER_RULES_V1'
}

export enum NormalizationProfileId {
  F0_NORMALIZATION_V1 = 'F0_NORMALIZATION_V1'
}

export interface ResourceProfile {
  maxInputBytes: number;
  maxFileBytes: number;
  maxVertices: number;
  maxEdges: number;
  maxSyntaxNesting: number;
  maxAliasDepth: number;
  maxProofNodes: number;
  maxCertificateBytes: number;
  maxWorkUnits: number;
  workerMemoryMb: number;
  deadlineMs: number;
}

export const INITIAL_RESOURCE_PROFILE: ResourceProfile = {
  maxInputBytes: 256 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxVertices: 50000,
  maxEdges: 500000,
  maxSyntaxNesting: 128,
  maxAliasDepth: 128,
  maxProofNodes: 1000000,
  maxCertificateBytes: 128 * 1024 * 1024,
  maxWorkUnits: 10000000,
  workerMemoryMb: 1024,
  deadlineMs: 60000
};

// All set arrays must sort by canonical member encoding
// Ordered arrays retain their natural sequence.
