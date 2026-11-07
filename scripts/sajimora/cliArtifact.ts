import { z } from 'zod';

export const CLI_SCHEMA_VERSION = 'V32.9-TS-cli-v1' as const;

const derivationFailureArtifactSchema = z.object({
  schemaVersion: z.literal(CLI_SCHEMA_VERSION),
  status: z.string(),
  derivation: z.unknown()
}).strict();

const analysisArtifactSchema = z.object({
  schemaVersion: z.literal(CLI_SCHEMA_VERSION),
  repository: z.string(),
  parentSha: z.string(),
  candidateSha: z.string(),
  derivation: z.object({
    changedFiles: z.array(z.string()),
    actualDiff: z.string()
  }).strict(),
  results: z.array(z.object({
    target: z.unknown(),
    mutation: z.unknown(),
    contracts: z.unknown(),
    verdict: z.enum(['VIOLATED', 'PRESERVED', 'UNKNOWN', 'INSUFFICIENT_EVIDENCE', 'NOT_APPLICABLE']),
    auditTrace: z.unknown()
  }).strict())
}).strict();

export const cliArtifactSchema = z.union([derivationFailureArtifactSchema, analysisArtifactSchema]);

export function canonicalizeCliArtifact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeCliArtifact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map(key => [key, canonicalizeCliArtifact((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

export function serializeCliArtifact(value: unknown): string {
  return JSON.stringify(canonicalizeCliArtifact(cliArtifactSchema.parse(value)), null, 2);
}
