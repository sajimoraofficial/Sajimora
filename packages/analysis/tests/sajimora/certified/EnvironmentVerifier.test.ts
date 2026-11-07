import * as fs from 'fs';
import * as path from 'path';
import { RepositoryFixtureBuilder } from './fixtures/RepositoryFixtureBuilder';
import { EnvironmentVerifier } from '../../../src/sajimora/certified/environment/EnvironmentVerifier';
import { VerificationBudget } from '../../../src/sajimora/certified/proof/VerificationBudget';
import { INITIAL_RESOURCE_PROFILE, ArtifactDomain, RootPolicyId, SAJIMORA_CERTIFIED_EVIDENCE_V1 } from '../../../../core/src/sajimora/certified/protocol';
import { BlockerCode } from '../../../../core/src/sajimora/certified/blockers';
import { ProjectEntry, EnvironmentManifest } from '../../../../core/src/sajimora/certified/contracts';
import { hashContract } from '../../../../core/src/sajimora/certified/canonicalEncoding';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

console.log('Testing EnvironmentVerifier with Adversarial suite...');

const getValidProject = (): ProjectEntry => ({
  projectId: 'test-project',
  configFileIds: [],
  effectiveOptions: {} as any,
  optionsDerivationRef: { domain: ArtifactDomain.MANIFEST, digest: 'dummy' },
  roots: [{ projectId: 'test-project', fileId: 'index.ts' }],
  references: [],
  referenceMode: 'SOURCE'
});

function getValidManifest(manifestOverrides: Partial<EnvironmentManifest> = {}): EnvironmentManifest {
  return {
    schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
    rootSelectionPolicyId: RootPolicyId.F0_ENV_GIT_SEALED_V1,
    environmentBasis: 'RECORDED_BUILD',
    repositoryId: 'test-repo',
    revision: { commitId: 'dummy', treeId: 'dummy', parentSelection: 'dummy' },
    historicalBindingEvidenceRefs: [],
    packages: [],
    admittedRoots: [],
    ambientRoots: [],
    generatedArtifacts: [],
    boundaryPolicyId: 'dummy',
    inputEvidenceRefs: [],
    compiler: { 
      packageVersion: '1.0.0', 
      distributionDigest: 'dummy',
      parserProfileId: 'TEST_PROFILE',
      semanticProfileId: 'TEST_PROFILE' 
    },
    projects: [getValidProject()],
    namespace: {
      pathPolicyId: 'dummy',
      caseSensitivity: 'CASE_SENSITIVE',
      unicodePolicy: 'dummy',
      files: [],
      symlinks: [],
      directoryInventory: [],
      completenessEvidenceRefs: []
    },
    ...manifestOverrides
  } as unknown as EnvironmentManifest;
}

function verify(manifest: EnvironmentManifest, dataEntries: any[]) {
  const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
  const expectedDigest = hashContract(ArtifactDomain.MANIFEST, SAJIMORA_CERTIFIED_EVIDENCE_V1, manifest);
  const verifier = new EnvironmentVerifier(manifest, dataEntries, budget, expectedDigest);
  return verifier.verify();
}

// 1. verifies a valid environment
{
  const manifest = getValidManifest();
  const result = verify(manifest, []);
  assert(result.status === 'VERIFIED', 'Should verify valid environment');
}

// 2. Namespace: path traversal
{
  const manifest = getValidManifest();
  manifest.namespace.files = [{
    fileId: '../escape.ts', logicalPath: '../escape.ts', byteLength: 0, bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest: 'dummy' },
    mode: 0, kind: 'SOURCE' as const, origin: 'GIT_OBJECT' as const, provenanceRefs: []
  }];
  const result = verify(manifest, [{ digest: 'dummy', data: Buffer.from('') }]);
  assert(result.status === 'REJECTED' && result.blockerCode === BlockerCode.NAMESPACE_INCOMPLETE, 'Should reject ../ path traversal');
}

