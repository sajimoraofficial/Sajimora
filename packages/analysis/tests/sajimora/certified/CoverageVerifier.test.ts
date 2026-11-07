import { test } from 'node:test';
import * as assert from 'node:assert';
import { CoverageProducer } from '../../../src/sajimora/certified/coverage/CoverageProducer';
import { CoverageVerifier } from '../../../src/sajimora/certified/coverage/CoverageVerifier';
import { HistoricalObligationGenerator } from '../../../src/sajimora/certified/obligations/HistoricalObligationGenerator';
import { SealedFilesystem } from '../../../src/sajimora/certified/environment/SealedFilesystem';
import { VerificationBudget } from '../../../src/sajimora/certified/proof/VerificationBudget';
import {
  INITIAL_RESOURCE_PROFILE,
  ArtifactDomain,
  SAJIMORA_CERTIFIED_EVIDENCE_V1,
  RootPolicyId,
  BoundaryPolicyId,
  ParserProfileId,
  SemanticProfileId
} from '../../../../core/src/sajimora/certified/protocol';
import { BlockerCode, ArtifactRef } from '../../../../core/src/sajimora/certified/blockers';
import { EnvironmentManifest, FileEntry, Vertex } from '../../../../core/src/sajimora/certified/contracts';
import { CanonicalSet, computeDomainSeparatedHash } from '../../../../core/src/sajimora/certified/canonicalEncoding';

function createManifestAndSealedFs(files: { path: string; content: string }[]): {
  manifest: EnvironmentManifest;
  sealedFs: SealedFilesystem;
} {
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

  const sealedFs = new SealedFilesystem(fileEntries, dataEntries, 'CASE_SENSITIVE');

  const manifest: EnvironmentManifest = {
    schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
    repositoryId: 'repo-test',
    revision: { commitId: 'c1', treeId: 't1', parentSelection: 'p1' },
    environmentBasis: 'REPOSITORY_DETERMINED_RECONSTRUCTION',
    historicalBindingEvidenceRefs: [],
    namespace: {
      pathPolicyId: 'POLICY_V1',
      caseSensitivity: 'CASE_SENSITIVE',
      unicodePolicy: 'NFC',
      files: fileEntries,
      symlinks: [],
      directoryInventory: [],
      completenessEvidenceRefs: new CanonicalSet<ArtifactRef>([])
    },
    compiler: {
      packageVersion: '5.9.3',
      distributionDigest: 'dist-hash',
      parserProfileId: ParserProfileId.TS_5_9_3_STRICT,
      semanticProfileId: SemanticProfileId.TS_FINITE_CONTRACTS_F0
    },
    projects: [
      {
        projectId: 'p0',
        configFileIds: ['tsconfig.json'],
        effectiveOptions: { _opaqueF0Semantics: 'UNRESOLVED', payload: {} },
        optionsDerivationRef: { domain: ArtifactDomain.SOURCE_BYTES, digest: '1'.repeat(64) },
        roots: files.map(f => ({ projectId: 'p0', fileId: f.path })),
        references: [],
        referenceMode: 'SOURCE'
      }
    ],
    packages: [],
    rootSelectionPolicyId: RootPolicyId.F0_ENV_GIT_SEALED_V1,
    admittedRoots: new CanonicalSet<Vertex>(files.map(f => ({ projectId: 'p0', fileId: f.path }))),
    ambientRoots: new CanonicalSet<any>([]),
    generatedArtifacts: new CanonicalSet<any>([]),
    boundaryPolicyId: BoundaryPolicyId.F0_STRICT_BOUNDARY_V1,
    inputEvidenceRefs: new CanonicalSet<ArtifactRef>([])
  };

  return { manifest, sealedFs };
}

