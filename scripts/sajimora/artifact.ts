import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  LanguageCapability,
  ToolchainIdentity,
  AdapterSelectionEvidence,
  AuthoritativeVerdict,
  DualAnalysisUniverse,
  CrossVersionIdentityBundle
} from '@sajimora/core';

export interface Phase1AnalysisResult {
  obligationId: string;
  target: { name: string; kind: string; file: string; line: number };
  verdict: AuthoritativeVerdict;
  authority: { source: string; gate: string; reason: string } | null;
  assurance?: 'F0_FORMAL' | 'COMPILER_STATIC' | 'WITNESS' | 'UNRESOLVED';
  evidence?: unknown;
  provenance?: unknown;
}

export interface Phase4ConsumerArtifact {
  readonly consumerMappingId: string;
  readonly status: 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNDECIDABLE';
  readonly reason?: string | null;
  readonly proofTree?: unknown;
}

export interface SerializedWitness {
  readonly witnessId: string;
  readonly failedRelation: string;
  readonly position: unknown;
  readonly parentType: { display: string; irContentHash?: string };
  readonly candidateType: { display: string; irContentHash?: string };
}

export interface SerializedBlocker {
  readonly blockerId: string;
  readonly snapshot: 'PARENT' | 'CANDIDATE';
  readonly detail: string;
}

export interface Phase4ArtifactExtension {
  semanticCompatibility?: {
    schemaVersion: 'SAJIMORA_COMPATIBILITY_EVIDENCE_V1';
    engineVersion: string;
    evaluatedConsumers: Phase4ConsumerArtifact[];
    witnesses: SerializedWitness[];
    blockerSummary: SerializedBlocker[];
    typeIRStats: {
      totalNodesExtracted: number;
      unsupportedNodes: number;
      cycleBackreferencesUsed: number;
      maxDepthReached: number;
    };
    proofStats: {
      compatibleCount: number;
      incompatibleCount: number;
      undecidableCount: number;
      anyDependencyUndecidableCount: number;
    };
    phase4Outcome: {
      allConsumersEvaluated: boolean;
      coverageGaps: string[];
    };
  };
}

export interface Phase1Artifact extends Phase4ArtifactExtension {
  schemaVersion: 'SAJIMORA_ANALYSIS_ARTIFACT_V2';
  repository: { repositoryId: string };
  revisions: {
    parent: { repositoryId: string; commitSha: string };
    candidate: {
      repositoryId: string;
      commitSha: string;
      parentSelection: { strategy: 'EXPLICIT_PARENT'; selectedParentSha: string };
    };
  };
  adapter: {
    id: string;
    version: string;
    capabilities: readonly LanguageCapability[];
    selection: { mode: 'auto' | 'explicit'; evidence: AdapterSelectionEvidence[] };
    toolchain: ToolchainIdentity;
  };
  dualProgram?: {
    parentStatus: 'BUILT' | 'PARTIAL' | 'FAILED';
    candidateStatus: 'BUILT' | 'PARTIAL' | 'FAILED';
    universe: DualAnalysisUniverse;
  };
  crossVersionIdentity?: CrossVersionIdentityBundle;
  analysis: { status: 'COMPLETED'; changedFiles: string[]; results: Phase1AnalysisResult[] };
  productionCertification?: {
    status: string;
    verdict: AuthoritativeVerdict;
    conservation: unknown;
    scope?: { inputDomain: string; coverageProfileId: string | null; properties: string[] };
    resources?: { durationMs: number; sampledPeakProcessRssBytes: number; workerHeapUsedBytes: number };
    testDeferral?: { authorized: boolean; reasonCode: string; description: string };
  };
}

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const relative = z.string().refine(value => !path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value));
const diagnostic = z
  .object({
    category: z.enum(['ERROR', 'WARNING', 'SUGGESTION', 'MESSAGE']),
    code: z.number(),
    file: relative.nullable(),
    line: z.number().nullable(),
    character: z.number().nullable(),
    message: z.string()
  })
  .strict();

