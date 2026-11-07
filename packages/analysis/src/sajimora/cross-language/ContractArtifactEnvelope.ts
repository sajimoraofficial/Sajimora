/**
 * ContractArtifactEnvelope.ts
 *
 * Defines the shared artifact envelope and payload schemas for the polyrepo
 * Contract IR Artifact Exchange. Backend and frontend repositories export
 * sealed, versioned artifacts that CI pipelines ingest and compare without
 * requiring direct repository access.
 *
 * Architecture: POLYREPO_CONTRACT_EXCHANGE_ARCHITECTURE.md
 *
 * Integrity guarantee:
 *   The SHA-256 digest in the envelope covers the canonical JSON serialization
 *   of the envelope EXCLUDING the `integrity` and `signature` top-level fields.
 *   Canonical JSON follows RFC 8785 key-sort ordering with no trailing
 *   whitespace. Consumers MUST verify this digest before trusting payload data.
 *   A digest identifies bytes; it does NOT authenticate the producer.
 *   Producer authentication is delegated to the publication channel (e.g.
 *   signed GitHub release, Artifactory IAM policy, or explicit signature field).
 *
 * Verdict precedence (highest wins):
 *   ANALYSIS_ERROR > LIKELY_VIOLATED > INCONCLUSIVE > LIKELY_PRESERVED
 *   A single LIKELY_PRESERVED row does NOT establish overall preservation.
 *   Overall preservation is prohibited unless every relevant obligation is
 *   fully resolved.
 *
 * Missing-export handling:
 *   Missing facts inside an incomplete extraction scope are UNRESOLVED, never
 *   deletions. Definite violations may be reported alongside blockers.
 *   LIKELY_PRESERVED is prohibited when `completeness.complete === false`.
 *
 * All proposed CLI commands (export-contract, check-contract) are PROPOSED
 * capabilities; they are not yet implemented.
 */

import { createHash } from 'node:crypto';
import { validateArtifactFields } from './ArtifactSchemaValidation';
import { SCHEMA_VERSION } from './CrossLanguageContracts';
import type { ConsumerSite } from './CrossLanguageContracts';
import type { EndpointContract, WireType, ObjectWireType, RefWireType } from './CanonicalContractIR';
import { mkRefWireType } from './CanonicalContractIR';

export { RefWireType, mkRefWireType };

// ---------------------------------------------------------------------------
// Envelope schema version
// ---------------------------------------------------------------------------

export const ARTIFACT_ENVELOPE_VERSION = 'SAJIMORA_CONTRACT_ARTIFACT_V1' as const;
export const ARTIFACT_ENVELOPE_VERSION_V2 = 'SAJIMORA_CONTRACT_ARTIFACT_V2' as const;
export type ArtifactEnvelopeVersion =
  | typeof ARTIFACT_ENVELOPE_VERSION
  | typeof ARTIFACT_ENVELOPE_VERSION_V2;

// ---------------------------------------------------------------------------
// Producer kind
// ---------------------------------------------------------------------------

export type ArtifactKind = 'BACKEND_CONTRACT' | 'FRONTEND_CONTRACT';

// ---------------------------------------------------------------------------
// Extraction profile
// ---------------------------------------------------------------------------

/**
 * Records the exact tool configuration used to produce the artifact.
 * Changes to any field make the artifact incompatible with contracts
 * produced under a different profile. CI MUST reject mismatched profiles
 * unless a known migration is explicitly configured.
 */
export interface ExtractionProfile {
  /** Sajimora tool version (e.g. "0.10.2"). */
  readonly toolVersion: string;
  /** Java extraction framework (e.g. "SPRING_MVC"). */
  readonly frameworkProfile?: string;
  /** Codec / serialization configuration (e.g. "JACKSON_DEFAULT_V1"). */
  readonly codecProfile?: string;
  /** TypeScript client kind (e.g. "FETCH", "AXIOS"). */
  readonly clientProfile?: string;
  /**
   * SHA-256 hex of the effective Jackson / serialization configuration
   * (application.properties + ObjectMapper bean source), or null if not
   * captured. A missing fingerprint is an incomplete-export blocker.
   */
  readonly configFingerprint: string | null;
}