test('CoverageProducer & CoverageVerifier Test Suite', async (t) => {
  const targetIdRef: ArtifactRef = { domain: ArtifactDomain.SOURCE_BYTES, digest: 'a'.repeat(64) };
  const lifecycleRef: ArtifactRef = { domain: ArtifactDomain.SOURCE_BYTES, digest: 'b'.repeat(64) };
  const fragRef: ArtifactRef = { domain: ArtifactDomain.ADMISSION, digest: 'c'.repeat(64) };

  await t.test('verifies sound EXACT coverage with non-empty occurrences', () => {
    const parentFiles = [
      {
        path: 'provider.ts',
        content: `export function helper(v: string): string { return v; }`
      },
      {
        path: 'consumer.ts',
        content: `
          import { helper } from './provider';
          export const val: string = helper("test");
        `
      }
    ];

    const candFiles = [
      {
        path: 'provider.ts',
        content: `export function helper(v: string): string { return v; }`
      }
    ];

    const { manifest: pManifest, sealedFs: pFs } = createManifestAndSealedFs(parentFiles);
    const { manifest: cManifest } = createManifestAndSealedFs(candFiles);

    const { obligations } = HistoricalObligationGenerator.generateObligations(
      pManifest,
      cManifest,
      pFs,
      pFs,
      'helper',
      targetIdRef,
      lifecycleRef
    );

    const coverageCert = CoverageProducer.produceCoverage(
      pManifest,
      cManifest,
      pFs,
      'helper',
      targetIdRef,
      new CanonicalSet<ArtifactRef>([fragRef]),
      obligations
    );

    assert.strictEqual(coverageCert.mode, 'EXACT');
    assert.ok(coverageCert.nonemptyActualWitnessRefOrNull !== null);

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verResult = CoverageVerifier.verify(
      pManifest,
      cManifest,
      pFs,
      'helper',
      obligations,
      coverageCert,
      budget
    );

    assert.strictEqual(verResult.valid, true);
    assert.strictEqual(verResult.actualOccurrencesCount, 1);
    assert.strictEqual(verResult.isEmptyDomain, false);
  });

  await t.test('verifies empty domain (0 consumers) with null witness', () => {
    const parentFiles = [
      {
        path: 'provider.ts',
        content: `export function unused(): string { return "unused"; }`
      },
      {
        path: 'other.ts',
        content: `export const num: number = 42;`
      }
    ];

    const candFiles = [
      {
        path: 'provider.ts',
        content: `export function unused(): string { return "unused"; }`
      }
    ];

    const { manifest: pManifest, sealedFs: pFs } = createManifestAndSealedFs(parentFiles);
    const { manifest: cManifest } = createManifestAndSealedFs(candFiles);

    const { obligations } = HistoricalObligationGenerator.generateObligations(
      pManifest,
      cManifest,
      pFs,
      pFs,
      'unused',
      targetIdRef,
      lifecycleRef
    );

    assert.strictEqual(obligations.length, 0);

    const coverageCert = CoverageProducer.produceCoverage(
      pManifest,
      cManifest,
      pFs,
      'unused',
      targetIdRef,
      new CanonicalSet<ArtifactRef>([fragRef]),
      obligations
    );

    assert.strictEqual(coverageCert.nonemptyActualWitnessRefOrNull, null);

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verResult = CoverageVerifier.verify(
      pManifest,
      cManifest,
      pFs,
      'unused',
      obligations,
      coverageCert,
      budget
    );

    assert.strictEqual(verResult.valid, true);
    assert.strictEqual(verResult.actualOccurrencesCount, 0);
    assert.strictEqual(verResult.isEmptyDomain, true);
  });

  await t.test('rejects non-EXACT mode with UNSUPPORTED_COVERAGE_MODE', () => {
    const parentFiles = [
      {
        path: 'provider.ts',
        content: `export function helper(v: string): string { return v; }`
      }
    ];

    const { manifest: pManifest, sealedFs: pFs } = createManifestAndSealedFs(parentFiles);
    const { manifest: cManifest } = createManifestAndSealedFs(parentFiles);

    const coverageCert = CoverageProducer.produceCoverage(
      pManifest,
      cManifest,
      pFs,
      'helper',
      targetIdRef,
      new CanonicalSet<ArtifactRef>([fragRef]),
      []
    );

    // Tamper mode to SOUND_SUPERSET
    const tamperedCert = {
      ...coverageCert,
      mode: 'SOUND_SUPERSET' as any
    };

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verResult = CoverageVerifier.verify(
      pManifest,
      cManifest,
      pFs,
      'helper',
      [],
      tamperedCert,
      budget
    );

    assert.strictEqual(verResult.valid, false);
    assert.strictEqual(verResult.blockerCode, BlockerCode.UNSUPPORTED_COVERAGE_MODE);
  });

  await t.test('detects omitted context in ledger with MISSING_EVIDENCE', () => {
    const parentFiles = [
      {
        path: 'provider.ts',
        content: `export function helper(v: string): string { return v; }`
      },
      {
        path: 'consumer.ts',
        content: `
          import { helper } from './provider';
          export const v1: string = helper("one");
          export const v2: string = helper("two");
        `
      }
    ];

    const { manifest: pManifest, sealedFs: pFs } = createManifestAndSealedFs(parentFiles);
    const { manifest: cManifest } = createManifestAndSealedFs(parentFiles);

    const { obligations } = HistoricalObligationGenerator.generateObligations(
      pManifest,
      cManifest,
      pFs,
      pFs,
      'helper',
      targetIdRef,
      lifecycleRef
    );

    const coverageCert = CoverageProducer.produceCoverage(
      pManifest,
      cManifest,
      pFs,
      'helper',
      targetIdRef,
      new CanonicalSet<ArtifactRef>([fragRef]),
      obligations
    );

    // Drop one entry from ledger
    const ledgerList = Array.from(coverageCert.contextDispositionLedger);
    const truncatedLedger = ledgerList.slice(0, ledgerList.length - 1);

    const tamperedCert = {
      ...coverageCert,
      contextDispositionLedger: new CanonicalSet<any>(truncatedLedger)
    };

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verResult = CoverageVerifier.verify(
      pManifest,
      cManifest,
      pFs,
      'helper',
      obligations,
      tamperedCert,
      budget
    );

    assert.strictEqual(verResult.valid, false);
    assert.strictEqual(verResult.blockerCode, BlockerCode.MISSING_EVIDENCE);
  });

  await t.test('rejects duplicate context in ledger with INVALID_SCHEMA', () => {
    const parentFiles = [
      {
        path: 'provider.ts',
        content: `export function helper(v: string): string { return v; }`
      },
      {
        path: 'consumer.ts',
        content: `
          import { helper } from './provider';
          export const v1: string = helper("one");
        `
      }
    ];

    const { manifest: pManifest, sealedFs: pFs } = createManifestAndSealedFs(parentFiles);
    const { manifest: cManifest } = createManifestAndSealedFs(parentFiles);

    const { obligations } = HistoricalObligationGenerator.generateObligations(
      pManifest,
      cManifest,
      pFs,
      pFs,
      'helper',
      targetIdRef,
      lifecycleRef
    );

    const coverageCert = CoverageProducer.produceCoverage(
      pManifest,
      cManifest,
      pFs,
      'helper',
      targetIdRef,
      new CanonicalSet<ArtifactRef>([fragRef]),
      obligations
    );

    // Duplicate an entry in ledger with distinct object reference
    const ledgerList = Array.from(coverageCert.contextDispositionLedger);
    const duplicatedLedger = [
      ...ledgerList,
      { ...ledgerList[0], reason: 'Duplicate conflicting disposition entry' }
    ];

    const tamperedCert = {
      ...coverageCert,
      contextDispositionLedger: new CanonicalSet<any>(duplicatedLedger)
    };

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verResult = CoverageVerifier.verify(
      pManifest,
      cManifest,
      pFs,
      'helper',
      obligations,
      tamperedCert,
      budget
    );

    assert.strictEqual(verResult.valid, false);
    assert.strictEqual(verResult.blockerCode, BlockerCode.INVALID_SCHEMA);
  });

  await t.test('covers a namespace member call using the replayed direct-export mapping', () => {
    const parentFiles = [
      { path: 'provider.ts', content: `export function helper(v: string): string { return v; }` },
      { path: 'consumer.ts', content: `import * as ns from './provider'; export const value: string = ns.helper("test");` }
    ];
    const candFiles = [{ path: 'provider.ts', content: `export function helper(v: string): string { return v; }` }];
    const { manifest: pManifest, sealedFs: pFs } = createManifestAndSealedFs(parentFiles);
    const { manifest: cManifest } = createManifestAndSealedFs(candFiles);
    const { obligations } = HistoricalObligationGenerator.generateObligations(
      pManifest, cManifest, pFs, pFs, 'helper', targetIdRef, lifecycleRef
    );
    const coverage = CoverageProducer.produceCoverage(
      pManifest, cManifest, pFs, 'helper', targetIdRef,
      new CanonicalSet<ArtifactRef>([fragRef]), obligations
    );
    const verified = CoverageVerifier.verify(
      pManifest, cManifest, pFs, 'helper', obligations, coverage,
      new VerificationBudget(INITIAL_RESOURCE_PROFILE)
    );
    assert.equal(verified.valid, true);
    assert.equal(verified.actualOccurrencesCount, 1);
  });
});