// 3. Namespace: absolute POSIX path
{
  const manifest = getValidManifest();
  manifest.namespace.files = [{
    fileId: '/etc/passwd', logicalPath: '/etc/passwd', byteLength: 0, bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest: 'dummy' },
    mode: 0, kind: 'SOURCE' as const, origin: 'GIT_OBJECT' as const, provenanceRefs: []
  }];
  const result = verify(manifest, [{ digest: 'dummy', data: Buffer.from('') }]);
  assert(result.status === 'REJECTED' && result.blockerCode === BlockerCode.NAMESPACE_INCOMPLETE, 'Should reject absolute POSIX path');
}

// 4. Namespace: Windows drive path
{
  const manifest = getValidManifest();
  manifest.namespace.files = [{
    fileId: 'C:\\secret.txt', logicalPath: 'C:\\secret.txt', byteLength: 0, bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest: 'dummy' },
    mode: 0, kind: 'SOURCE' as const, origin: 'GIT_OBJECT' as const, provenanceRefs: []
  }];
  const result = verify(manifest, [{ digest: 'dummy', data: Buffer.from('') }]);
  assert(result.status === 'REJECTED' && result.blockerCode === BlockerCode.NAMESPACE_INCOMPLETE, 'Should reject Windows drive path');
}

// 5. Namespace: UNC path
{
  const manifest = getValidManifest();
  manifest.namespace.files = [{
    fileId: '\\\\server\\share', logicalPath: '\\\\server\\share', byteLength: 0, bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest: 'dummy' },
    mode: 0, kind: 'SOURCE' as const, origin: 'GIT_OBJECT' as const, provenanceRefs: []
  }];
  const result = verify(manifest, [{ digest: 'dummy', data: Buffer.from('') }]);
  assert(result.status === 'REJECTED' && result.blockerCode === BlockerCode.NAMESPACE_INCOMPLETE, 'Should reject UNC path');
}

// 6. Namespace: duplicate logical paths
{
  const manifest = getValidManifest();
  const f = {
    fileId: 'index.ts', logicalPath: 'index.ts', byteLength: 0, bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest: 'dummy' },
    mode: 0, kind: 'SOURCE' as const, origin: 'GIT_OBJECT' as const, provenanceRefs: []
  };
  manifest.namespace.files = [f, { ...f }];
  const result = verify(manifest, [{ digest: 'dummy', data: Buffer.from('') }]);
  assert(result.status === 'REJECTED' && result.blockerCode === BlockerCode.NAMESPACE_INCOMPLETE, 'Should reject duplicate logical paths');
}

// 7. Namespace: Unicode canonical collision
{
  const manifest = getValidManifest();
  const f1 = {
    fileId: 'cafe\u0301', logicalPath: 'cafe\u0301', byteLength: 0, bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest: 'dummy' },
    mode: 0, kind: 'SOURCE' as const, origin: 'GIT_OBJECT' as const, provenanceRefs: []
  };
  manifest.namespace.files = [f1]; // unnormalized
  const result = verify(manifest, [{ digest: 'dummy', data: Buffer.from('') }]);
  assert(result.status === 'REJECTED' && result.blockerCode === BlockerCode.NAMESPACE_INCOMPLETE, 'Should reject unnormalized unicode paths');
}

// 8. Opaque payloads: directoryInventory
{
  const manifest = getValidManifest();
  manifest.namespace.directoryInventory = [{ _opaqueF0Semantics: 'UNRESOLVED', payload: [] } as any];
  const result = verify(manifest, []);
  assert(result.status === 'REJECTED' && result.blockerCode === BlockerCode.UNSUPPORTED_CONFIGURATION, 'Should reject opaque directory inventory');
}

// 9. Opaque payloads: effectiveOptions
{
  const manifest = getValidManifest();
  manifest.projects[0].effectiveOptions = { _opaqueF0Semantics: 'UNRESOLVED', payload: {} } as any;
  const result = verify(manifest, []);
  assert(result.status === 'REJECTED' && result.blockerCode === BlockerCode.UNSUPPORTED_CONFIGURATION, 'Should reject opaque effectiveOptions');
}