// ---------------------------------------------------------------------------
// Snapshot reference
// ---------------------------------------------------------------------------

/**
 * Identifies the exact repository state that was extracted.
 * Both `parentCommit` and `candidateSnapshot` are required; the artifact is
 * meaningless without knowing exactly which code was analyzed.
 */
export interface ArtifactSnapshotRef {
  /** Stable repository canonical identifier (e.g. "github.com/org/repo"). */
  readonly repositoryId: string;
  /** Service or application identifier within the repository. */
  readonly serviceId: string;
  /** API version label (e.g. "v1", "2026-10"). */
  readonly apiVersion: string | null;
  /** SHA-1 of the immutable parent (base) commit. */
  readonly parentCommit: string;
  /**
   * Candidate snapshot identifier. For a committed candidate this is the
   * commit SHA; for a working-tree capture it is a content-hash-based ID
   * prefixed with "working-tree:".
   */
  readonly candidateSnapshot: string;
}

// ---------------------------------------------------------------------------
// Completeness state
// ---------------------------------------------------------------------------

export interface ArtifactCompleteness {
  /** true only when every endpoint has been fully extracted without blockers. */
  readonly complete: boolean;
  /** List of UNRESOLVED endpoints or symbols (see missing-export handling). */
  readonly unresolvedEndpoints: readonly string[];
  readonly blockers: readonly ArtifactBlocker[];
}

export interface ArtifactBlocker {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
}

// ---------------------------------------------------------------------------
// Backend payload
// ---------------------------------------------------------------------------

/**
 * Backend-side wire contract.
 * Contains ONLY wire-visible shapes — no implementation code, DB queries,
 * or business logic. Endpoint names, shapes, and base URL mappings can still
 * disclose sensitive API structure. Apply publication-channel access controls
 * accordingly.
 */
export interface BackendContractPayload {
  readonly serializationAssumptions?:readonly string[];
  /**
   * Base URL patterns as declared in the service configuration
   * (e.g. ["https://api.example.com", "/api"]).
   * Required for proxy-prefix resolution.
   */
  readonly baseUrls: readonly string[];
  /**
   * Known proxy prefix patterns that the gateway strips before routing
   * (e.g. ["/internal", "/svc/orders"]).
   */
  readonly proxyPrefixes: readonly string[];
  /**
   * All extracted endpoint contracts, including direction (REQUEST/RESPONSE)
   * and route constraints. Incomplete extraction appears as an
   * UNRESOLVED entry in `completeness.unresolvedEndpoints`, never as deletion.
   */
  readonly endpoints: readonly EndpointContract[];
  readonly type_pool?: Record<string, WireType>;
  readonly path_pool?: readonly string[];
}

// ---------------------------------------------------------------------------
// Frontend payload
// ---------------------------------------------------------------------------

/**
 * Frontend-side consumer contract.
 * Contains HTTP client calls, request shapes, response expectations,
 * decoder behavior, and consumer file locations.
 *
 * Strict-decoder compatibility rule:
 *   An added backend response field is LIKELY_VIOLATED if the frontend decoder
 *   is strict AND may reject the extra field. It is LIKELY_PRESERVED for this
 *   obligation only if the decoder is passthrough. Neither result establishes
 *   overall compatibility without all other obligations resolved.
 */
export interface FrontendContractPayload {
  readonly dependencyContext?: ReturnType<import('./DependencyDeclarationContext').DependencyDeclarationContext['manifest']>;
  readonly interceptorEvidence?: import('./AngularInterceptorSummary').InterceptorEvidence;
  /**
   * All HTTP client call contracts extracted from the frontend codebase.
   * Includes request shapes, response expectations, and decoder kind.
   */
  readonly clientContracts: readonly FrontendClientContract[];
  readonly type_pool?: Record<string, WireType>;
  readonly path_pool?: readonly string[];
}