const universe = z
  .object({
    revision: z
      .object({
        repositoryId: z.string(),
        commitSha: sha,
        parentSelection: z
          .object({ strategy: z.literal('EXPLICIT_PARENT'), selectedParentSha: sha })
          .strict()
          .optional()
      })
      .strict(),
    languageId: z.string(),
    adapterId: z.string(),
    adapterVersion: z.string(),
    toolchain: z
      .object({
        compiler: z.object({ name: z.string(), version: z.string() }).strict(),
        repositoryDeclaredVersion: z.string().nullable(),
        mismatch: z.enum(['MATCH', 'MISMATCH', 'UNDETERMINED'])
      })
      .strict(),
    projects: z.array(
      z
        .object({
          projectId: z.string(),
          configFile: relative.nullable(),
          rootFiles: z.array(relative),
          references: z.array(relative)
        })
        .strict()
    ),
    includedFiles: z.array(relative),
    excludedFiles: z.array(z.object({ file: relative, reason: z.string() }).strict()),
    parseFailures: z.array(diagnostic),
    unreadableFiles: z.array(relative),
    dependencyProvenance: z.array(
      z.object({
        file: z.string(),
        origin: z.enum(['REPOSITORY_SOURCE', 'TYPESCRIPT_BUNDLED_LIB', 'EXTERNAL_DECLARATION'])
      }).strict()
    ),
    discoveryStatus: z.enum(['DISCOVERY_COMPLETE', 'DISCOVERY_INCOMPLETE']),
    dependencyStore: z
      .object({
        lockfile: relative,
        lockfileHash: z.string().regex(/^[0-9a-f]{64}$/),
        status: z.literal('LOCKFILE_MATCHED_READ_ONLY')
      })
      .strict()
      .optional()
  })
  .strict();

const identityLocation = z
  .object({
    file: relative,
    line: z.number().int().positive(),
    column: z.number().int().positive()
  })
  .strict();

const identityEvidence = z
  .object({
    evidenceId: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.enum([
      'DIFF_CORRESPONDENCE',
      'DECLARATION_KIND',
      'OWNER_CHAIN',
      'EXPORT_PATH',
      'PARAMETER_SHAPE',
      'AST_FINGERPRINT',
      'ENCLOSING_DECLARATION',
      'SYNTAX_ROLE',
      'TARGET_BINDING',
      'AST_NEIGHBORHOOD',
      'CONTEXT_POSITION',
      'MISSING_EVIDENCE'
    ]),
    parentLocation: identityLocation.optional(),
    candidateLocation: identityLocation.optional(),
    detail: z.string()
  })
  .strict();

const symbolIdentity = z
  .object({
    identityId: z.string().regex(/^[0-9a-f]{64}$/),
    projectId: z.string(),
    moduleIdentity: relative,
    ownerChain: z.array(z.string()),
    localName: z.string(),
    declarationKind: z.string(),
    declarationOrdinal: z.number().int().nonnegative(),
    sourceSpan: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        line: z.number().int().positive(),
        column: z.number().int().positive(),
        endLine: z.number().int().positive(),
        endColumn: z.number().int().positive()
      })
      .strict(),
    exportPaths: z.array(z.string()),
    parameterShape: z.string(),
    astFingerprint: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .strict();

const crossIdentity = z
  .object({
    targetMappings: z.array(
      z
        .object({
          parent: symbolIdentity.optional(),
          candidate: symbolIdentity.optional(),
          status: z.enum([
            'SAME_DECLARATION',
            'MOVED_DECLARATION',
            'RENAMED_DECLARATION',
            'ADDED_DECLARATION',
            'REMOVED_DECLARATION',
            'AMBIGUOUS',
            'UNRESOLVED'
          ]),
          evidence: z.array(identityEvidence),
          plausibleCandidateIds: z.array(z.string())
        })
        .strict()
    ),
    consumerMappings: z.array(
      z
        .object({
          mappingId: z.string().regex(/^[0-9a-f]{64}$/),
          lifecycle: z.enum([
            'STABLE_UNCHANGED',
            'STABLE_CHANGED_SAME_COMMIT',
            'ADDED_IN_CANDIDATE',
            'REMOVED_IN_CANDIDATE',
            'BINDING_REMOVED_IN_CANDIDATE',
            'AMBIGUOUS_ACROSS_VERSIONS'
          ]),
          parentOccurrenceId: z.string().optional(),
          candidateOccurrenceId: z.string().optional(),
          targetIdentity: z.enum(['SAME', 'DIFFERENT', 'UNCERTAIN']),
          evidence: z.array(identityEvidence)
        })
        .strict()
    ),
    status: z.enum(['COMPLETE', 'INCOMPLETE']),
    blockers: z.array(z.string()),
    phaseOutcome: z
      .object({
        verdict: z.literal('UNKNOWN'),
        reason: z.literal('RELATION_ENGINE_NOT_IMPLEMENTED')
      })
      .strict(),
    boundaryAudit: z
      .object({
        compilerObjectsInArtifact: z.number().int().nonnegative(),
        crossProgramCompilerObjectComparisons: z.literal(0)
      })
      .strict()
  })
  .strict();

