/**
 * CrossLanguageContracts.ts
 *
 * Versioned, serialisation-safe DTOs for the Java → TypeScript cross-language
 * impact analysis pipeline.  These types appear in JSON output and in test
 * assertions; they must never contain compiler/AST objects, absolute temp
 * paths, credentials, or whole source files.
 *
 * Schema version: SAJIMORA_CROSS_LANGUAGE_IMPACT_V1
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Schema / assurance constants
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 'SAJIMORA_CROSS_LANGUAGE_IMPACT_V1' as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

export const ASSURANCE = 'ADVISORY_ONLY' as const;
export type Assurance = typeof ASSURANCE;

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type CrossLanguageVerdict =
  | 'LIKELY_VIOLATED'
  | 'LIKELY_PRESERVED'
  | 'INCONCLUSIVE'
  | 'ANALYSIS_ERROR';

// ---------------------------------------------------------------------------
// Property being assessed
// ---------------------------------------------------------------------------

export type AssessedProperty = 'JAVA_JSON_TS_RESPONSE_COMPATIBILITY';

// ---------------------------------------------------------------------------
// Snapshot identity
// ---------------------------------------------------------------------------

/**
 * Uniquely identifies a repository + analysis pair.
 * All repository-relative paths in the output are POSIX.
 */
export interface SnapshotIdentity {
  /** Stable repository identifier (e.g. "git-root:<sha>"). */
  readonly repositoryId: string;
  /** SHA-1 of the immutable parent commit. */
  readonly parentCommit: string;
  /**
   * Identifier of the candidate snapshot.  For a committed candidate this
   * equals the commit SHA; for a working-tree capture it is a
   * content-hash-based ID prefixed with "working-tree:".
   */
  readonly candidateSnapshot: string;
}

// ---------------------------------------------------------------------------
// Analysis scope
// ---------------------------------------------------------------------------

export type FrameworkProfile = 'SPRING_MVC';
export type CodecProfile = 'JACKSON_DEFAULT_V1' | 'JACKSON_NAMING_V2';
export type ClientProfile = 'STATIC_FETCH_V1' | 'NATIVE_HTTP_V2';

export interface AnalysisScope {
  readonly framework: FrameworkProfile;
  readonly codec: CodecProfile;
  readonly client: ClientProfile;
  /**
   * true only when every changed endpoint has been linked, every linked TS
   * client project (plus its reverse-consumer closure) has been analysed,
   * and no unsupported codec/wrapper remained in scope.
   */
  readonly complete: boolean;
  readonly clientAdapters?: readonly string[];
  readonly parentConfigurationFingerprint?: string;
  readonly candidateConfigurationFingerprint?: string;
  readonly toolchainFingerprint?: string;
}

// ---------------------------------------------------------------------------
// Evidence items
// ---------------------------------------------------------------------------

export type EvidenceKind = 'JAVA_SOURCE' | 'TS_SOURCE' | 'CONFIG_FILE' | 'MANIFEST' | 'TELEMETRY';

export interface EvidenceItem {
  readonly kind: EvidenceKind;
  /** Repository-relative POSIX path. */
  readonly file: string;
  /** SHA-256 hex of the file bytes at the time of capture. */
  readonly sha256: string;
  readonly line?: number;
}

// ---------------------------------------------------------------------------
// Endpoint location
// ---------------------------------------------------------------------------

export interface EndpointLocation {
  readonly method: string;
  /** Normalised Spring-style path, e.g. "/api/users/{id}". */
  readonly path: string;
  /** Repository-relative POSIX path of the Java controller file. */
  readonly javaFile: string;
  readonly line: number;
}

// ---------------------------------------------------------------------------
// TypeScript client reference
// ---------------------------------------------------------------------------

/** How the TS side validates the response shape. */
export type TsExpectationKind =
  | 'TYPE_ASSERTION'   // `as T` — claim only, no runtime check
  | 'ZOD_DECODER'      // Zod parse/safeParse — runtime validated
  | 'INFERRED_TYPE'    // return-type inference from declared interface
  | 'UNKNOWN';

export interface TypeScriptClientRef {
  /** Repository-relative POSIX path. */
  readonly file: string;
  readonly line: number;
  /** Human-readable description of the expected wire contract. */
  readonly expectation: string;
  readonly expectationKind: TsExpectationKind;
}

// ---------------------------------------------------------------------------
// Consumer site
// ---------------------------------------------------------------------------