export type DecoderKind =
  | 'ZOD_STRICT'        // z.object().strict() — rejects extra fields
  | 'ZOD_PASSTHROUGH'   // z.object().passthrough()
  | 'ZOD_DEFAULT'       // z.object() — strips extra fields by default
  | 'TYPE_ASSERTION'    // `as T` — no runtime check
  | 'INFERRED_TYPE'     // return-type inference — no runtime check
  | 'UNKNOWN';

export interface ConsumerLocation extends ConsumerSite {
  /** Repository-relative POSIX path. */
  readonly file: string;
  readonly line: number;
  readonly column?: number;
  readonly usage: string;
}

export interface FrontendClientContract {
  readonly requestTransport?:import('./TransportBody').TransportBody;
  readonly requestEffectsQualified?:boolean;
  /** Source-proved absent body preserved through the request pipeline; excludes query/header acceptance. */
  readonly absentRequestBodyQualified?:boolean;
  readonly queryParametersPreserved?:boolean;
  readonly routeDomain?:import('./RouteDomain').RouteDomain;
  readonly responseProjections?:readonly import('./AngularInterceptorSummary').ResponseProjection[];
  readonly httpOptionsEvidence?: import('./HttpClientAdapters').HttpOptionsEvidence;
  readonly callIdentity?: import('./CallIdentity').CallIdentity;
  readonly responseUsage?: readonly import('./CrossLanguageContracts').ConsumerSite[];
  readonly responseEffectsQualified?: boolean;
  readonly responseEffectAssumptions?:readonly string[];
  /** Target API identity, distinct from the frontend application's producer identity. */
  readonly targetServiceId?: string;
  readonly targetApiVersion?: string;
  readonly sourceSha256?: string;
  readonly consumerTraversalComplete?: boolean;
  /** Normalized HTTP method (GET, POST, etc.). */
  readonly httpMethod: string;
  /** Normalized route (e.g. "/api/orders/{id}"). */
  readonly normalizedRoute: string;
  /** Wire type of the request body, or null if no body. */
  readonly requestBody: WireType | null;
  /** Expected response wire type. */
  readonly expectedResponse: WireType;
  readonly decoderKind: DecoderKind;
  /** Source locations of all consumer sites for this contract. */
  readonly consumers: readonly ConsumerLocation[];
  /** Unresolved evidence (e.g. imported type references that could not be resolved). */
  readonly unresolvedEvidence: readonly string[];
  /** Repository-relative POSIX path to the file that makes this HTTP call. */
  readonly sourceFile: string;
  readonly sourceLine: number;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Shared artifact envelope wrapping either a backend or frontend payload.
 *
 * Integrity:
 *   `integrity.sha256` is the SHA-256 hex digest of the canonical JSON
 *   serialization of this envelope with the `integrity` field set to null
 *   and the `signature` field omitted. Consumers MUST recompute and verify
 *   this digest before processing the payload.
 *
 * Authentication:
 *   `signature` is OPTIONAL. When absent, authentication is delegated to
 *   the publication channel (e.g. Artifactory IAM, GitHub release asset).
 *   CI MUST reject unauthenticated artifacts if the configured policy
 *   requires signatures. Missing or incompatible artifacts produce
 *   INCONCLUSIVE or ANALYSIS_ERROR, not silent preservation.
 */
export interface ContractArtifactEnvelope {
  readonly envelopeVersion: ArtifactEnvelopeVersion;
  /** Cross-reference to the impact report schema version. */
  readonly reportSchemaVersion: typeof SCHEMA_VERSION;
  readonly kind: ArtifactKind;
  readonly snapshot: ArtifactSnapshotRef;
  readonly profile: ExtractionProfile;
  readonly completeness: ArtifactCompleteness;
  /**
   * SHA-256 digest of the canonical envelope JSON (integrity field set to
   * null, signature field omitted). Null only during construction before
   * `sealEnvelope()` is called.
   */
  readonly integrity: { readonly sha256: string } | null;
  /**
   * Optional cryptographic signature of the integrity digest.
   * Format is publication-channel specific (e.g. JWS compact serialization).
   */
  readonly signature?: string;
  readonly payload: BackendContractPayload | FrontendContractPayload;
}

// ---------------------------------------------------------------------------
// Canonical JSON serialization (RFC 8785 key-sort, no whitespace)
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic canonical JSON string.
 * Keys are sorted lexicographically at every object level.
 * Arrays preserve insertion order (as per RFC 8785).
 * The resulting bytes are the input to the SHA-256 integrity digest.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      throw new Error('Forbidden non-finite number in canonicalJson');
    }
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return '{' + keys
      .filter(k => obj[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * Compute the SHA-256 integrity digest for an envelope.
 * The envelope is serialized with `integrity` set to null and `signature`
 * omitted, then hashed. This matches what `sealEnvelope` stores.
 */
export function computeEnvelopeDigest(
  envelope: Omit<ContractArtifactEnvelope, 'integrity' | 'signature'>
): string {
  const forDigest: Record<string, unknown> = {
    ...envelope,
    integrity: null,
  };
  // signature is excluded from the digest input
  delete forDigest['signature'];
  return createHash('sha256').update(canonicalJson(forDigest)).digest('hex');
}

// ---------------------------------------------------------------------------
// Envelope construction helpers
// ---------------------------------------------------------------------------

/**
 * Seal an artifact envelope by computing and embedding the SHA-256 integrity
 * digest. Call this as the final step before writing the artifact to disk or
 * publishing it. The returned envelope is immutable.
 */
export function sealEnvelope(
  draft: Omit<ContractArtifactEnvelope, 'integrity'>
): ContractArtifactEnvelope {
  const digest = computeEnvelopeDigest(draft);
  return { ...draft, integrity: { sha256: digest } };
}

/**
 * Verify the integrity digest of a sealed envelope.
 * Returns true if the digest matches, false otherwise.
 * Throws if `integrity` is null (envelope was not sealed).
 */
export function verifyEnvelopeIntegrity(envelope: ContractArtifactEnvelope): boolean {
  if (envelope.integrity === null) {
    throw new Error('ContractArtifactEnvelope: integrity field is null; envelope was not sealed.');
  }
  const expected = computeEnvelopeDigest(envelope);
  return envelope.integrity.sha256 === expected;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Keep small envelopes readable and large envelopes compact. Whitespace must not
 * cause an otherwise admissible contract to exceed the reader's byte limit.
 */
export function serializeEnvelope(envelope: ContractArtifactEnvelope): string {
  const compact = JSON.stringify(envelope);
  return Buffer.byteLength(compact) > 1024 * 1024 ? compact : JSON.stringify(envelope, null, 2);
}

/**
 * Parse and lightly validate an artifact envelope from a JSON string.
 * Throws on JSON parse errors or missing discriminant fields.
 * Does NOT verify the integrity digest — call `verifyEnvelopeIntegrity`
 * separately after parsing.
 */
export function parseEnvelope(json: string): ContractArtifactEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`ContractArtifactEnvelope: JSON parse error: ${(err as Error).message}`);
  }
  if (!isContractArtifactEnvelope(parsed)) {
    throw new Error(
      `ContractArtifactEnvelope: JSON does not match expected schema. ` +
      `Expected envelopeVersion="${ARTIFACT_ENVELOPE_VERSION}" or "${ARTIFACT_ENVELOPE_VERSION_V2}".`
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isContractArtifactEnvelope(value: unknown): value is ContractArtifactEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v['envelopeVersion'] === ARTIFACT_ENVELOPE_VERSION || v['envelopeVersion'] === ARTIFACT_ENVELOPE_VERSION_V2) &&
    v['reportSchemaVersion'] === SCHEMA_VERSION &&
    (v['kind'] === 'BACKEND_CONTRACT' || v['kind'] === 'FRONTEND_CONTRACT') &&
    typeof v['snapshot'] === 'object' && v['snapshot'] !== null &&
    typeof v['profile'] === 'object' && v['profile'] !== null &&
    typeof v['completeness'] === 'object' && v['completeness'] !== null &&
    typeof v['payload'] === 'object' && v['payload'] !== null &&
    validateArtifactFields(value)
  );
}

