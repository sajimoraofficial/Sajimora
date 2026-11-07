/**
 * envelope_v2_deduplication.test.ts
 *
 * Acceptance tests for Envelope V2 DTO type pool interning and deduplication.
 * Validates:
 *   1. 100 repeated identical complex DTOs produce 1 DTO in type_pool and 100 RefWireType references.
 *   2. Payload JSON string length shrinks by >70% on synthetic repeated benchmarks.
 *   3. Round-trip: internTypePool -> expandTypePool yields identical structural contracts.
 *   4. BackendContractPayload interning and round-trip expansion.
 *   5. Deterministic canonical key computation (java:<FQCN>, ts:<path>#<symbol>, anon:<hash16>).
 *   6. Full Envelope V2 lifecycle: sealEnvelope -> verifyEnvelopeIntegrity -> parseEnvelope.
 *   7. Fail-closed behavior on missing type references.
 */

import { describe, it, expect } from 'vitest';
import {
  ARTIFACT_ENVELOPE_VERSION_V2,
  internTypePool,
  expandTypePool,
  computeCanonicalWireTypeKey,
  sealEnvelope,
  verifyEnvelopeIntegrity,
  parseEnvelope,
  serializeEnvelope,
} from '../../../packages/analysis/src/sajimora/cross-language/ContractArtifactEnvelope';
import type {
  ContractArtifactEnvelope,
  FrontendContractPayload,
  BackendContractPayload,
  FrontendClientContract,
} from '../../../packages/analysis/src/sajimora/cross-language/ContractArtifactEnvelope';
import {
  mkObjectWireType,
  mkPrimitiveWireType,
  mkArrayWireType,
  mkNullableWireType,
  mkRefWireType,
  type EndpointContract,
} from '../../../packages/analysis/src/sajimora/cross-language/CanonicalContractIR';
import { SCHEMA_VERSION } from '../../../packages/analysis/src/sajimora/cross-language/CrossLanguageContracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeComplexUserDto(canonicalName = 'com.example.UserDto') {
  return mkObjectWireType(
    [
      {
        wireName: 'id',
        type: mkPrimitiveWireType('string'),
        optional: false,
        nullable: false,
        validationConstraints: [{ kind: 'NOT_NULL' }],
      },
      {
        wireName: 'email',
        type: mkPrimitiveWireType('string'),
        optional: false,
        nullable: false,
        validationConstraints: [{ kind: 'NOT_BLANK' }, { kind: 'EMAIL' }],
      },
      {
        wireName: 'displayName',
        type: mkPrimitiveWireType('string'),
        optional: true,
        nullable: true,
        validationConstraints: [{ kind: 'SIZE', value: 100 }],
      },
      {
        wireName: 'roles',
        type: mkArrayWireType(mkPrimitiveWireType('string')),
        optional: false,
        nullable: false,
        validationConstraints: [{ kind: 'NOT_EMPTY' }],
      },
      {
        wireName: 'status',
        type: mkPrimitiveWireType('string'),
        optional: false,
        nullable: false,
        validationConstraints: [{ kind: 'PATTERN', value: '^(ACTIVE|SUSPENDED|DELETED)$' }],
      },
      {
        wireName: 'loginAttempts',
        type: mkPrimitiveWireType('number'),
        optional: false,
        nullable: false,
        validationConstraints: [{ kind: 'MIN', value: 0 }, { kind: 'MAX', value: 10 }],
      },
      {
        wireName: 'isVerified',
        type: mkPrimitiveWireType('boolean'),
        optional: false,
        nullable: false,
        validationConstraints: [],
      },
      {
        wireName: 'bio',
        type: mkNullableWireType(mkPrimitiveWireType('string')),
        optional: true,
        nullable: true,
        validationConstraints: [],
      },
    ],
    canonicalName,
    false,
    {
      language: 'JAVA',
      file: 'src/main/java/com/example/UserDto.java',
      line: 15,
      astIdentity: canonicalName,
    }
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Envelope V2 DTO Type Pool & Deduplication', () => {
  it('repeating 100 identical complex DTOs produces an envelope with 1 DTO in type_pool and 100 RefWireType references', () => {
    const userDto = makeComplexUserDto('com.example.UserDto');
    const clientContracts: FrontendClientContract[] = Array.from({ length: 100 }, (_, i) => ({
      httpMethod: 'GET',
      normalizedRoute: `/api/users/${i}`,
      requestBody: null,
      expectedResponse: userDto,
      decoderKind: 'ZOD_DEFAULT',
      consumers: [{ file: `src/consumers/user_${i}.ts`, line: 10, usage: 'fetch' }],
      unresolvedEvidence: [],
      sourceFile: `src/api/client_${i}.ts`,
      sourceLine: 1,
    }));

    const payload: FrontendContractPayload = { clientContracts };
    const interned = internTypePool(payload);

    // Assert: exactly 1 DTO in type_pool
    expect(interned.type_pool).toBeDefined();
    const poolKeys = Object.keys(interned.type_pool!);
    expect(poolKeys).toHaveLength(1);
    const canonicalKey = 'java:com.example.UserDto';
    expect(poolKeys[0]).toBe(canonicalKey);
    expect(interned.type_pool![canonicalKey].kind).toBe('OBJECT');

    // Assert: exactly 100 RefWireType references pointing to the canonical key
    expect(interned.clientContracts).toHaveLength(100);
    for (let i = 0; i < 100; i++) {
      const resp = interned.clientContracts[i].expectedResponse;
      expect(resp.kind).toBe('REF');
      if (resp.kind === 'REF') {
        expect(resp.ref).toBe(canonicalKey);
      }
    }
  });

  it('payload JSON string length shrinks by >70% on synthetic repeated benchmarks', () => {
    const userDto = makeComplexUserDto('com.example.UserDto');
    const clientContracts: FrontendClientContract[] = Array.from({ length: 100 }, (_, i) => ({
      httpMethod: 'POST',
      normalizedRoute: `/api/users/${i}`,
      requestBody: userDto,
      expectedResponse: userDto,
      decoderKind: 'ZOD_DEFAULT',
      consumers: [{ file: `src/consumers/user_${i}.ts`, line: 10, usage: 'fetch' }],
      unresolvedEvidence: [],
      sourceFile: `src/api/client_${i}.ts`,
      sourceLine: 1,
    }));

    const rawPayload: FrontendContractPayload = { clientContracts };
    const internedPayload = internTypePool(rawPayload);

    const rawJson = JSON.stringify(rawPayload);
    const internedJson = JSON.stringify(internedPayload);

    const rawLen = Buffer.byteLength(rawJson);
    const internedLen = Buffer.byteLength(internedJson);
    const shrinkageRatio = (rawLen - internedLen) / rawLen;

    expect(shrinkageRatio).toBeGreaterThan(0.70);
  });

  it('round-trip: internTypePool -> expandTypePool yields identical structural contracts', () => {
    const userDto = makeComplexUserDto('com.example.UserDto');
    const clientContracts: FrontendClientContract[] = Array.from({ length: 10 }, (_, i) => ({
      httpMethod: 'GET',
      normalizedRoute: `/api/users/${i}`,
      requestBody: i % 2 === 0 ? userDto : null,
      expectedResponse: userDto,
      decoderKind: 'ZOD_DEFAULT',
      consumers: [{ file: `src/consumers/user_${i}.ts`, line: 10, usage: 'fetch' }],
      unresolvedEvidence: [],
      sourceFile: `src/api/client_${i}.ts`,
      sourceLine: 1,
    }));

    const payload: FrontendContractPayload = { clientContracts };
    const interned = internTypePool(payload);
    const expanded = expandTypePool(interned);

    expect(expanded).toEqual(payload);
  });

  it('deduplicates and round-trips BackendContractPayload endpoints with identical DTOs', () => {
    const userDto = makeComplexUserDto('com.example.UserDto');
    const endpoints: EndpointContract[] = Array.from({ length: 50 }, (_, i) => ({
      identity: {
        service: 'order-service',
        httpMethod: 'GET',
        normalizedRoute: {
          rawPath: `/api/orders/${i}`,
          segments: [
            { text: 'api', isParam: false },
            { text: 'orders', isParam: false },
            { text: `${i}`, isParam: false },
          ],
        },
        direction: 'RESPONSE',
      },
      pathParameters: [],
      queryParameters: [],
      headers: [],
      body: userDto,
      provenance: {
        language: 'JAVA',
        file: 'src/main/java/com/example/OrderController.java',
        line: 25,
        astIdentity: 'com.example.OrderController.getOrder',
      },
    }));

    const backendPayload: BackendContractPayload = {
      baseUrls: ['https://api.example.com'],
      proxyPrefixes: ['/api'],
      endpoints,
    };

    const interned = internTypePool(backendPayload);
    expect(interned.type_pool).toBeDefined();
    expect(Object.keys(interned.type_pool!)).toHaveLength(1);

    const expanded = expandTypePool(interned);
    expect(expanded).toEqual(backendPayload);
  });

  it('computes deterministic canonical keys across Java, TypeScript, and anonymous DTOs', () => {
    const javaDto = mkObjectWireType(
      [{ wireName: 'id', type: mkPrimitiveWireType('string'), optional: false, nullable: false, validationConstraints: [] }],
      'OrderDto',
      false,
      { language: 'JAVA', file: 'OrderDto.java', line: 1, astIdentity: 'com.example.orders.OrderDto' }
    );
    expect(computeCanonicalWireTypeKey(javaDto)).toBe('java:com.example.orders.OrderDto');

    const tsDto = mkObjectWireType(
      [{ wireName: 'name', type: mkPrimitiveWireType('string'), optional: false, nullable: false, validationConstraints: [] }],
      'UserProfile',
      false,
      { language: 'TYPESCRIPT', file: 'src/types/user.ts', line: 5, astIdentity: 'UserProfile' }
    );
    expect(computeCanonicalWireTypeKey(tsDto)).toBe('ts:src/types/user.ts#UserProfile');

    const anonDto = mkObjectWireType([
      { wireName: 'tag', type: mkPrimitiveWireType('string'), optional: false, nullable: false, validationConstraints: [] },
    ]);
    const anonKey = computeCanonicalWireTypeKey(anonDto);
    expect(anonKey).toMatch(/^anon:[0-9a-f]{16}$/);

    // Determinism: same anonymous shape produces same key
    const anonDto2 = mkObjectWireType([
      { wireName: 'tag', type: mkPrimitiveWireType('string'), optional: false, nullable: false, validationConstraints: [] },
    ]);
    expect(computeCanonicalWireTypeKey(anonDto2)).toBe(anonKey);
  });

  it('seals and verifies Envelope V2 with ARTIFACT_ENVELOPE_VERSION_V2', () => {
    const userDto = makeComplexUserDto();
    const clientContracts: FrontendClientContract[] = Array.from({ length: 100 }, (_, i) => ({
      httpMethod: 'GET',
      normalizedRoute: `/api/users/${i}`,
      requestBody: null,
      expectedResponse: userDto,
      decoderKind: 'ZOD_DEFAULT',
      consumers: [{ file: `src/consumers/user_${i}.ts`, line: 10, usage: 'fetch' }],
      unresolvedEvidence: [],
      sourceFile: `src/api/client_${i}.ts`,
      sourceLine: 1,
    }));

    const payload: FrontendContractPayload = { clientContracts };
    const internedPayload = internTypePool(payload);

    const draft: Omit<ContractArtifactEnvelope, 'integrity'> = {
      envelopeVersion: ARTIFACT_ENVELOPE_VERSION_V2,
      reportSchemaVersion: SCHEMA_VERSION,
      kind: 'FRONTEND_CONTRACT',
      snapshot: {
        repositoryId: 'github.com/org/frontend',
        serviceId: 'web-client',
        apiVersion: 'v2',
        parentCommit: '1111222233334444555566667777888899990000',
        candidateSnapshot: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
      },
      profile: {
        toolVersion: '0.10.0',
        frameworkProfile: 'REACT',
        clientProfile: 'FETCH',
        configFingerprint: 'cfg123',
      },
      completeness: {
        complete: true,
        unresolvedEndpoints: [],
        blockers: [],
      },
      payload: internedPayload,
    };

    const sealed = sealEnvelope(draft);
    expect(sealed.integrity?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyEnvelopeIntegrity(sealed)).toBe(true);

    const json = serializeEnvelope(sealed);
    const parsed = parseEnvelope(json);
    expect(parsed.envelopeVersion).toBe(ARTIFACT_ENVELOPE_VERSION_V2);
    expect(verifyEnvelopeIntegrity(parsed)).toBe(true);

    // Expand in memory
    const expanded = expandTypePool(parsed);
    expect(expanded.payload.type_pool).toBeUndefined();
    const expandedResp = (expanded.payload as FrontendContractPayload).clientContracts[0].expectedResponse;
    expect(expandedResp.kind).toBe('OBJECT');
  });

  it('throws fail-closed error when RefWireType references missing type in type_pool', () => {
    const badContract: FrontendClientContract = {
      httpMethod: 'GET',
      normalizedRoute: '/api/missing',
      requestBody: null,
      expectedResponse: mkRefWireType('java:com.example.NonExistent'),
      decoderKind: 'ZOD_DEFAULT',
      consumers: [],
      unresolvedEvidence: [],
      sourceFile: 'client.ts',
      sourceLine: 1,
    };
    const badPayload: FrontendContractPayload = {
      clientContracts: [badContract],
      type_pool: {},
    };
    expect(() => expandTypePool(badPayload)).toThrow(/unresolved RefWireType reference/);
  });
});
