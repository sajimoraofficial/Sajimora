import { test } from 'node:test';
import * as assert from 'node:assert';
import { FrozenIdentityGate, DiffEvidence } from '../../../src/sajimora/certified/identity/FrozenIdentityGate';
import { SealedFilesystem } from '../../../src/sajimora/certified/environment/SealedFilesystem';
import {
  CrossVersionIdentityBundle,
  CrossVersionSymbolMapping,
  CanonicalSymbolIdentity
} from '../../../../core/src/sajimora/types/identity';
import { EnvironmentManifest, FileEntry } from '../../../../core/src/sajimora/certified/contracts';
import { BlockerCode } from '../../../../core/src/sajimora/certified/blockers';
import {
  ArtifactDomain,
  SAJIMORA_CERTIFIED_EVIDENCE_V1
} from '../../../../core/src/sajimora/certified/protocol';
import { CanonicalSet, computeDomainSeparatedHash } from '../../../../core/src/sajimora/certified/canonicalEncoding';

function createSealedFs(files: { path: string; content: string }[]): SealedFilesystem {
  const fileEntries: FileEntry[] = files.map(f => {
    const buf = Buffer.from(f.content, 'utf8');
    const digest = computeDomainSeparatedHash(
      ArtifactDomain.SOURCE_BYTES,
      SAJIMORA_CERTIFIED_EVIDENCE_V1,
      buf
    );
    return {
      fileId: f.path,
      logicalPath: f.path,
      byteLength: buf.length,
      bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest },
      mode: 0o644,
      kind: 'SOURCE',
      origin: 'GIT_OBJECT',
      provenanceRefs: []
    };
  });

  const dataEntries = files.map(f => {
    const buf = Buffer.from(f.content, 'utf8');
    const digest = computeDomainSeparatedHash(
      ArtifactDomain.SOURCE_BYTES,
      SAJIMORA_CERTIFIED_EVIDENCE_V1,
      buf
    );
    return { digest, data: buf };
  });

  return new SealedFilesystem(fileEntries, dataEntries, 'CASE_SENSITIVE');
}

function createDummyManifest(): EnvironmentManifest {
  return {
    schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
    repositoryId: 'test-repo',
    revision: { commitId: 'c1', treeId: 't1', parentSelection: 'p' },
    environmentBasis: 'REPOSITORY_DETERMINED_RECONSTRUCTION',
    historicalBindingEvidenceRefs: [],
    namespace: {
      pathPolicyId: 'POLICY_POSIX_V1',
      caseSensitivity: 'CASE_SENSITIVE',
      unicodePolicy: 'NFC',
      files: [],
      symlinks: [],
      directoryInventory: [],
      completenessEvidenceRefs: new CanonicalSet()
    },
    compiler: {
      packageVersion: '5.9.3',
      distributionDigest: '0000000000000000000000000000000000000000000000000000000000000000',
      parserProfileId: 'TS_5_9_3_STRICT',
      semanticProfileId: 'TS_FINITE_CONTRACTS_F0'
    },
    projects: [],
    packages: [],
    rootSelectionPolicyId: 'F0_ENV_GIT_SEALED_V1',
    admittedRoots: new CanonicalSet(),
    ambientRoots: new CanonicalSet(),
    generatedArtifacts: new CanonicalSet(),
    boundaryPolicyId: 'F0_STRICT_BOUNDARY_V1',
    inputEvidenceRefs: new CanonicalSet()
  };
}

function makeSymbol(file: string, name: string): CanonicalSymbolIdentity {
  return {
    identityId: `sym:${file}:${name}`,
    projectId: 'p1',
    moduleIdentity: file,
    ownerChain: [],
    localName: name,
    declarationKind: 'FunctionDeclaration',
    declarationOrdinal: 0,
    sourceSpan: { start: 0, end: 10, line: 1, column: 1, endLine: 1, endColumn: 11 },
    exportPaths: [file],
    parameterShape: '()',
    astFingerprint: 'fp123'
  };
}