// ---------------------------------------------------------------------------
// Verdict precedence
// ---------------------------------------------------------------------------

export type ArtifactComparisonVerdict =
  | 'LIKELY_VIOLATED'
  | 'LIKELY_PRESERVED'
  | 'INCONCLUSIVE'
  | 'ANALYSIS_ERROR';

const VERDICT_RANK: Record<ArtifactComparisonVerdict, number> = {
  ANALYSIS_ERROR: 3,
  LIKELY_VIOLATED: 2,
  INCONCLUSIVE: 1,
  LIKELY_PRESERVED: 0,
};

/**
 * Merge two verdicts, returning the one with higher precedence.
 * ANALYSIS_ERROR > LIKELY_VIOLATED > INCONCLUSIVE > LIKELY_PRESERVED.
 */
export function mergeVerdicts(
  a: ArtifactComparisonVerdict,
  b: ArtifactComparisonVerdict
): ArtifactComparisonVerdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

/**
 * Determine the overall verdict from a list of per-obligation verdicts.
 * If any completeness flag is unresolved (complete === false) and no
 * violations are present, returns INCONCLUSIVE rather than LIKELY_PRESERVED.
 */
export function resolveOverallVerdict(
  perObligationVerdicts: readonly ArtifactComparisonVerdict[],
  completeness: ArtifactCompleteness
): ArtifactComparisonVerdict {
  const merged = perObligationVerdicts.reduce(
    (acc, v) => mergeVerdicts(acc, v),
    'LIKELY_PRESERVED' as ArtifactComparisonVerdict
  );
  // Prohibit LIKELY_PRESERVED when extraction was incomplete.
  if (merged === 'LIKELY_PRESERVED' && !completeness.complete) {
    return 'INCONCLUSIVE';
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Type pool interning & expansion (Envelope V2 DTO deduplication)
// ---------------------------------------------------------------------------

/**
 * Computes a deterministic canonical key for an ObjectWireType.
 * Formats:
 *   - `java:<FQCN>` for Java DTOs
 *   - `ts:<path>#<symbol>` for TypeScript symbols
 *   - `anon:<hash16>` for anonymous or unkeyed objects (SHA-256 hex slice)
 */
export function computeCanonicalWireTypeKey(
  wireType: ObjectWireType,
  defaultLanguage?: 'JAVA' | 'TYPESCRIPT'
): string {
  if (wireType.name) {
    if (
      wireType.name.startsWith('java:') ||
      wireType.name.startsWith('ts:') ||
      wireType.name.startsWith('anon:')
    ) {
      return wireType.name;
    }
  }

  const lang = wireType.provenance?.language ?? defaultLanguage;

  if (lang === 'JAVA') {
    const symbol = wireType.provenance?.astIdentity || wireType.name;
    if (symbol) {
      return `java:${symbol}`;
    }
  } else if (lang === 'TYPESCRIPT') {
    const symbol = wireType.provenance?.astIdentity || wireType.name;
    const file = wireType.provenance?.file;
    if (file && symbol) {
      return `ts:${file}#${symbol}`;
    } else if (symbol) {
      return `ts:#${symbol}`;
    }
  } else if (wireType.name) {
    if (wireType.name.includes('.')) {
      return `java:${wireType.name}`;
    }
  }

  // Structural canonical JSON hash without provenance to allow deduplication of identical anonymous shapes
  const stripProvenance = (w: unknown): unknown => {
    if (w === null || typeof w !== 'object') return w;
    if (Array.isArray(w)) return w.map(stripProvenance);
    const obj = w as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'provenance') continue;
      copy[k] = stripProvenance(v);
    }
    return copy;
  };

  const hash16 = createHash('sha256')
    .update(canonicalJson(stripProvenance(wireType)))
    .digest('hex')
    .slice(0, 16);
  return `anon:${hash16}`;
}

