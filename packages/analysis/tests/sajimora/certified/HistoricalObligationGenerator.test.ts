import { test } from 'node:test';
import * as assert from 'node:assert';
import ts from 'typescript';
import { HistoricalObligationGenerator } from '../../../src/sajimora/certified/obligations/HistoricalObligationGenerator';
import { ObligationVerifier } from '../../../src/sajimora/certified/obligations/ObligationVerifier';
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
import { CertifiedCorrespondence } from '../../../src/sajimora/certified/identity/CertifiedCorrespondence';
import * as crypto from 'node:crypto';

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

test('HistoricalObligationGenerator & ObligationVerifier Test Suite', async (t) => {
  const targetIdRef: ArtifactRef = { domain: ArtifactDomain.SOURCE_BYTES, digest: 'a'.repeat(64) };
  const lifecycleRef: ArtifactRef = { domain: ArtifactDomain.SOURCE_BYTES, digest: 'b'.repeat(64) };

  await t.test('correctly extracts call site arguments with contravariant direction', () => {
    const parentFiles = [
      {
        path: 'provider.ts',
        content: `export function compute(x: string): string { return x; }`
      },
      {
        path: 'consumer.ts',
        content: `
          import { compute } from './provider';
          export const res: string = compute("hello");
        `
      }
    ];

    const candFiles = [
      {
        path: 'provider.ts',
        content: `export function compute(x: string | number): string { return "done"; }`
      }
    ];

    const { manifest: pManifest, sealedFs: pFs } = createManifestAndSealedFs(parentFiles);
    const { manifest: cManifest, sealedFs: cFs } = createManifestAndSealedFs(candFiles);
    const declarationId = crypto.createHash('sha256')
      .update('p0|provider.ts||FunctionDeclaration|compute|0').digest('hex');
    const correspondence = CertifiedCorrespondence.produce(pManifest, cManifest, pFs, cFs,
      'provider.ts', declarationId);
    assert.ok(correspondence);

    const { obligations, occurrences } = HistoricalObligationGenerator.generateObligations(
      pManifest,
      cManifest,
      pFs,
      cFs,
      'compute',
      targetIdRef,
      lifecycleRef,
      correspondence
    );

    assert.strictEqual(obligations.length, 1);
    assert.strictEqual(occurrences.length, 1);
    assert.strictEqual(occurrences[0].contextKind, 'CALL_SITE');

    const rels = Array.from(obligations[0].requiredRelations);
    // Should have ARG_0, ARITY_CHECK, and RETURN_CHECK
    const argRel = rels.find(r => r.kind === 'PARAMETER_ACCEPTS_ARGUMENT');
    assert.ok(argRel, 'Must have PARAMETER_ACCEPTS_ARGUMENT relation');
    assert.strictEqual(argRel?.position, '0');

    // Direction check: source is historical argument ("hello" / string), target is candidate parameter (string | number)
    assert.ok(argRel?.sourceTermRefOrNull, 'Must have historical argument term');
    assert.ok(argRel?.targetTermRefOrNull, 'Must have candidate parameter term');

    // Now verify with ObligationVerifier
    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verResult = ObligationVerifier.verify(
      pManifest,
      cManifest,
      pFs,
      cFs,
      'compute',
      targetIdRef,
      lifecycleRef,
      obligations,
      budget,
      correspondence
    );

    assert.strictEqual(verResult.valid, true);
  });

  await t.test('detects and rejects omitted obligation with MISSING_OBLIGATION', () => {
    const parentFiles = [
      {
        path: 'provider.ts',
        content: `export function compute(x: string): string { return x; }`
      },
      {
        path: 'consumer.ts',
        content: `
          import { compute } from './provider';
          export const a: string = compute("first");
          export const b: string = compute("second");
        `
      }
    ];

    const candFiles = [
      {
        path: 'provider.ts',
        content: `export function compute(x: string): string { return x; }`
      }
    ];

    const { manifest: pManifest, sealedFs: pFs } = createManifestAndSealedFs(parentFiles);
    const { manifest: cManifest, sealedFs: cFs } = createManifestAndSealedFs(candFiles);

    const { obligations } = HistoricalObligationGenerator.generateObligations(
      pManifest,
      cManifest,
      pFs,
      cFs,
      'compute',
      targetIdRef,
      lifecycleRef
    );

    assert.strictEqual(obligations.length, 2);

    // Deliberately omit the second obligation
    const incompleteObligations = [obligations[0]];

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verResult = ObligationVerifier.verify(
      pManifest,
      cManifest,
      pFs,
      cFs,
      'compute',
      targetIdRef,
      lifecycleRef,
      incompleteObligations,
      budget
    );

    assert.strictEqual(verResult.valid, false);
    assert.strictEqual(verResult.blockerCode, BlockerCode.MISSING_OBLIGATION);
  });

  await t.test('detects and rejects fabricated obligation with INVALID_RULE_APPLICATION', () => {
    const parentFiles = [
      {
        path: 'provider.ts',
        content: `export function compute(x: string): string { return x; }`
      },
      {
        path: 'consumer.ts',
        content: `
          import { compute } from './provider';
          export const a: string = compute("first");
        `
      }
    ];

    const candFiles = [
      {
        path: 'provider.ts',
        content: `export function compute(x: string): string { return x; }`
      }
    ];

    const { manifest: pManifest, sealedFs: pFs } = createManifestAndSealedFs(parentFiles);
    const { manifest: cManifest, sealedFs: cFs } = createManifestAndSealedFs(candFiles);

    const { obligations } = HistoricalObligationGenerator.generateObligations(
      pManifest,
      cManifest,
      pFs,
      cFs,
      'compute',
      targetIdRef,
      lifecycleRef
    );

    // Fabricate an extra phantom obligation
    const phantomObl = {
      ...obligations[0],
      historicalOccurrenceAnchor: {
        ...obligations[0].historicalOccurrenceAnchor,
        utf16Start: 9999,
        utf16End: 10000
      }
    };

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verResult = ObligationVerifier.verify(
      pManifest,
      cManifest,
      pFs,
      cFs,
      'compute',
      targetIdRef,
      lifecycleRef,
      [...obligations, phantomObl],
      budget
    );

    assert.strictEqual(verResult.valid, false);
    assert.strictEqual(verResult.blockerCode, BlockerCode.INVALID_RULE_APPLICATION);
  });

  await t.test('rejects duplicate obligation for same anchor with AMBIGUOUS_DECLARATION_GROUP', () => {
    const parentFiles = [
      {
        path: 'provider.ts',
        content: `export function compute(x: string): string { return x; }`
      },
      {
        path: 'consumer.ts',
        content: `
          import { compute } from './provider';
          export const a: string = compute("first");
        `
      }
    ];

    const candFiles = [
      {
        path: 'provider.ts',
        content: `export function compute(x: string): string { return x; }`
      }
    ];

    const { manifest: pManifest, sealedFs: pFs } = createManifestAndSealedFs(parentFiles);
    const { manifest: cManifest, sealedFs: cFs } = createManifestAndSealedFs(candFiles);

    const { obligations } = HistoricalObligationGenerator.generateObligations(
      pManifest,
      cManifest,
      pFs,
      cFs,
      'compute',
      targetIdRef,
      lifecycleRef
    );

    // Duplicate the obligation
    const duplicated = [obligations[0], obligations[0]];

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verResult = ObligationVerifier.verify(
      pManifest,
      cManifest,
      pFs,
      cFs,
      'compute',
      targetIdRef,
      lifecycleRef,
      duplicated,
      budget
    );

    assert.strictEqual(verResult.valid, false);
    assert.strictEqual(verResult.blockerCode, BlockerCode.INVALID_SCHEMA);
  });

  await t.test('replays a namespace member call to its direct provider export', () => {
    const parentFiles = [
      { path: 'provider.ts', content: `export function compute(x: string): string { return x; }` },
      { path: 'consumer.ts', content: `import * as ns from './provider'; export const result: string = ns.compute("ok");` }
    ];
    const candidateFiles = [
      { path: 'provider.ts', content: `export function compute(x: string): string { return x; }` }
    ];
    const { manifest: pManifest, sealedFs: pFs } = createManifestAndSealedFs(parentFiles);
    const { manifest: cManifest, sealedFs: cFs } = createManifestAndSealedFs(candidateFiles);
    const generated = HistoricalObligationGenerator.generateObligations(
      pManifest, cManifest, pFs, cFs, 'compute', targetIdRef, lifecycleRef
    );
    assert.equal(generated.obligations.length, 1);
    assert.equal(generated.occurrences[0].contextKind, 'CALL_SITE');
    assert.equal(ObligationVerifier.verify(
      pManifest, cManifest, pFs, cFs, 'compute', targetIdRef, lifecycleRef,
      generated.obligations, new VerificationBudget(INITIAL_RESOURCE_PROFILE)
    ).valid, true);
  });

  await t.test('uses only explicit scalar parameter annotations as identifier witnesses', () => {
    const source = ts.createSourceFile('witness.ts', `
      function outer(value: string) {
        const inner = (value: number) => value;
        return value;
      }
      function unsupported(value: any) { return value; }
    `, ts.ScriptTarget.Latest, true);
    const outer = source.statements.find(ts.isFunctionDeclaration)!;
    const inner = (outer.body!.statements[0] as ts.VariableStatement).declarationList.declarations[0].initializer as ts.ArrowFunction;
    const innerValue = inner.body as ts.Identifier;
    const outerValue = (outer.body!.statements[1] as ts.ReturnStatement).expression as ts.Identifier;
    const unsupported = source.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'unsupported')!;
    const unsupportedValue = (unsupported.body!.statements[0] as ts.ReturnStatement).expression as ts.Identifier;

    assert.deepEqual(HistoricalObligationGenerator.inferExpressionType(innerValue, source), { kind: 'primitive', name: 'number' });
    assert.deepEqual(HistoricalObligationGenerator.inferExpressionType(outerValue, source), { kind: 'primitive', name: 'string' });
    assert.throws(() => HistoricalObligationGenerator.inferExpressionType(unsupportedValue, source), /No sealed F0 type witness/);
  });
});
