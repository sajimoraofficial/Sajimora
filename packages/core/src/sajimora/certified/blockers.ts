/**
 * @file blockers.ts
 * Closed certified blocker vocabulary and stage/location payloads for F0.
 * No verdict logic is present here, only the structural vocabulary for failures.
 */

import { ArtifactDomain } from './protocol';

export enum BlockerCode {
  INVALID_SCHEMA = 'INVALID_SCHEMA',
  UNSUPPORTED_PROTOCOL = 'UNSUPPORTED_PROTOCOL',
  REVISION_MISMATCH = 'REVISION_MISMATCH',
  ENVIRONMENT_INPUT_MISSING = 'ENVIRONMENT_INPUT_MISSING',
  NAMESPACE_INCOMPLETE = 'NAMESPACE_INCOMPLETE',
  TOOLCHAIN_MISMATCH = 'TOOLCHAIN_MISMATCH',
  UNSUPPORTED_CONFIGURATION = 'UNSUPPORTED_CONFIGURATION',
  MISSING_PROJECT_ROOT = 'MISSING_PROJECT_ROOT',
  PACKAGE_ORIGIN_UNPROVEN = 'PACKAGE_ORIGIN_UNPROVEN',
  AMBIENT_ROOT_OMISSION = 'AMBIENT_ROOT_OMISSION',
  GENERATED_PROVENANCE_MISSING = 'GENERATED_PROVENANCE_MISSING',
  EDGE_OMISSION = 'EDGE_OMISSION',
  RESOLUTION_TARGET_UNPROVEN = 'RESOLUTION_TARGET_UNPROVEN',
  AMBIGUOUS_DECLARATION_GROUP = 'AMBIGUOUS_DECLARATION_GROUP',
  UNJUSTIFIED_BOUNDARY_EXCLUSION = 'UNJUSTIFIED_BOUNDARY_EXCLUSION',
  MISSING_EVIDENCE = 'MISSING_EVIDENCE',
  UNSUPPORTED_COVERAGE_MODE = 'UNSUPPORTED_COVERAGE_MODE',
  
  // Syntax/Fragment blockers
  UNSUPPORTED_SYNTAX = 'UNSUPPORTED_SYNTAX',
  UNSUPPORTED_TYPE = 'UNSUPPORTED_TYPE',
  UNSUPPORTED_BINDING = 'UNSUPPORTED_BINDING',
  CIRCULAR_TYPE_ALIAS = 'CIRCULAR_TYPE_ALIAS',

  // Proof verification blockers
  MISSING_OBLIGATION = 'MISSING_OBLIGATION',
  INVALID_RULE_APPLICATION = 'INVALID_RULE_APPLICATION',
  PREMISE_NOT_SATISFIED = 'PREMISE_NOT_SATISFIED',
  PROOF_CYCLE_DETECTED = 'PROOF_CYCLE_DETECTED',
  IDENTITY_MISMATCH = 'IDENTITY_MISMATCH',
  LIFECYCLE_RULE_VIOLATION = 'LIFECYCLE_RULE_VIOLATION',

  // Resource exhaustion
  RESOURCE_EXHAUSTED = 'RESOURCE_EXHAUSTED',

  // Hash/Integrity
  HASH_MISMATCH = 'HASH_MISMATCH'
}

export type ResourceKind = 
  | 'INPUT_BYTES'
  | 'FILE_BYTES'
  | 'VERTICES'
  | 'EDGES'
  | 'SYNTAX_NESTING'
  | 'ALIAS_DEPTH'
  | 'PROOF_NODES'
  | 'CERTIFICATE_BYTES'
  | 'WORK_UNITS'
  | 'WORKER_MEMORY'
  | 'DEADLINE';

export interface BlockerDetail {
  code: BlockerCode;
  message: string;
}

export interface ResourceExhaustedDetail {
  code: BlockerCode.RESOURCE_EXHAUSTED;
  resourceKind: ResourceKind;
  consumed: number;
  limit: number;
  message: string;
}

export interface Anchor {
  projectId: string;
  fileId: string;
  utf16Start: number;
  utf16End: number;
  syntaxKind: number;
}

export interface FactRef {
  kind: 'BYTE' | 'ROOT' | 'BINDING' | 'TYPE' | 'IDENTITY' | 'LIFECYCLE' | 'RELEVANCE' | 'PARENT_VALIDITY' | 'CONSTRAINT' | 'COVERAGE';
  digest: string;
}

export interface ArtifactRef {
  domain: ArtifactDomain;
  digest: string;
}

export type VerificationResult = 
  | { status: 'VERIFIED', bundleDigest: string, verifiedClaim: string, verifiedAuthorityInputDigest: string, replayProfileId: string }
  | { status: 'REJECTED', blockerCode: BlockerCode, artifactRef?: ArtifactRef, sourceAnchor?: Anchor, detail: BlockerDetail }
  | { status: 'RESOURCE_EXHAUSTED', detail: ResourceExhaustedDetail };