/**
 * Scans through all client contracts or endpoint contracts in a payload.
 * For repeated complex ObjectWireType shapes (appearing >= 2 times), interns them
 * into `type_pool` keyed deterministically by canonical name (`java:<FQCN>`,
 * `ts:<path>#<symbol>`, or `anon:<hash16>`) and replaces repeated occurrences
 * with `mkRefWireType(canonicalKey)`.
 *
 * Preserves all original contract fields and returns an interned copy.
 */
export function internTypePool<
  T extends FrontendContractPayload | BackendContractPayload | ContractArtifactEnvelope
>(target: T): T {
  // Support wrapping ContractArtifactEnvelope
  if (
    typeof target === 'object' &&
    target !== null &&
    'envelopeVersion' in target &&
    'payload' in target
  ) {
    const env = target as ContractArtifactEnvelope;
    const internedPayload = internTypePool(env.payload);
    return {
      ...env,
      envelopeVersion: ARTIFACT_ENVELOPE_VERSION_V2,
      payload: internedPayload,
    } as T;
  }

  const payload = target as FrontendContractPayload | BackendContractPayload;
  const isBackend = 'endpoints' in payload;
  const defaultLanguage: 'JAVA' | 'TYPESCRIPT' = isBackend ? 'JAVA' : 'TYPESCRIPT';

  // Step 1: Scan and count all ObjectWireType shapes
  const counts = new Map<string, { count: number; wireType: ObjectWireType }>();

  const scanWireType = (wire: WireType | null | undefined): void => {
    if (!wire || typeof wire !== 'object') return;
    if (
      wire.kind === 'REF' ||
      wire.kind === 'PRIMITIVE' ||
      wire.kind === 'LITERAL' ||
      wire.kind === 'UNKNOWN' ||
      wire.kind === 'ENUM'
    ) {
      return;
    }
    if (wire.kind === 'NULLABLE' || wire.kind === 'OPTIONAL') {
      scanWireType(wire.innerType);
      return;
    }
    if (wire.kind === 'ARRAY') {
      scanWireType(wire.elementType);
      if (wire.tupleElements) {
        for (const el of wire.tupleElements) scanWireType(el);
      }
      return;
    }
    if (wire.kind === 'MAP') {
      scanWireType(wire.keyType);
      scanWireType(wire.valueType);
      return;
    }
    if (wire.kind === 'UNION') {
      for (const t of wire.types) scanWireType(t);
      return;
    }
    if (wire.kind === 'OBJECT') {
      const key = computeCanonicalWireTypeKey(wire, defaultLanguage);
      const existing = counts.get(key);
      if (existing) {
        existing.count++;
      } else {
        counts.set(key, { count: 1, wireType: wire });
      }
      for (const prop of wire.properties) {
        scanWireType(prop.type);
      }
    }
  };

  if (isBackend) {
    const bp = payload as BackendContractPayload;
    for (const ep of bp.endpoints) {
      scanWireType(ep.body);
      if (ep.pathParameters) for (const p of ep.pathParameters) scanWireType(p.type);
      if (ep.queryParameters) for (const p of ep.queryParameters) scanWireType(p.type);
      if (ep.headers) for (const p of ep.headers) scanWireType(p.type);
    }
  } else {
    const fp = payload as FrontendContractPayload;
    for (const cc of fp.clientContracts) {
      scanWireType(cc.requestBody);
      scanWireType(cc.expectedResponse);
    }
  }

  // Filter repeated shapes (count >= 2)
  const internKeys = new Set<string>();
  const type_pool: Record<string, WireType> = { ...(payload.type_pool ?? {}) };

  for (const [key, { count }] of counts.entries()) {
    if (count >= 2) {
      internKeys.add(key);
    }
  }

  // Step 2: Replace repeated complex ObjectWireType shapes with RefWireType
  const replaceWithRefs = (
    wire: WireType | null,
    isRootOfInternKey?: string
  ): WireType | null => {
    if (!wire || typeof wire !== 'object') return wire;
    if (
      wire.kind === 'REF' ||
      wire.kind === 'PRIMITIVE' ||
      wire.kind === 'LITERAL' ||
      wire.kind === 'UNKNOWN' ||
      wire.kind === 'ENUM'
    ) {
      return wire;
    }
    if (wire.kind === 'NULLABLE') {
      return { ...wire, innerType: replaceWithRefs(wire.innerType)! };
    }
    if (wire.kind === 'OPTIONAL') {
      return { ...wire, innerType: replaceWithRefs(wire.innerType)! };
    }
    if (wire.kind === 'ARRAY') {
      return {
        ...wire,
        elementType: replaceWithRefs(wire.elementType)!,
        ...(wire.tupleElements
          ? { tupleElements: wire.tupleElements.map(el => replaceWithRefs(el)!) }
          : {}),
      };
    }
    if (wire.kind === 'MAP') {
      return {
        ...wire,
        keyType: replaceWithRefs(wire.keyType)!,
        valueType: replaceWithRefs(wire.valueType)!,
      };
    }
    if (wire.kind === 'UNION') {
      return {
        ...wire,
        types: wire.types.map(t => replaceWithRefs(t)!),
      };
    }
    if (wire.kind === 'OBJECT') {
      const key = computeCanonicalWireTypeKey(wire, defaultLanguage);
      if (internKeys.has(key)) {
        if (isRootOfInternKey === key) {
          return {
            ...wire,
            properties: wire.properties.map(p => ({
              ...p,
              type: replaceWithRefs(p.type)!,
            })),
          };
        }
        return mkRefWireType(key, wire.provenance);
      }
      return {
        ...wire,
        properties: wire.properties.map(p => ({
          ...p,
          type: replaceWithRefs(p.type)!,
        })),
      };
    }
    return wire;
  };

  // Populate type_pool with interned definitions
  for (const key of internKeys) {
    const rawWire = counts.get(key)!.wireType;
    type_pool[key] = replaceWithRefs(rawWire, key) as WireType;
  }

  // Step 3: Replace occurrences across the payload contracts
  if (isBackend) {
    const bp = payload as BackendContractPayload;
    const internedEndpoints = bp.endpoints.map(ep => ({
      ...ep,
      body: replaceWithRefs(ep.body),
      pathParameters: ep.pathParameters?.map(p => ({
        ...p,
        type: replaceWithRefs(p.type)!,
      })),
      queryParameters: ep.queryParameters?.map(p => ({
        ...p,
        type: replaceWithRefs(p.type)!,
      })),
      headers: ep.headers?.map(p => ({
        ...p,
        type: replaceWithRefs(p.type)!,
      })),
    }));
    return {
      ...bp,
      endpoints: internedEndpoints,
      type_pool: Object.keys(type_pool).length > 0 ? type_pool : undefined,
    } as unknown as T;
  } else {
    const fp = payload as FrontendContractPayload;
    const internedContracts = fp.clientContracts.map(cc => ({
      ...cc,
      requestBody: replaceWithRefs(cc.requestBody),
      expectedResponse: replaceWithRefs(cc.expectedResponse)!,
    }));
    return {
      ...fp,
      clientContracts: internedContracts,
      type_pool: Object.keys(type_pool).length > 0 ? type_pool : undefined,
    } as unknown as T;
  }
}