const phase4ConsumerSchema = z
  .object({
    consumerMappingId: z.string(),
    status: z.enum(['COMPATIBLE', 'INCOMPATIBLE', 'UNDECIDABLE']),
    reason: z.string().nullable().optional(),
    proofTree: z.unknown().optional()
  })
  .strict();

const serializedWitnessSchema = z
  .object({
    witnessId: z.string(),
    failedRelation: z.string(),
    position: z.unknown(),
    parentType: z.object({ display: z.string(), irContentHash: z.string().optional() }),
    candidateType: z.object({ display: z.string(), irContentHash: z.string().optional() })
  })
  .strict();

const serializedBlockerSchema = z
  .object({
    blockerId: z.string(),
    snapshot: z.enum(['PARENT', 'CANDIDATE']),
    detail: z.string()
  })
  .strict();

export const phase4ArtifactExtensionSchema = z
  .object({
    schemaVersion: z.literal('SAJIMORA_COMPATIBILITY_EVIDENCE_V1'),
    engineVersion: z.string(),
    evaluatedConsumers: z.array(phase4ConsumerSchema),
    witnesses: z.array(serializedWitnessSchema),
    blockerSummary: z.array(serializedBlockerSchema),
    typeIRStats: z
      .object({
        totalNodesExtracted: z.number().int().nonnegative(),
        unsupportedNodes: z.number().int().nonnegative(),
        cycleBackreferencesUsed: z.number().int().nonnegative(),
        maxDepthReached: z.number().int().nonnegative()
      })
      .strict(),
    proofStats: z
      .object({
        compatibleCount: z.number().int().nonnegative(),
        incompatibleCount: z.number().int().nonnegative(),
        undecidableCount: z.number().int().nonnegative(),
        anyDependencyUndecidableCount: z.number().int().nonnegative()
      })
      .strict(),
    phase4Outcome: z
      .object({
        allConsumersEvaluated: z.boolean(),
        coverageGaps: z.array(z.string())
      })
      .strict()
  })
  .strict();

export const phase1ArtifactSchema = z
  .object({
    schemaVersion: z.literal('SAJIMORA_ANALYSIS_ARTIFACT_V2'),
    repository: z.object({ repositoryId: z.string().min(1) }).strict(),
    revisions: z
      .object({
        parent: z.object({ repositoryId: z.string(), commitSha: sha }).strict(),
        candidate: z
          .object({
            repositoryId: z.string(),
            commitSha: sha,
            parentSelection: z.object({ strategy: z.literal('EXPLICIT_PARENT'), selectedParentSha: sha }).strict()
          })
          .strict()
      })
      .strict(),
    adapter: z
      .object({
        id: z.string(),
        version: z.string(),
        capabilities: z.array(z.string()),
        selection: z
          .object({
            mode: z.enum(['auto', 'explicit']),
            evidence: z.array(
              z
                .object({
                  kind: z.enum(['CONFIGURATION', 'SOURCE_EXTENSION', 'PACKAGE_METADATA', 'CONFLICT']),
                  value: z.string()
                })
                .strict()
            )
          })
          .strict(),
        toolchain: z
          .object({
            compiler: z.object({ name: z.string(), version: z.string() }).strict(),
            repositoryDeclaredVersion: z.string().nullable(),
            mismatch: z.enum(['MATCH', 'MISMATCH', 'UNDETERMINED'])
          })
          .strict()
      })
      .strict(),
    dualProgram: z
      .object({
        parentStatus: z.enum(['BUILT', 'PARTIAL', 'FAILED']),
        candidateStatus: z.enum(['BUILT', 'PARTIAL', 'FAILED']),
        universe: z
          .object({
            parent: universe,
            candidate: universe,
            configurationRelation: z
              .object({
                status: z.enum(['EQUIVALENT', 'CHANGED_SUPPORTED', 'CHANGED_UNSUPPORTED', 'UNRESOLVED']),
                changes: z.array(
                  z
                    .object({
                      projectId: z.string(),
                      option: z.string(),
                      parent: z.unknown(),
                      candidate: z.unknown(),
                      supported: z.boolean()
                    })
                    .strict()
                )
              })
              .strict()
          })
          .strict()
      })
      .strict()
      .optional(),
    crossVersionIdentity: crossIdentity.optional(),
    semanticCompatibility: phase4ArtifactExtensionSchema.optional(),
    analysis: z
      .object({
        status: z.literal('COMPLETED'),
        changedFiles: z.array(relative),
        results: z.array(
          z
            .object({
              obligationId: z.string(),
              target: z
                .object({
                  name: z.string(),
                  kind: z.string(),
                  file: relative,
                  line: z.number().int().positive()
                })
                .strict(),
              verdict: z.enum(['VIOLATED', 'PRESERVED', 'UNKNOWN', 'INSUFFICIENT_EVIDENCE', 'NOT_APPLICABLE']),
              authority: z
                .object({
                  source: z.string(),
                  gate: z.string(),
                  reason: z.string()
                })
                .strict()
                .nullable()
              ,assurance: z.enum(['F0_FORMAL', 'COMPILER_STATIC', 'WITNESS', 'UNRESOLVED']).optional()
              ,evidence: z.unknown().optional()
              ,provenance: z.unknown().optional()
            })
            .strict()
        )
      })
      .strict()
    ,productionCertification: z.object({
      status: z.string(),
      verdict: z.enum(['VIOLATED', 'PRESERVED', 'UNKNOWN', 'INSUFFICIENT_EVIDENCE', 'NOT_APPLICABLE']),
      conservation: z.unknown(),
      scope: z.object({
        inputDomain: z.string(), coverageProfileId: z.string().nullable(),
        properties: z.array(z.string())
      }).strict().optional(),
      resources: z.object({
        durationMs: z.number().nonnegative(), sampledPeakProcessRssBytes: z.number().nonnegative(),
        workerHeapUsedBytes: z.number().nonnegative()
      }).strict().optional(),
      testDeferral: z.object({
        authorized: z.boolean(),
        reasonCode: z.string(),
        description: z.string()
      }).strict().optional()
    }).strict().optional()
  })
  .strict();