// 10. Trust-root mismatch
{
  const manifest = getValidManifest();
  const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
  const verifier = new EnvironmentVerifier(manifest, [], budget, 'bogus_expected_digest');
  const result = verifier.verify();
  assert(result.status === 'REJECTED' && result.blockerCode === BlockerCode.HASH_MISMATCH, 'Should reject mismatched trust-root');
}

// 11. Malformed historical basis
{
  const manifest = getValidManifest({ environmentBasis: 'UNKNOWN_BASIS' as any });
  const result = verify(manifest, []);
  assert(result.status === 'REJECTED' && result.blockerCode === BlockerCode.UNSUPPORTED_CONFIGURATION, 'Should reject unsupported environment basis');
}

console.log('EnvironmentVerifier tests passed.');

// 12. Namespace: mixed separators
{
  const manifest = getValidManifest();
  manifest.namespace.files = [{
    fileId: 'src\\index.ts', logicalPath: 'src\\index.ts', byteLength: 0, bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest: 'dummy' },
    mode: 0, kind: 'SOURCE' as const, origin: 'GIT_OBJECT' as const, provenanceRefs: []
  }];
  const result = verify(manifest, [{ digest: 'dummy', data: Buffer.from('') }]);
  assert(result.status === 'REJECTED' && result.blockerCode === BlockerCode.NAMESPACE_INCOMPLETE, 'Should reject mixed separators');
}

// 13. Namespace: case collision
{
  const manifest = getValidManifest();
  manifest.namespace.caseSensitivity = 'CASE_INSENSITIVE';
  manifest.namespace.files = [
    { fileId: 'index.ts', logicalPath: 'index.ts', byteLength: 0, bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest: 'dummy' }, mode: 0, kind: 'SOURCE' as const, origin: 'GIT_OBJECT' as const, provenanceRefs: [] },
    { fileId: 'INDEX.ts', logicalPath: 'INDEX.ts', byteLength: 0, bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest: 'dummy' }, mode: 0, kind: 'SOURCE' as const, origin: 'GIT_OBJECT' as const, provenanceRefs: [] }
  ];
  const result = verify(manifest, [{ digest: 'dummy', data: Buffer.from('') }]);
  assert(result.status === 'REJECTED' && result.blockerCode === BlockerCode.NAMESPACE_INCOMPLETE, 'Should reject case collision');
}

// 14. modified sealed bytes (hash mismatch)
{
  const manifest = getValidManifest();
  const f = {
    fileId: 'index.ts', logicalPath: 'index.ts', byteLength: 3, bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest: 'dummy' },
    mode: 0, kind: 'SOURCE' as const, origin: 'GIT_OBJECT' as const, provenanceRefs: []
  };
  manifest.namespace.files = [f];
  const result = verify(manifest, [{ digest: 'wrong_digest', data: Buffer.from('bad') }]);
  assert(result.status === 'REJECTED' && result.blockerCode === BlockerCode.HASH_MISMATCH, 'Should reject modified bytes');
}

// 15. Collector hash parity (regression test)
{
  const { EnvironmentCollector } = require('../../../src/sajimora/certified/environment/EnvironmentCollector');
  const { computeDomainSeparatedHash } = require('../../../../core/src/sajimora/certified/canonicalEncoding');
  const collector = new EnvironmentCollector(__dirname, 'dummy');
  const tempFile = path.join(__dirname, 'temp_parity_test.txt');
  fs.writeFileSync(tempFile, 'test content');
  try {
    const result = collector.collect(['temp_parity_test.txt'], [], [], []);
    const entry = result.dataEntries[0];
    const expectedHash = computeDomainSeparatedHash(ArtifactDomain.SOURCE_BYTES, SAJIMORA_CERTIFIED_EVIDENCE_V1, Buffer.from('test content'));
    assert(entry.digest === expectedHash, 'Collector digest == verifier recomputed digest');
  } finally {
    fs.unlinkSync(tempFile);
  }
}

console.log('All EnvironmentVerifier tests passed.');