/**
 * Dereferences all `RefWireType` references in a payload using `type_pool`,
 * expanding them back into in-memory structural wire types.
 *
 * Throws if a `RefWireType` references a key missing from `type_pool`.
 */
export function expandTypePool<
  T extends FrontendContractPayload | BackendContractPayload | ContractArtifactEnvelope
>(target: T): T {
  // Support wrapping ContractArtifactEnvelope
  if (
    typeof target === 'object' &&
    target !== null &&
    'envelopeVersion' in target &&
    'payload' in target
  ) {
    const env = target as ContractArtifactEnvelope;
    const expandedPayload = expandTypePool(env.payload);
    return {
      ...env,
      payload: expandedPayload,
    } as T;
  }

  const payload = target as FrontendContractPayload | BackendContractPayload;
  const pool = payload.type_pool;

  const expandWire = (wire: WireType | null, visited = new Set<string>()): WireType | null => {
    if (!wire || typeof wire !== 'object') return wire;
    if (wire.kind === 'REF') {
      if (!pool || !pool[wire.ref]) {
        throw new Error(
          `expandTypePool: unresolved RefWireType reference "${wire.ref}" in type_pool.`
        );
      }
      if (visited.has(wire.ref)) {
        return pool[wire.ref];
      }
      const nextVisited = new Set(visited);
      nextVisited.add(wire.ref);
      return expandWire(pool[wire.ref], nextVisited)!;
    }
    if (
      wire.kind === 'PRIMITIVE' ||
      wire.kind === 'LITERAL' ||
      wire.kind === 'UNKNOWN' ||
      wire.kind === 'ENUM'
    ) {
      return wire;
    }
    if (wire.kind === 'NULLABLE') {
      return { ...wire, innerType: expandWire(wire.innerType, visited)! };
    }
    if (wire.kind === 'OPTIONAL') {
      return { ...wire, innerType: expandWire(wire.innerType, visited)! };
    }
    if (wire.kind === 'ARRAY') {
      return {
        ...wire,
        elementType: expandWire(wire.elementType, visited)!,
        ...(wire.tupleElements
          ? { tupleElements: wire.tupleElements.map(el => expandWire(el, visited)!) }
          : {}),
      };
    }
    if (wire.kind === 'MAP') {
      return {
        ...wire,
        keyType: expandWire(wire.keyType, visited)!,
        valueType: expandWire(wire.valueType, visited)!,
      };
    }
    if (wire.kind === 'UNION') {
      return {
        ...wire,
        types: wire.types.map(t => expandWire(t, visited)!),
      };
    }
    if (wire.kind === 'OBJECT') {
      return {
        ...wire,
        properties: wire.properties.map(p => ({
          ...p,
          type: expandWire(p.type, visited)!,
        })),
      };
    }
    return wire;
  };

  const isBackend = 'endpoints' in payload;
  if (isBackend) {
    const bp = payload as BackendContractPayload;
    const expandedEndpoints = bp.endpoints.map(ep => ({
      ...ep,
      body: expandWire(ep.body),
      pathParameters: ep.pathParameters?.map(p => ({
        ...p,
        type: expandWire(p.type)!,
      })),
      queryParameters: ep.queryParameters?.map(p => ({
        ...p,
        type: expandWire(p.type)!,
      })),
      headers: ep.headers?.map(p => ({
        ...p,
        type: expandWire(p.type)!,
      })),
    }));
    const res: any = {
      ...bp,
      endpoints: expandedEndpoints,
    };
    delete res.type_pool;
    return res as T;
  } else {
    const fp = payload as FrontendContractPayload;
    const expandedContracts = fp.clientContracts.map(cc => ({
      ...cc,
      requestBody: expandWire(cc.requestBody),
      expectedResponse: expandWire(cc.expectedResponse)!,
    }));
    const res: any = {
      ...fp,
      clientContracts: expandedContracts,
    };
    delete res.type_pool;
    return res as T;
  }
}