test('FrozenIdentityGate - Strict Case-B & Deletion Invariant Battery', async (t) => {
  const pManifest = createDummyManifest();
  const cManifest = createDummyManifest();

  await t.test('Case-B modified file preserves UNRESOLVED identity', () => {
    const parentFile = 'src/service.ts';
    const pFs = createSealedFs([{ path: parentFile, content: 'export function run(): number { return 1; }' }]);
    const cFs = createSealedFs([{ path: parentFile, content: 'export function run(): number { return 2; }' }]);
    const diffs: DiffEvidence[] = [{ parentPath: parentFile, candidatePath: parentFile }];

    const pSym = makeSymbol(parentFile, 'run');
    const cSym = makeSymbol(parentFile, 'run');

    const mapping: CrossVersionSymbolMapping = {
      parent: pSym,
      candidate: cSym,
      status: 'UNRESOLVED',
      evidence: [],
      plausibleCandidateIds: [cSym.identityId]
    };

    const bundle: CrossVersionIdentityBundle = {
      targetMappings: [mapping],
      consumerMappings: [],
      status: 'INCOMPLETE',
      blockers: ['UNRESOLVED:run'],
      phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' },
      boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 }
    };

    const res = FrozenIdentityGate.evaluateTarget(pManifest, cManifest, pSym.identityId, bundle, pFs, cFs, diffs);
    assert.strictEqual(res.status, 'UNRESOLVED');
    assert.strictEqual(res.isCaseB, true);
  });

  await t.test('Case-B rejects illegal upgrade to SAME_DECLARATION with IDENTITY_MISMATCH', () => {
    const parentFile = 'src/service.ts';
    const pFs = createSealedFs([{ path: parentFile, content: 'export function run(): number { return 1; }' }]);
    const cFs = createSealedFs([{ path: parentFile, content: 'export function run(): number { return 2; }' }]);
    const diffs: DiffEvidence[] = [{ parentPath: parentFile, candidatePath: parentFile }];

    const pSym = makeSymbol(parentFile, 'run');
    const cSym = makeSymbol(parentFile, 'run');

    // Hostile producer claims SAME_DECLARATION in a modified file
    const forgedMapping: CrossVersionSymbolMapping = {
      parent: pSym,
      candidate: cSym,
      status: 'SAME_DECLARATION',
      evidence: [],
      plausibleCandidateIds: []
    };

    const bundle: CrossVersionIdentityBundle = {
      targetMappings: [forgedMapping],
      consumerMappings: [],
      status: 'COMPLETE',
      blockers: [],
      phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' },
      boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 }
    };

    const res = FrozenIdentityGate.evaluateTarget(pManifest, cManifest, pSym.identityId, bundle, pFs, cFs, diffs);
    assert.strictEqual(res.status, 'REJECTED');
    assert.strictEqual(res.blockerCode, BlockerCode.IDENTITY_MISMATCH);
    assert.strictEqual(res.isCaseB, true);
  });

  await t.test('rejects unproven deletion claim when candidate is absent with IDENTITY_MISMATCH', () => {
    const parentFile = 'src/service.ts';
    const pFs = createSealedFs([{ path: parentFile, content: 'export function run(): number { return 1; }' }]);
    const cFs = createSealedFs([{ path: parentFile, content: '// run removed' }]);
    const diffs: DiffEvidence[] = [{ parentPath: parentFile, candidatePath: parentFile }];

    const pSym = makeSymbol(parentFile, 'run');

    // Producer claims REMOVED_DECLARATION without actual deletion proof
    const mapping: CrossVersionSymbolMapping = {
      parent: pSym,
      candidate: undefined,
      status: 'REMOVED_DECLARATION',
      evidence: [], // missing DECLARATION_DELETED_IN_DIFF_HUNK
      plausibleCandidateIds: []
    };

    const bundle: CrossVersionIdentityBundle = {
      targetMappings: [mapping],
      consumerMappings: [],
      status: 'COMPLETE',
      blockers: [],
      phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' },
      boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 }
    };

    const res = FrozenIdentityGate.evaluateTarget(pManifest, cManifest, pSym.identityId, bundle, pFs, cFs, diffs);
    assert.strictEqual(res.status, 'REJECTED');
    assert.strictEqual(res.blockerCode, BlockerCode.IDENTITY_MISMATCH);
  });

  await t.test('Case-A unmodified file proves SAME_DECLARATION with byte-identical check', () => {
    const file = 'src/constant.ts';
    const content = 'export const PI: number = 3.14159;';
    const pFs = createSealedFs([{ path: file, content }]);
    const cFs = createSealedFs([{ path: file, content }]);
    const diffs: DiffEvidence[] = []; // no diff

    const pSym = makeSymbol(file, 'PI');
    const cSym = makeSymbol(file, 'PI');

    const mapping: CrossVersionSymbolMapping = {
      parent: pSym,
      candidate: cSym,
      status: 'SAME_DECLARATION',
      evidence: [],
      plausibleCandidateIds: []
    };

    const bundle: CrossVersionIdentityBundle = {
      targetMappings: [mapping],
      consumerMappings: [],
      status: 'COMPLETE',
      blockers: [],
      phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' },
      boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 }
    };

    const res = FrozenIdentityGate.evaluateTarget(pManifest, cManifest, pSym.identityId, bundle, pFs, cFs, diffs);
    assert.strictEqual(res.status, 'PROVEN');
    assert.strictEqual(res.isCaseB, false);
  });

  await t.test('Case-A rejects SAME_DECLARATION when file bytes differ in sealed filesystems', () => {
    const file = 'src/constant.ts';
    const pFs = createSealedFs([{ path: file, content: 'export const PI: number = 3.14;' }]);
    const cFs = createSealedFs([{ path: file, content: 'export const PI: number = 3.14159;' }]);
    const diffs: DiffEvidence[] = []; // Hostile: no diff provided, but sealed fs has altered bytes

    const pSym = makeSymbol(file, 'PI');
    const cSym = makeSymbol(file, 'PI');

    const mapping: CrossVersionSymbolMapping = {
      parent: pSym,
      candidate: cSym,
      status: 'SAME_DECLARATION',
      evidence: [],
      plausibleCandidateIds: []
    };

    const bundle: CrossVersionIdentityBundle = {
      targetMappings: [mapping],
      consumerMappings: [],
      status: 'COMPLETE',
      blockers: [],
      phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' },
      boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 }
    };

    const res = FrozenIdentityGate.evaluateTarget(pManifest, cManifest, pSym.identityId, bundle, pFs, cFs, diffs);
    assert.strictEqual(res.status, 'REJECTED');
    assert.strictEqual(res.blockerCode, BlockerCode.IDENTITY_MISMATCH);
  });

  await t.test('evaluateConsumers rejects targetIdentity SAME when target is Case-B', () => {
    const targetResult = {
      status: 'UNRESOLVED' as const,
      isCaseB: true,
      reason: 'Case-B'
    };

    const bundle: CrossVersionIdentityBundle = {
      targetMappings: [],
      consumerMappings: [{
        mappingId: 'cm1',
        lifecycle: 'STABLE_CHANGED_SAME_COMMIT',
        targetIdentity: 'SAME', // Hostile attempt to claim SAME for Case-B consumer!
        evidence: []
      }],
      status: 'COMPLETE',
      blockers: [],
      phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' },
      boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 }
    };

    const cRes = FrozenIdentityGate.evaluateConsumers(targetResult, bundle);
    assert.strictEqual(cRes.valid, false);
    assert.strictEqual(cRes.blockerCode, BlockerCode.IDENTITY_MISMATCH);
  });

  await t.test('evaluateConsumers rejects STABLE_UNCHANGED lifecycle when consumer file is modified', () => {
    const targetResult = {
      status: 'PROVEN' as const,
      isCaseB: false,
      reason: 'Case-A'
    };

    const diffs: DiffEvidence[] = [{ parentPath: 'src/consumer.ts', candidatePath: 'src/consumer.ts' }];
    const bundle: CrossVersionIdentityBundle = {
      targetMappings: [],
      consumerMappings: [{
        mappingId: 'cm2',
        lifecycle: 'STABLE_UNCHANGED', // Hostile: file was modified but claimed unchanged!
        targetIdentity: 'SAME',
        evidence: [{
          evidenceId: 'ev1',
          kind: 'DIFF_CORRESPONDENCE',
          parentLocation: { file: 'src/consumer.ts', line: 10, column: 5 },
          detail: 'modified'
        }]
      }],
      status: 'COMPLETE',
      blockers: [],
      phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' },
      boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 }
    };

    const cRes = FrozenIdentityGate.evaluateConsumers(targetResult, bundle, diffs);
    assert.strictEqual(cRes.valid, false);
    assert.strictEqual(cRes.blockerCode, BlockerCode.LIFECYCLE_RULE_VIOLATION);
  });
});
