/**
 * SAJIMORA V32 — Expected Change Model (ECM) Schemas
 * Subordinate to sajimora_v32_foundation_spec.md §1.2 & §1.3.
 */

import { z } from 'zod';

export const ExpectationProvenanceSchema = z.enum([
  'DEVELOPER_DECLARED',
  'COMMIT_MESSAGE_PARSED',
  'PR_DESCRIPTION_PARSED',
  'INFERRED_FROM_HISTORY',
  'INFERRED_FROM_STRUCTURE',
  'UNKNOWN',
]);

export const ExpectationConfidenceSchema = z.number().min(0.0).max(1.0);

export const ExpectedFileChangeSchema = z.object({
  filePath: z.string().min(1),
  changeType: z.enum(['ADDED', 'MODIFIED', 'DELETED', 'RENAMED']),
  oldFilePath: z.string().optional(),
  provenance: ExpectationProvenanceSchema,
  confidence: ExpectationConfidenceSchema,
});

export const SymbolKindSchema = z.enum([
  'FUNCTION',
  'CLASS',
  'INTERFACE',
  'TYPE_ALIAS',
  'ENUM',
  'CONSTANT',
  'OTHER',
]);

export const ExpectedSymbolChangeSchema = z.object({
  filePath: z.string().min(1),
  symbolName: z.string().min(1),
  symbolKind: SymbolKindSchema.optional().default('OTHER'),
  changeType: z.enum(['ADDED', 'REMOVED', 'RENAMED', 'SIGNATURE_CHANGED']),
  oldSymbolName: z.string().optional(),
  oldSignature: z.string().optional(),
  newSignature: z.string().optional(),
  provenance: ExpectationProvenanceSchema,
  confidence: ExpectationConfidenceSchema,
});

export const ExpectedEdgeChangeSchema = z.object({
  sourceFilePath: z.string().min(1),
  targetFilePath: z.string().min(1),
  edgeKind: z.string().min(1),
  changeType: z.enum(['ADDED', 'REMOVED']),
  provenance: ExpectationProvenanceSchema,
  confidence: ExpectationConfidenceSchema,
});

export const ExpectedBehavioralObligationSchema = z.object({
  obligationId: z.string().min(1),
  description: z.string().min(1),
  verificationStrategy: z.enum([
    'STRUCTURAL_AST',
    'GRAPH_TRAVERSAL',
    'GIT_HISTORY',
    'INSUFFICIENT',
  ]),
  targetEntities: z.array(z.string()).default([]),
  contentHints: z.array(z.string()).default([]),
  provenance: ExpectationProvenanceSchema,
  confidence: ExpectationConfidenceSchema,
});

export const ExpectedInvariantTransitionSchema = z.object({
  invariantDescription: z.string().min(1),
  expectedState: z.enum([
    'PRESERVED',
    'INTENTIONALLY_EVOLVED',
    'NEWLY_ESTABLISHED',
  ]),
  evolutionReason: z.string().optional(),
  provenance: ExpectationProvenanceSchema,
  confidence: ExpectationConfidenceSchema,
});

export const ChangeBoundarySchema = z.object({
  forbiddenPaths: z.array(z.string()).default([]),
  reason: z.string().min(1),
  provenance: ExpectationProvenanceSchema,
});

export const ExpectedChangeModelSchema = z.object({
  changeId: z.string().length(64), // SHA-256 hex string
  workspaceId: z.string().min(1),
  baseCommitSha: z.string().min(1),
  candidateCommitSha: z.string().min(1),
  createdAt: z.date(),
  ecmSource: z.enum(['STRUCTURED_INPUT', 'SEMI_STRUCTURED_TEXT', 'INFERRED']),
  expectedFiles: z.array(ExpectedFileChangeSchema).default([]),
  expectedSymbols: z.array(ExpectedSymbolChangeSchema).default([]),
  expectedEdges: z.array(ExpectedEdgeChangeSchema).default([]),
  expectedBehavioralObligations: z.array(ExpectedBehavioralObligationSchema).default([]),
  expectedInvariantTransitions: z.array(ExpectedInvariantTransitionSchema).default([]),
  changeBoundary: ChangeBoundarySchema.nullable().default(null),
  overallConfidence: z.number().min(0.0).max(1.0),
  validationStatus: z.enum(['VALID', 'INVALID', 'PARTIAL']),
  validationErrors: z.array(z.string()).default([]),
});

export type ExpectedChangeModelInput = z.input<typeof ExpectedChangeModelSchema>;
