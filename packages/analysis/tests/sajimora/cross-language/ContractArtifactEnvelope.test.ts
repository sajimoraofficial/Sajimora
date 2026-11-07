/**
 * ContractArtifactEnvelope.test.ts
 *
 * Acceptance tests for the ContractArtifactEnvelope schema, canonical JSON
 * serialization, integrity digest, verdict precedence, and incomplete-export
 * handling.
 *
 * These tests verify design consistency per the architecture specification.
 * They do NOT exercise proposed CLI commands (export-contract, check-contract).
 */

import { describe, it, expect } from 'vitest';
import {
  ARTIFACT_ENVELOPE_VERSION,
  canonicalJson,
  computeEnvelopeDigest,
  sealEnvelope,
  verifyEnvelopeIntegrity,
  parseEnvelope,
  serializeEnvelope,
  isContractArtifactEnvelope,
  mergeVerdicts,
  resolveOverallVerdict,
} from '../../../src/sajimora/cross-language/ContractArtifactEnvelope';
import { SCHEMA_VERSION } from '../../../src/sajimora/cross-language/CrossLanguageContracts';
import type {
  ContractArtifactEnvelope,
  BackendContractPayload,
  FrontendContractPayload,
  ArtifactComparisonVerdict,
  ArtifactCompleteness,
} from '../../../src/sajimora/cross-language/ContractArtifactEnvelope';


// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

function makeBackendPayload(): BackendContractPayload {
  return {
    baseUrls: ['https://api.example.com'],
    proxyPrefixes: ['/api'],
    endpoints: [],
  };
}

function makeFrontendPayload(): FrontendContractPayload {
  return { clientContracts: [] };
}

function makeDraftEnvelope(
  kind: 'BACKEND_CONTRACT' | 'FRONTEND_CONTRACT' = 'BACKEND_CONTRACT'
): Omit<ContractArtifactEnvelope, 'integrity'> {
  return {
    envelopeVersion: ARTIFACT_ENVELOPE_VERSION,
    reportSchemaVersion: SCHEMA_VERSION,
    kind,
    snapshot: {
      repositoryId: 'github.com/org/backend',
      serviceId: 'order-service',
      apiVersion: 'v1',
      parentCommit: 'aabbcc1122334455667788990011223344556677',
      candidateSnapshot: '9900aabbcc11223344556677889900aabbccdd11',
    },
    profile: {
      toolVersion: '0.10.0',
      frameworkProfile: 'SPRING_MVC',
      codecProfile: 'JACKSON_DEFAULT_V1',
      clientProfile: 'FETCH',
      configFingerprint: 'abc123def456',
    },
    completeness: {
      complete: true,
      unresolvedEndpoints: [],
      blockers: [],
    },
    payload: kind === 'BACKEND_CONTRACT' ? makeBackendPayload() : makeFrontendPayload(),
  };
}

// ---------------------------------------------------------------------------
// 1. canonicalJson
// ---------------------------------------------------------------------------

