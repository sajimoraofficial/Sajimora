import { createHash } from 'node:crypto';
import { canonicalJson } from '@sajimora/core';

export const INDEX_SCHEMA_VERSION = 'SAJIMORA_INDEX_V2';
export const INDEX_EXTRACTOR_VERSION = '32.12.0-index-v2';
export const INDEX_PROOF_RULES_VERSION = 'phase4-frozen-v1';

export interface CommitIndexIdentity {
  readonly schemaVersion: typeof INDEX_SCHEMA_VERSION;
  readonly extractorVersion: string;
  readonly proofRulesVersion: string;
  readonly repositoryId: string;
  readonly commitSha: string;
  readonly toolchainFingerprint: string;
  readonly configFingerprint: string;
  readonly dependencyFingerprint: string;
  readonly externalDependencyFingerprint: string;
}

export interface ProjectIndexIdentity extends CommitIndexIdentity {
  readonly projectId: string;
  readonly projectContextFingerprint: string;
}

export interface GenerationIdentity extends CommitIndexIdentity {
  readonly generationId: string;
}

export function hashCanonical(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`${domain}\0${canonicalJson(value)}`, 'utf8')
    .digest('hex');
}

export function createGenerationIdentity(
  identity: CommitIndexIdentity,
  nonce: string
): GenerationIdentity {
  const generationId = hashCanonical('SAJIMORA_GENERATION_ID_V1', { identity, nonce });
  return { ...identity, generationId };
}

export function assertIdentityComplete(identity: CommitIndexIdentity): void {
  for (const [key, value] of Object.entries(identity)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`INDEX_IDENTITY_INVALID: ${key} must be a non-empty string`);
    }
  }
  if (identity.schemaVersion !== INDEX_SCHEMA_VERSION) {
    throw new Error(`INDEX_SCHEMA_INCOMPATIBLE: ${identity.schemaVersion}`);
  }
}

export function sameCommitIdentity(a: CommitIndexIdentity, b: CommitIndexIdentity): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