export interface ArtifactSerializationOptions {
  snapshotRoots?: readonly string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function canonicalString(value: string, snapshotRoots: readonly string[]): string {
  let result = value.replace(/\\/g, '/').replace(/\b([A-Z]):/g, (_, drive: string) => `${drive.toLowerCase()}:`);
  for (const root of [...snapshotRoots]
    .map(root => root.replace(/\\/g, '/').replace(/\b([A-Z]):/g, (_, drive: string) => `${drive.toLowerCase()}:`))
    .sort((a, b) => b.length - a.length)) {
    result = result.replace(new RegExp(escapeRegExp(root), 'gi'), '.');
  }
  result = result.replace(/(?:[a-z]:)?\/(?:users\/[^/'"\s]+\/appdata\/local\/temp|tmp|var\/folders)(?:\/[^'"\s]*)?/gi, '<temporary>');
  result = result.replace(/\b[a-z]:\/[\w@%+.,~:/-]+/gi, '<external-path>');
  return result;
}

function canonical(value: unknown, snapshotRoots: readonly string[], parentKey?: string): unknown {
  if (typeof value === 'string') return canonicalString(value, snapshotRoots);
  if (Array.isArray(value)) return value.map(item => canonical(item, snapshotRoots, parentKey));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .filter(key => !(key === 'resources' && (parentKey === 'productionCertification' || parentKey === 'certification')))
        .sort()
        .map(key => [key, canonical((value as Record<string, unknown>)[key], snapshotRoots, key)])
    );
  }
  return value;
}

export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024; // 20 MiB admission limit

export function serializePhase1Artifact(
  artifact: Phase1Artifact,
  options: ArtifactSerializationOptions = {}
): string {
  const serialized = JSON.stringify(canonical(phase1ArtifactSchema.parse(artifact), options.snapshotRoots ?? []), null, 2) + '\n';
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact size (${(byteLength / (1024 * 1024)).toFixed(2)} MiB) exceeds maximum allowed write size of 20 MiB.`);
  }
  return serialized;
}

export function writeArtifactAtomically(destination: string, contents: string): void {
  const byteLength = Buffer.byteLength(contents, 'utf8');
  if (byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact size (${(byteLength / (1024 * 1024)).toFixed(2)} MiB) exceeds maximum allowed write size of 20 MiB.`);
  }
  const directory = path.dirname(destination);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error('Output directory does not exist.');
  }
  if (fs.existsSync(destination) && fs.statSync(destination).isDirectory()) {
    throw new Error('Output destination is a directory.');
  }
  const temporary = path.join(directory, `.${path.basename(destination)}.sajimora-${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx' });
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}
