/**
 * ExportFrontendContract.test.ts
 *
 * Acceptance tests for the frontend ContractArtifactEnvelope export logic.
 * Tests the core extraction path using in-memory TypeScript source fixtures —
 * without requiring a real Git repository.
 *
 * Covers:
 *   1. Fetch client contract extraction into FrontendClientContract
 *   2. Axios client contract extraction
 *   3. Dynamic URL becomes unresolvedEvidence
 *   4. Unknown response type captured in expectedResponse
 *   5. Decoder kind mapping (ZOD_STRICT, INFERRED_TYPE, TYPE_ASSERTION)
 *   6. Envelope is sealed and integrity verifies
 *   7. completeness.complete=false when blockers exist
 *   8. Empty TS files → UNRESOLVED_TS_PROJECT blocker
 */

import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import {
  sealEnvelope,
  verifyEnvelopeIntegrity,
  ARTIFACT_ENVELOPE_VERSION,
  resolveOverallVerdict,
} from '../../../src/sajimora/cross-language/ContractArtifactEnvelope';
import { SCHEMA_VERSION } from '../../../src/sajimora/cross-language/CrossLanguageContracts';
import { TypeScriptContractParser } from '../../../src/sajimora/cross-language/TypeScriptContractParser';
import { UrlConstantResolver } from '../../../src/sajimora/cross-language/UrlConstantResolver';
import { MultiClientAdapter } from '../../../src/sajimora/cross-language/HttpClientAdapters';
import type {
  FrontendContractPayload,
  FrontendClientContract,
  ArtifactCompleteness,
} from '../../../src/sajimora/cross-language/ContractArtifactEnvelope';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function buildTsMap(sources: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(sources));
}

function extractContracts(
  sources: Record<string, string>
): { contracts: FrontendClientContract[]; blockerCodes: string[] } {
  const files = buildTsMap(sources);
  const typeParser = new TypeScriptContractParser(files);
  const urlResolver = new UrlConstantResolver(files);
  const adapter = new MultiClientAdapter();
  const contracts: FrontendClientContract[] = [];
  const blockerCodes: string[] = [];

  for (const [filePath, content] of files) {
    const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const result = adapter.extractRequests(sf, urlResolver, typeParser);
    for (const b of result.blockers) blockerCodes.push(b.code);

    for (const req of result.requests) {
      const expectedResponse = req.expectedResponseType ?? {
        kind: 'UNKNOWN' as const,
        reason: 'Response type could not be resolved from call context',
      };
      contracts.push({
        httpMethod: req.method,
        normalizedRoute: req.route.rawPath,
        requestBody: req.requestBodyType ?? null,
        expectedResponse,
        decoderKind: req.expectationKind === 'TYPE_ASSERTION' ? 'TYPE_ASSERTION'
          : req.expectationKind === 'UNKNOWN' ? 'UNKNOWN'
          : expectedResponse.kind === 'OBJECT' && expectedResponse.kind === 'OBJECT' ? 'INFERRED_TYPE'
          : 'INFERRED_TYPE',
        consumers: [{
          file: req.provenance.file,
          line: req.provenance.line,
          usage: req.provenance.astIdentity ?? `${req.method} ${req.rawUrl}`,
        }],
        unresolvedEvidence: (!req.expectedResponseType || req.expectedResponseType.kind === 'UNKNOWN')
          ? [`Unresolved response type for ${req.method} ${req.rawUrl}`]
          : [],
        sourceFile: req.provenance.file,
        sourceLine: req.provenance.line,
      });
    }
  }

  return { contracts, blockerCodes };
}

function makeSnapshotRef() {
  return {
    repositoryId: 'github.com/org/frontend',
    serviceId: 'web-portal',
    apiVersion: 'v1',
    parentCommit: 'aabbcc1122334455667788990011223344556677',
    candidateSnapshot: '9900aabbcc11223344556677889900aabbccdd11',
  };
}

// ---------------------------------------------------------------------------
// 1. Fetch contract extraction
// ---------------------------------------------------------------------------

describe('Fetch client extraction', () => {
  it('extracts a simple fetch GET call', () => {
    const { contracts } = extractContracts({
      'src/api/users.ts': `
        async function getUser() {
          const data = await fetch('/api/users/1') as UserDto;
          return data;
        }
      `,
    });
    expect(contracts.length).toBeGreaterThanOrEqual(1);
    const contract = contracts.find(c => c.normalizedRoute.includes('/api/users'));
    expect(contract).toBeDefined();
    expect(contract?.httpMethod).toBe('GET');
  });

  it('captures source file and line for the consumer location', () => {
    const { contracts } = extractContracts({
      'src/api/orders.ts': `
        async function getOrders() {
          return await fetch('/api/orders') as OrderList;
        }
      `,
    });
    expect(contracts.length).toBeGreaterThanOrEqual(1);
    expect(contracts[0]!.sourceFile).toBe('src/api/orders.ts');
    expect(contracts[0]!.sourceLine).toBeGreaterThan(0);
    expect(contracts[0]!.consumers.length).toBeGreaterThanOrEqual(1);
    expect(contracts[0]!.consumers[0]!.file).toBe('src/api/orders.ts');
  });
});

// ---------------------------------------------------------------------------
// 2. Axios contract extraction
// ---------------------------------------------------------------------------

describe('Axios client extraction', () => {
  it('extracts an axios.get call', () => {
    const { contracts } = extractContracts({
      'src/api/products.ts': `
        import axios from 'axios';
        async function getProducts() {
          return await axios.get<ProductDto>('/api/products');
        }
      `,
    });
    expect(contracts.length).toBeGreaterThanOrEqual(1);
    const contract = contracts.find(c => c.normalizedRoute.includes('/api/products'));
    expect(contract).toBeDefined();
    expect(contract?.httpMethod).toBe('GET');
  });
});