export interface ConsumerSite {
  readonly operation?:'PROPERTY_READ'|'METHOD_CALL';
  readonly sourceSha256?:string;
  readonly guards?:readonly string[];
  /** Repository-relative POSIX path. */
  readonly file: string;
  readonly line: number;
  readonly column?: number;
  /** Source text excerpt showing how the value is consumed. */
  readonly usage: string;
  readonly consumerKind?: 'PROPERTY_ACCESS' | 'DESTRUCTURING' | 'JSX_EXPRESSION' | 'ARGUMENT' | 'ASSIGNMENT' | 'RETURN' | 'BARREL_EXPORT' | 'TYPE_ALIAS';
  readonly propertyPath?: string;
  readonly evidenceChain?: readonly string[];
}

// ---------------------------------------------------------------------------
// Finding
// ---------------------------------------------------------------------------

export interface CrossLanguageFinding {
  /**
   * Stable, deterministic ID derived from endpoint + wire path + change
   * direction.  Must not use timestamps or random values.
   */
  readonly id: string;
  readonly endpoint: EndpointLocation;
  /** JSONPath-style wire property path, e.g. "$.displayName". */
  readonly wirePath: string;
  readonly change: {
    readonly before: string;
    readonly after: string;
  };
  readonly typescriptClient: TypeScriptClientRef;
  readonly consumers: readonly ConsumerSite[];
  readonly evidence: readonly EvidenceItem[];
  /**
   * A model-derived counterexample JSON value — labelled as such.
   * Never an observed production payload.
   */
  readonly examplePayload?: Record<string, unknown>;
  readonly repairHint: string;
}

// ---------------------------------------------------------------------------
// Blockers & Reason Codes
// ---------------------------------------------------------------------------

export type BlockerCode =
  | 'UNRESOLVED_ROUTE'
  | 'DYNAMIC_URL'
  | 'AMBIGUOUS_ENDPOINT'
  | 'AMBIGUOUS_ENDPOINT_MAPPING'
  | 'UNLINKED_CHANGED_ENDPOINT'
  | 'UNSUPPORTED_FRAMEWORK'
  | 'UNSUPPORTED_SERIALIZER'
  | 'CUSTOM_JACKSON_SERIALIZER'
  | 'CUSTOM_JACKSON_DESERIALIZER'
  | 'UNSUPPORTED_JACKSON_FEATURE'
  | 'UNRESOLVED_JACKSON_DEDUCTION'
  | 'UNRESOLVED_JACKSON_CREATOR_PARAMETER_NAMES'
  | 'AMBIGUOUS_WIRE_PROPERTY'
  | 'UNRESOLVED_JAVA_GENERIC'
  | 'UNSUPPORTED_LOMBOK_ACCESSOR'
  | 'UNRESOLVED_TS_CLIENT'
  | 'UNRESOLVED_TS_TYPE'
  | 'UNRESOLVED_TS_PROJECT'
  | 'UNSUPPORTED_CLIENT_WRAPPER'
  | 'UNRESOLVED_HTTP_WRAPPER'
  | 'UNRESOLVED_CONSUMER_ALIAS'
  | 'INCOMPLETE_CONSUMER_GRAPH'
  | 'NO_CONSUMER_CONTRACTS'
  | 'UNSUPPORTED_VALIDATION_RULE'
  | 'DYNAMIC_ZOD_SCHEMA'
  | 'DYNAMIC_ZOD_TRANSFORM'
  | 'UNSUPPORTED_ZOD_TYPE'
  | 'BUDGET_EXCEEDED'
  | 'EXTERNAL_CONSUMER_BOUNDARY'
  | 'UNRESOLVED_JACKSON_CONFIG'
  | 'UNSAFE_FILE_PATH'
  | 'FILE_READ_ERROR'
  | 'DUPLICATE_FILE_PATH'
  | 'FILE_CHANGED_DURING_CAPTURE'
  | 'MISSING_PARENT_BLOB'
  | 'TOOL_FAILURE';

export interface AnalysisBlocker {
  readonly code: BlockerCode;
  readonly message: string;
  /** Repository-relative POSIX path of the affected file, if applicable. */
  readonly file?: string;
}

// ---------------------------------------------------------------------------
// Completeness Accounting
// ---------------------------------------------------------------------------

export interface CompletenessAccounting {
  readonly endpointResolved: boolean;
  readonly javaWireResolved: boolean;
  readonly tsContractResolved: boolean;
  readonly requestResolved: boolean;
  readonly responseResolved: boolean;
  readonly consumerTraversalComplete: boolean;
  readonly unresolvedEvidence: readonly string[];
}

// ---------------------------------------------------------------------------
// Counts summary
// ---------------------------------------------------------------------------

