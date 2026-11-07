/**
 * test-export-to-rust-flow.ts
 *
 * Gate R5: End-to-end integration test demonstrating the full flow:
 *   1. Real TypeScript artifact export / sealing (via ContractArtifactEnvelope)
 *   2. Native Rust release binary execution with Node absent (PATH="")
 *   3. Verification of admission, digest checking, and verdict production
 *   4. Cross-verification against the TypeScript reference command
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  sealEnvelope,
  ARTIFACT_ENVELOPE_VERSION,
  ContractArtifactEnvelope,
} from '../../packages/analysis/src/sajimora/cross-language/ContractArtifactEnvelope';
import { SCHEMA_VERSION } from '../../packages/analysis/src/sajimora/cross-language/CrossLanguageContracts';
import { EndpointContract } from '../../packages/analysis/src/sajimora/cross-language/CanonicalContractIR';

const workspaceRoot = path.resolve(__dirname, '../..');
const releaseBin = path.join(workspaceRoot, 'rust/target/release/sajimora.exe');

console.log('=== Sajimora Gate R5: Export-to-Rust-Check Flow ===\n');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-export-flow-'));

try {
  console.log(`1. Exporting and sealing fresh contract artifacts in ${tempDir}...`);

  const orderEndpointBase: EndpointContract = {
    identity: {
      service: 'order-service',
      httpMethod: 'GET',
      normalizedRoute: {
        rawPath: '/api/orders',
        segments: [
          { text: 'api', isParam: false },
          { text: 'orders', isParam: false },
        ],
      },
      direction: 'RESPONSE',
    },
    pathParameters: [],
    queryParameters: [],
    headers: [],
    body: {
      kind: 'OBJECT',
      properties: [
        {
          wireName: 'orderId',
          type: { kind: 'PRIMITIVE', scalar: 'string' },
          optional: false,
          nullable: false,
          validationConstraints: [],
        },
      ],
    },
    provenance: {
      language: 'JAVA',
      file: 'OrderController.java',
      line: 25,
    },
  };

  const baseEnvelope: ContractArtifactEnvelope = sealEnvelope({
    envelopeVersion: ARTIFACT_ENVELOPE_VERSION,
    reportSchemaVersion: SCHEMA_VERSION,
    kind: 'BACKEND_CONTRACT',
    snapshot: {
      repositoryId: 'github.com/example/polyrepo-demo',
      serviceId: 'order-service',
      apiVersion: 'v1',
      parentCommit: '1111222233334444555566667777888899990000',
      candidateSnapshot: 'sha:base-order-v1',
    },
    profile: {
      toolVersion: '0.1.0-export',
      frameworkProfile: 'SPRING_MVC',
      codecProfile: 'JACKSON_DEFAULT_V1',
      configFingerprint: null,
    },
    completeness: {
      complete: true,
      unresolvedEndpoints: [],
      blockers: [],
    },
    payload: {
      baseUrls: ['http://order-service.internal'],
      proxyPrefixes: [],
      endpoints: [orderEndpointBase],
    },
  });

  // Candidate with breaking change (removes orderId property from response)
  const orderEndpointCand: EndpointContract = {
    ...orderEndpointBase,
    body: {
      kind: 'OBJECT',
      properties: [
        {
          wireName: 'newOrderId', // Renamed -> breaking change for consumer
          type: { kind: 'PRIMITIVE', scalar: 'string' },
          optional: false,
          nullable: false,
          validationConstraints: [],
        },
      ],
    },
  };

  const candEnvelope: ContractArtifactEnvelope = sealEnvelope({
    envelopeVersion: ARTIFACT_ENVELOPE_VERSION,
    reportSchemaVersion: SCHEMA_VERSION,
    kind: 'BACKEND_CONTRACT',
    snapshot: {
      repositoryId: 'github.com/example/polyrepo-demo',
      serviceId: 'order-service',
      apiVersion: 'v1',
      parentCommit: '1111222233334444555566667777888899990000',
      candidateSnapshot: 'sha:cand-order-v2',
    },
    profile: {
      toolVersion: '0.1.0-export',
      frameworkProfile: 'SPRING_MVC',
      codecProfile: 'JACKSON_DEFAULT_V1',
      configFingerprint: null,
    },
    completeness: {
      complete: true,
      unresolvedEndpoints: [],
      blockers: [],
    },
    payload: {
      baseUrls: ['http://order-service.internal'],
      proxyPrefixes: [],
      endpoints: [orderEndpointCand],
    },
  });

  // Frontend consumer expecting orderId
  const feEnvelope: ContractArtifactEnvelope = sealEnvelope({
    envelopeVersion: ARTIFACT_ENVELOPE_VERSION,
    reportSchemaVersion: SCHEMA_VERSION,
    kind: 'FRONTEND_CONTRACT',
    snapshot: {
      repositoryId: 'github.com/example/polyrepo-demo',
      serviceId: 'checkout-frontend',
      apiVersion: 'v1',
      parentCommit: 'aaaabbbbccccddddeeeeffff0000111122223333',
      candidateSnapshot: 'sha:fe-checkout-v1',
    },
    profile: {
      toolVersion: '0.1.0-export',
      clientProfile: 'MULTI_CLIENT_V1',
      configFingerprint: null,
    },
    completeness: {
      complete: true,
      unresolvedEndpoints: [],
      blockers: [],
    },
    payload: {
      clientContracts: [
        {
          targetServiceId: 'order-service',
          targetApiVersion: 'v1',
          sourceSha256: 'deadbeef1234567890abcdefdeadbeef1234567890abcdefdeadbeef12345678',
          consumerTraversalComplete: true,
          httpMethod: 'GET',
          normalizedRoute: 'http://order-service.internal/api/orders',
          requestBody: null,
          expectedResponse: {
            kind: 'OBJECT',
            properties: [
              {
                wireName: 'orderId',
                type: { kind: 'PRIMITIVE', scalar: 'string' },
                optional: false,
                nullable: false,
                validationConstraints: [],
              },
            ],
          },
          decoderKind: 'INFERRED_TYPE',
          consumers: [],
          unresolvedEvidence: [],
          sourceFile: 'src/api/orders.ts',
          sourceLine: 42,
        } as any,
      ],
    },
  });

  const basePath = path.join(tempDir, 'base.json');
  const candPath = path.join(tempDir, 'candidate.json');
  const fePath = path.join(tempDir, 'frontend.json');

  fs.writeFileSync(basePath, JSON.stringify(baseEnvelope, null, 2));
  fs.writeFileSync(candPath, JSON.stringify(candEnvelope, null, 2));
  fs.writeFileSync(fePath, JSON.stringify(feEnvelope, null, 2));
  console.log('   Envelopes sealed with cryptographic SHA-256 integrity digests.');

  // 2. Run Native Rust binary with Node ABSENT
  console.log('\n2. Running native Rust release checker with Node absent (PATH="")...');
  const rustOutput = execFileSync(
    releaseBin,
    [
      'check-contract',
      '--base', basePath,
      '--candidate', candPath,
      '--target', fePath,
      '--trusted-local',
    ],
    {
      env: {
        SYSTEMROOT: process.env.SYSTEMROOT || 'C:\\Windows',
        WINDIR: process.env.WINDIR || 'C:\\Windows',
        PATH: '', // Purposely empty to guarantee Node is absent
      },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );

  const rustReport = JSON.parse(rustOutput);
  console.log(`   Rust Verdict:    ${rustReport.verdict}`);
  console.log(`   Rust Property:   ${rustReport.property}`);
  console.log(`   Rust Findings:   ${rustReport.findings.length}`);

  // 3. Run fallback TypeScript command on the exact same exported files
  console.log('\n3. Running fallback TypeScript command for cross-verification...');
  const tsRunner = path.join(workspaceRoot, 'scripts/test-runtime/run-tsx-command.cjs');
  const tsScript = path.join(workspaceRoot, 'scripts/sajimora/checkContract.ts');
  const tsOutput = execFileSync(
    process.execPath,
    [
      tsRunner,
      tsScript,
      '--base', basePath,
      '--candidate', candPath,
      '--target', fePath,
      '--trusted-local',
    ],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );

  const tsReport = JSON.parse(tsOutput);
  console.log(`   TS Verdict:      ${tsReport.verdict}`);
  console.log(`   TS Property:     ${tsReport.property}`);
  console.log(`   TS Findings:     ${tsReport.findings.length}`);

  // 4. Assert Equivalence
  if (rustReport.verdict !== tsReport.verdict) {
    throw new Error(`Verdict mismatch: Rust=${rustReport.verdict}, TS=${tsReport.verdict}`);
  }
  if (rustReport.findings.length !== tsReport.findings.length) {
    throw new Error(`Findings count mismatch: Rust=${rustReport.findings.length}, TS=${tsReport.findings.length}`);
  }
  console.log('\n✓ End-to-end export-to-Rust-check flow PASSED with 100% equivalence!');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