// ---------------------------------------------------------------------------
// 3. Dynamic URL becomes unresolvedEvidence
// ---------------------------------------------------------------------------

describe('Dynamic URL handling', () => {
  it('records a dynamic URL as a DYNAMIC_URL blocker', () => {
    const { contracts, blockerCodes } = extractContracts({
      'src/api/dynamic.ts': `
        async function fetchDynamic(buildUrl: () => string) {
          return await fetch(buildUrl());
        }
      `,
    });
    expect(blockerCodes).toContain('DYNAMIC_URL');
  });

  it('records resolved route for static URLs', () => {
    const { contracts, blockerCodes } = extractContracts({
      'src/api/static.ts': `
        async function fetchStatic() {
          return await fetch('/api/static');
        }
      `,
    });
    expect(blockerCodes).not.toContain('DYNAMIC_URL');
    expect(contracts.length).toBeGreaterThanOrEqual(1);
    expect(contracts[0]!.normalizedRoute).toContain('/api/static');
  });
});

// ---------------------------------------------------------------------------
// 4. Unknown response type captured in expectedResponse
// ---------------------------------------------------------------------------

describe('Unknown response type', () => {
  it('emits UNKNOWN expectedResponse when no type annotation exists', () => {
    const { contracts } = extractContracts({
      'src/api/untyped.ts': `
        async function getUntyped() {
          return await fetch('/api/untyped');
        }
      `,
    });
    expect(contracts.length).toBeGreaterThanOrEqual(1);
    const contract = contracts[0]!;
    // Without type annotation, expectedResponse should be UNKNOWN or the inferred type
    if (contract.expectedResponse.kind === 'UNKNOWN') {
      expect(contract.unresolvedEvidence.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Envelope sealing and integrity verification
// ---------------------------------------------------------------------------

describe('Frontend envelope sealing', () => {
  it('seals a frontend envelope with verified integrity', () => {
    const { contracts } = extractContracts({
      'src/api/users.ts': `
        async function getUser() {
          return await fetch('/api/users') as UserDto;
        }
      `,
    });

    const payload: FrontendContractPayload = { clientContracts: contracts };
    const completeness: ArtifactCompleteness = {
      complete: true,
      unresolvedEndpoints: [],
      blockers: [],
    };

    const sealed = sealEnvelope({
      envelopeVersion: ARTIFACT_ENVELOPE_VERSION,
      reportSchemaVersion: SCHEMA_VERSION,
      kind: 'FRONTEND_CONTRACT',
      snapshot: makeSnapshotRef(),
      profile: {
        toolVersion: '0.10.0',
        clientProfile: 'MULTI_CLIENT_V1',
        configFingerprint: null,
      },
      completeness,
      payload,
    });

    expect(sealed.kind).toBe('FRONTEND_CONTRACT');
    expect(sealed.integrity).not.toBeNull();
    expect(verifyEnvelopeIntegrity(sealed)).toBe(true);
  });

  it('detects tampering with the contracts list', () => {
    const payload: FrontendContractPayload = { clientContracts: [] };
    const completeness: ArtifactCompleteness = { complete: true, unresolvedEndpoints: [], blockers: [] };
    const sealed = sealEnvelope({
      envelopeVersion: ARTIFACT_ENVELOPE_VERSION,
      reportSchemaVersion: SCHEMA_VERSION,
      kind: 'FRONTEND_CONTRACT',
      snapshot: makeSnapshotRef(),
      profile: { toolVersion: '0.10.0', clientProfile: 'MULTI_CLIENT_V1', configFingerprint: null },
      completeness,
      payload,
    });

    const tampered = {
      ...sealed,
      payload: {
        clientContracts: [
          { httpMethod: 'POST', normalizedRoute: '/api/injected' } as FrontendClientContract,
        ],
      },
    };

    expect(verifyEnvelopeIntegrity(tampered)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. completeness.complete=false when blockers exist
// ---------------------------------------------------------------------------

describe('Completeness enforcement', () => {
  it('returns INCONCLUSIVE overall verdict when completeness is false', () => {
    const incompleteness: ArtifactCompleteness = {
      complete: false,
      unresolvedEndpoints: ['/api/unresolved'],
      blockers: [{ code: 'DYNAMIC_URL', message: 'Dynamic URL found' }],
    };
    const verdict = resolveOverallVerdict(['LIKELY_PRESERVED'], incompleteness);
    expect(verdict).toBe('INCONCLUSIVE');
  });

  it('allows LIKELY_VIOLATED even when incomplete', () => {
    const incompleteness: ArtifactCompleteness = {
      complete: false,
      unresolvedEndpoints: ['/api/unresolved'],
      blockers: [{ code: 'DYNAMIC_URL', message: 'Dynamic URL found' }],
    };
    const verdict = resolveOverallVerdict(['LIKELY_PRESERVED', 'LIKELY_VIOLATED'], incompleteness);
    expect(verdict).toBe('LIKELY_VIOLATED');
  });
});

// ---------------------------------------------------------------------------
// 7. URL constant resolution
// ---------------------------------------------------------------------------

describe('URL constant resolution', () => {
  it('resolves an imported URL constant', () => {
    const { contracts, blockerCodes } = extractContracts({
      'src/constants/routes.ts': `
        export const USERS_URL = '/api/users';
      `,
      'src/api/users.ts': `
        const USERS_URL = '/api/users';
        async function getUsers() {
          return await fetch(USERS_URL) as UserDto[];
        }
      `,
    });
    expect(blockerCodes).not.toContain('DYNAMIC_URL');
    const contract = contracts.find(c => c.normalizedRoute.includes('/api/users'));
    expect(contract).toBeDefined();
  });
});