describe('canonicalJson', () => {
  it('sorts object keys lexicographically', () => {
    const result = canonicalJson({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it('sorts nested object keys recursively', () => {
    const result = canonicalJson({ b: { z: 1, a: 2 }, a: 'x' });
    expect(result).toBe('{"a":"x","b":{"a":2,"z":1}}');
  });

  it('preserves array insertion order', () => {
    const result = canonicalJson([3, 1, 2]);
    expect(result).toBe('[3,1,2]');
  });

  it('handles null, booleans, and numbers correctly', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('hello')).toBe('"hello"');
  });

  it('omits undefined values from objects', () => {
    const result = canonicalJson({ a: 1, b: undefined, c: 3 });
    expect(result).toBe('{"a":1,"c":3}');
  });

  it('produces identical output for objects with different key insertion order', () => {
    const a = canonicalJson({ z: 1, a: 2 });
    const b = canonicalJson({ a: 2, z: 1 });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 2. sealEnvelope / verifyEnvelopeIntegrity
// ---------------------------------------------------------------------------

describe('sealEnvelope and verifyEnvelopeIntegrity', () => {
  it('seals an envelope with a non-null sha256 digest', () => {
    const draft = makeDraftEnvelope();
    const sealed = sealEnvelope(draft);
    expect(sealed.integrity).not.toBeNull();
    expect(sealed.integrity?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies a correctly sealed envelope', () => {
    const sealed = sealEnvelope(makeDraftEnvelope());
    expect(verifyEnvelopeIntegrity(sealed)).toBe(true);
  });

  it('detects tampering with the payload', () => {
    const sealed = sealEnvelope(makeDraftEnvelope());
    const tampered: ContractArtifactEnvelope = {
      ...sealed,
      payload: {
        ...(sealed.payload as BackendContractPayload),
        baseUrls: ['https://evil.example.com'],  // tampered
      },
    };
    expect(verifyEnvelopeIntegrity(tampered)).toBe(false);
  });

  it('detects tampering with snapshot identity', () => {
    const sealed = sealEnvelope(makeDraftEnvelope());
    const tampered: ContractArtifactEnvelope = {
      ...sealed,
      snapshot: {
        ...sealed.snapshot,
        candidateSnapshot: 'ffffffffffffffffffffffffffffffffffffffff',
      },
    };
    expect(verifyEnvelopeIntegrity(tampered)).toBe(false);
  });

  it('detects tampering with the profile configFingerprint', () => {
    const sealed = sealEnvelope(makeDraftEnvelope());
    const tampered: ContractArtifactEnvelope = {
      ...sealed,
      profile: { ...sealed.profile, configFingerprint: 'tampered' },
    };
    expect(verifyEnvelopeIntegrity(tampered)).toBe(false);
  });

  it('throws when verifying an unsealed envelope', () => {
    const draft = makeDraftEnvelope();
    const unsealed: ContractArtifactEnvelope = { ...draft, integrity: null };
    expect(() => verifyEnvelopeIntegrity(unsealed)).toThrow('integrity field is null');
  });

  it('digest excludes the integrity field itself (deterministic)', () => {
    const draft = makeDraftEnvelope();
    const sealed1 = sealEnvelope(draft);
    const sealed2 = sealEnvelope(draft);
    expect(sealed1.integrity?.sha256).toBe(sealed2.integrity?.sha256);
  });
});

// ---------------------------------------------------------------------------
// 3. parseEnvelope / serializeEnvelope round-trip
// ---------------------------------------------------------------------------

describe('parseEnvelope / serializeEnvelope round-trip', () => {
  it('round-trips a sealed backend envelope', () => {
    const sealed = sealEnvelope(makeDraftEnvelope('BACKEND_CONTRACT'));
    const json = serializeEnvelope(sealed);
    const parsed = parseEnvelope(json);
    expect(parsed.kind).toBe('BACKEND_CONTRACT');
    expect(parsed.integrity?.sha256).toBe(sealed.integrity?.sha256);
    expect(verifyEnvelopeIntegrity(parsed)).toBe(true);
  });

  it('round-trips a sealed frontend envelope', () => {
    const sealed = sealEnvelope(makeDraftEnvelope('FRONTEND_CONTRACT'));
    const json = serializeEnvelope(sealed);
    const parsed = parseEnvelope(json);
    expect(parsed.kind).toBe('FRONTEND_CONTRACT');
    expect(verifyEnvelopeIntegrity(parsed)).toBe(true);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseEnvelope('not json')).toThrow('JSON parse error');
  });

  it('throws when envelopeVersion is missing', () => {
    const json = JSON.stringify({ kind: 'BACKEND_CONTRACT' });
    expect(() => parseEnvelope(json)).toThrow('does not match expected schema');
  });

  it('throws when kind is invalid', () => {
    const sealed = sealEnvelope(makeDraftEnvelope());
    const corrupted = JSON.stringify({ ...sealed, kind: 'UNKNOWN_KIND' });
    expect(() => parseEnvelope(corrupted)).toThrow('does not match expected schema');
  });
});

// ---------------------------------------------------------------------------
// 4. isContractArtifactEnvelope type guard
// ---------------------------------------------------------------------------

describe('isContractArtifactEnvelope', () => {
  it('returns true for a valid sealed envelope', () => {
    const sealed = sealEnvelope(makeDraftEnvelope());
    expect(isContractArtifactEnvelope(sealed)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isContractArtifactEnvelope(null)).toBe(false);
  });

  it('returns false for a plain object missing required fields', () => {
    expect(isContractArtifactEnvelope({ kind: 'BACKEND_CONTRACT' })).toBe(false);
  });

  it('returns false when envelopeVersion is wrong', () => {
    const sealed = sealEnvelope(makeDraftEnvelope());
    expect(isContractArtifactEnvelope({ ...sealed, envelopeVersion: 'BAD' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Verdict precedence (mergeVerdicts)
// ---------------------------------------------------------------------------

describe('mergeVerdicts', () => {
  const verdicts: ArtifactComparisonVerdict[] = [
    'ANALYSIS_ERROR', 'LIKELY_VIOLATED', 'INCONCLUSIVE', 'LIKELY_PRESERVED',
  ];

  it('ANALYSIS_ERROR always wins', () => {
    for (const v of verdicts) {
      expect(mergeVerdicts('ANALYSIS_ERROR', v)).toBe('ANALYSIS_ERROR');
      expect(mergeVerdicts(v, 'ANALYSIS_ERROR')).toBe('ANALYSIS_ERROR');
    }
  });

  it('LIKELY_VIOLATED beats INCONCLUSIVE and LIKELY_PRESERVED', () => {
    expect(mergeVerdicts('LIKELY_VIOLATED', 'INCONCLUSIVE')).toBe('LIKELY_VIOLATED');
    expect(mergeVerdicts('LIKELY_VIOLATED', 'LIKELY_PRESERVED')).toBe('LIKELY_VIOLATED');
  });

  it('INCONCLUSIVE beats LIKELY_PRESERVED', () => {
    expect(mergeVerdicts('INCONCLUSIVE', 'LIKELY_PRESERVED')).toBe('INCONCLUSIVE');
  });

  it('is commutative', () => {
    for (const a of verdicts) {
      for (const b of verdicts) {
        expect(mergeVerdicts(a, b)).toBe(mergeVerdicts(b, a));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. resolveOverallVerdict — incomplete-export / preservation prohibition
// ---------------------------------------------------------------------------

describe('resolveOverallVerdict', () => {
  const completeOk: ArtifactCompleteness = {
    complete: true, unresolvedEndpoints: [], blockers: [],
  };
  const incomplete: ArtifactCompleteness = {
    complete: false, unresolvedEndpoints: ['GET /api/orders/{id}'], blockers: [],
  };


  it('returns LIKELY_PRESERVED when complete and all obligations pass', () => {
    const result = resolveOverallVerdict(
      ['LIKELY_PRESERVED', 'LIKELY_PRESERVED'],
      completeOk
    );
    expect(result).toBe('LIKELY_PRESERVED');
  });

  it('prohibits LIKELY_PRESERVED when completeness is false', () => {
    const result = resolveOverallVerdict(
      ['LIKELY_PRESERVED', 'LIKELY_PRESERVED'],
      incomplete
    );
    expect(result).toBe('INCONCLUSIVE');
  });

  it('allows LIKELY_VIOLATED even when completeness is false', () => {
    const result = resolveOverallVerdict(
      ['LIKELY_PRESERVED', 'LIKELY_VIOLATED'],
      incomplete
    );
    expect(result).toBe('LIKELY_VIOLATED');
  });

  it('returns ANALYSIS_ERROR when any obligation errors', () => {
    const result = resolveOverallVerdict(
      ['LIKELY_PRESERVED', 'ANALYSIS_ERROR', 'LIKELY_VIOLATED'],
      completeOk
    );
    expect(result).toBe('ANALYSIS_ERROR');
  });

  it('returns LIKELY_PRESERVED for empty obligations when complete', () => {
    const result = resolveOverallVerdict([], completeOk);
    expect(result).toBe('LIKELY_PRESERVED');
  });

  it('returns INCONCLUSIVE for empty obligations when incomplete', () => {
    const result = resolveOverallVerdict([], incomplete);
    expect(result).toBe('INCONCLUSIVE');
  });
});