export interface AnalysisCounts {
  readonly changedEndpoints: number;
  readonly linkedEndpoints: number;
  readonly affectedConsumers: number;
  readonly unresolvedLinks: number;
}

export interface TelemetryRef {
  readonly artifactSha256: string;
  readonly serviceId: string;
  readonly totalObservations: number;
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

export interface CrossLanguageImpactReport {
  readonly delta?: {readonly newFindings: readonly CrossLanguageFinding[]; readonly existingFindings: readonly CrossLanguageFinding[]; readonly resolvedFindings: readonly CrossLanguageFinding[]};
  readonly schemaVersion: SchemaVersion;
  readonly assurance: Assurance;
  readonly verdict: CrossLanguageVerdict;
  readonly property: AssessedProperty;
  readonly repository: SnapshotIdentity;
  readonly scope: AnalysisScope;
  readonly completeness?: CompletenessAccounting;
  readonly findings: readonly CrossLanguageFinding[];
  readonly scopedChanges?: import('./ScopedChangeAssessment').ScopedChangeResults;
  readonly blockers: readonly AnalysisBlocker[];
  readonly counts: AnalysisCounts;
  readonly telemetry?: TelemetryRef;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Type-guard: checks that an unknown value has the shape of a
 * CrossLanguageImpactReport.  Validates required discriminant fields only;
 * full structural validation should use a JSON Schema validator.
 */
export function isCrossLanguageImpactReport(
  value: unknown
): value is CrossLanguageImpactReport {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['schemaVersion'] === SCHEMA_VERSION &&
    v['assurance'] === ASSURANCE &&
    typeof v['verdict'] === 'string' &&
    typeof v['property'] === 'string' &&
    typeof v['repository'] === 'object' &&
    typeof v['scope'] === 'object' &&
    Array.isArray(v['findings']) &&
    Array.isArray(v['blockers']) &&
    typeof v['counts'] === 'object'
  );
}

/**
 * Build a stable, deterministic finding ID from its constituent parts.
 * Uses only the stable identity fields — never timestamps or UUIDs.
 */
export function buildFindingId(parts: {
  method: string;
  path: string;
  javaFile: string;
  wirePath: string;
}): string {
  const raw = [parts.method, parts.path, parts.javaFile, parts.wirePath]
    .map(s => s.replace(/\\/g, '/'))
    .join('\0');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Build a stable candidate snapshot ID from a sorted list of
 * (repository-relative path, sha256) pairs for working-tree captures.
 */
export function buildWorkingTreeSnapshotId(
  files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>
): string {
  const sorted = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(f => `${f.path}:${f.sha256}`)
    .join('\n');
  return `working-tree:${createHash('sha256').update(sorted).digest('hex').slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// INCONCLUSIVE factory (used by CLI skeleton and blockers-only paths)
// ---------------------------------------------------------------------------

export function makeInconclusiveReport(opts: {
  repository: SnapshotIdentity;
  scope?: Partial<AnalysisScope>;
  blockers: readonly AnalysisBlocker[];
}): CrossLanguageImpactReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    assurance: ASSURANCE,
    verdict: 'INCONCLUSIVE',
    property: 'JAVA_JSON_TS_RESPONSE_COMPATIBILITY',
    repository: opts.repository,
    scope: {
      framework: opts.scope?.framework ?? 'SPRING_MVC',
      codec: opts.scope?.codec ?? 'JACKSON_DEFAULT_V1',
      client: opts.scope?.client ?? 'STATIC_FETCH_V1',
      complete: opts.scope?.complete ?? false,
    },
    findings: [],
    blockers: opts.blockers,
    counts: {
      changedEndpoints: 0,
      linkedEndpoints: 0,
      affectedConsumers: 0,
      unresolvedLinks: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// ANALYSIS_ERROR factory
// ---------------------------------------------------------------------------

export function makeErrorReport(opts: {
  repository: SnapshotIdentity;
  blockerCode: BlockerCode;
  message: string;
}): CrossLanguageImpactReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    assurance: ASSURANCE,
    verdict: 'ANALYSIS_ERROR',
    property: 'JAVA_JSON_TS_RESPONSE_COMPATIBILITY',
    repository: opts.repository,
    scope: {
      framework: 'SPRING_MVC',
      codec: 'JACKSON_DEFAULT_V1',
      client: 'STATIC_FETCH_V1',
      complete: false,
    },
    findings: [],
    blockers: [{ code: opts.blockerCode, message: opts.message }],
    counts: {
      changedEndpoints: 0,
      linkedEndpoints: 0,
      affectedConsumers: 0,
      unresolvedLinks: 0,
    },
  };
}
