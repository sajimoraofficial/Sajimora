import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DependencyClosureVerifier, BoundaryDischarge } from '../../../../packages/analysis/src/sajimora/certified/closure/DependencyClosureVerifier';
import { DependencyClosureProducer } from '../../../../packages/analysis/src/sajimora/certified/closure/DependencyClosureProducer';
import { ASTAnchorExtractor } from '../../../../packages/analysis/src/sajimora/certified/closure/ASTExtractor';
import { F0RestrictedResolver } from '../../../../packages/analysis/src/sajimora/certified/closure/F0RestrictedResolver';
import { SealedFilesystem } from '../../../../packages/analysis/src/sajimora/certified/environment/SealedFilesystem';
import { VerificationBudget } from '../../../../packages/analysis/src/sajimora/certified/proof/VerificationBudget';
import { 
  FileEntry, 
  Vertex, 
  EnvironmentManifest,
  AmbientRoot,
  ResolutionFact,
  DependencyClosureCertificate
} from '../../../../packages/core/src/sajimora/certified/contracts';
import { 
  CanonicalSet, 
  computeDomainSeparatedHash, 
  hashContract 
} from '../../../../packages/core/src/sajimora/certified/canonicalEncoding';
import { 
  ArtifactDomain, 
  RootPolicyId, 
  SAJIMORA_CERTIFIED_EVIDENCE_V1, 
  INITIAL_RESOURCE_PROFILE,
  ResolverProfileId
} from '../../../../packages/core/src/sajimora/certified/protocol';
import { BlockerCode } from '../../../../packages/core/src/sajimora/certified/blockers';

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

function createManifest(manifestOverrides: Partial<EnvironmentManifest> = {}): EnvironmentManifest {
  return {
    schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
    rootSelectionPolicyId: RootPolicyId.F0_ENV_GIT_SEALED_V1,
    environmentBasis: 'RECORDED_BUILD',
    repositoryId: 'test-repo',
    revision: { commitId: 'c1', treeId: 't1', parentSelection: 'p1' },
    historicalBindingEvidenceRefs: [],
    namespace: {
      pathPolicyId: 'POSIX',
      caseSensitivity: 'CASE_SENSITIVE',
      unicodePolicy: 'NFC',
      files: [],
      symlinks: [],
      directoryInventory: [],
      completenessEvidenceRefs: new CanonicalSet()
    },
    compiler: {
      packageVersion: '5.9.3',
      distributionDigest: 'd1',
      parserProfileId: 'TS_5_9_3_STRICT',
      semanticProfileId: 'TS_FINITE_CONTRACTS_F0'
    },
    projects: [{
      projectId: 'proj',
      configFileIds: [],
      effectiveOptions: { _opaqueF0Semantics: 'UNRESOLVED', payload: {} } as any,
      optionsDerivationRef: { domain: ArtifactDomain.MANIFEST, digest: 'd1' },
      roots: [{ projectId: 'proj', fileId: 'src/index.ts' }],
      references: [],
      referenceMode: 'SOURCE'
    }],
    packages: [],
    admittedRoots: new CanonicalSet<Vertex>([{ projectId: 'proj', fileId: 'src/index.ts' }]),
    ambientRoots: new CanonicalSet<AmbientRoot>(),
    generatedArtifacts: new CanonicalSet(),
    boundaryPolicyId: 'F0_STRICT_BOUNDARY_V1',
    inputEvidenceRefs: new CanonicalSet(),
    ...manifestOverrides
  };
}

describe('DependencyClosureVerifier - Comprehensive Adversarial & Semantic Suite', () => {

  // 0. Baseline Positive Verification
  it('successfully verifies a sound closure under F0_NODE10_STATIC_V1', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { foo } from './helper';\nfoo();" },
      { path: 'src/helper.ts', content: "export function foo() { return 42; }" }
    ]);

    const extractor = new ASTAnchorExtractor();
    const resolver = new F0RestrictedResolver(fs);
    const producer = new DependencyClosureProducer(fs, extractor, resolver);

    const manifest = createManifest();
    const manifestDigest = hashContract(ArtifactDomain.MANIFEST, SAJIMORA_CERTIFIED_EVIDENCE_V1, manifest);
    const rootVertices = new CanonicalSet<Vertex>([{ projectId: 'proj', fileId: 'src/index.ts' }]);

    const cert = producer.produceClosure(
      { domain: ArtifactDomain.MANIFEST, digest: manifestDigest },
      RootPolicyId.F0_ENV_GIT_SEALED_V1,
      rootVertices,
      { manifest }
    );

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new DependencyClosureVerifier(fs, extractor, resolver, budget, manifest);

    const result = verifier.verify(cert, {
      manifest,
      facts: cert.facts,
      edges: cert.edges,
      discharges: cert.discharges
    });

    assert.strictEqual(result.status, 'VERIFIED');
    if (result.status === 'VERIFIED') {
      assert.strictEqual(result.verifiedClaim, 'CLOSURE_COMPLETED');
      assert.strictEqual(result.replayProfileId, ResolverProfileId.F0_NODE10_STATIC_V1);
      assert.ok(result.bundleDigest.length > 0);
    }
  });

  // 1. Altered anchor / parsedSyntaxDigest mismatch
  it('rejects altered anchor or parsedSyntaxDigest with HASH_MISMATCH', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { foo } from './helper';" },
      { path: 'src/helper.ts', content: "export const foo = 1;" }
    ]);
    const extractor = new ASTAnchorExtractor();
    const resolver = new F0RestrictedResolver(fs);
    const producer = new DependencyClosureProducer(fs, extractor, resolver);
    const manifest = createManifest();
    const manifestDigest = hashContract(ArtifactDomain.MANIFEST, SAJIMORA_CERTIFIED_EVIDENCE_V1, manifest);
    const rootVertices = new CanonicalSet<Vertex>([{ projectId: 'proj', fileId: 'src/index.ts' }]);

    const cert = producer.produceClosure(
      { domain: ArtifactDomain.MANIFEST, digest: manifestDigest },
      RootPolicyId.F0_ENV_GIT_SEALED_V1,
      rootVertices,
      { manifest }
    );

    // Tamper with parsedSyntaxDigest
    const covArr = Array.from(cert.traversalCoverage);
    covArr[0].parsedSyntaxDigest = 'forged_digest_000000000000000000000000000000000000000000000000';
    cert.traversalCoverage = new CanonicalSet(covArr);

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new DependencyClosureVerifier(fs, extractor, resolver, budget, manifest);
    const result = verifier.verify(cert, { manifest, facts: cert.facts });

    assert.strictEqual(result.status, 'REJECTED');
    if (result.status === 'REJECTED') {
      assert.strictEqual(result.blockerCode, BlockerCode.HASH_MISMATCH);
    }
  });

  // 2. Altered UTF-16 span
  it('rejects altered UTF-16 span with EDGE_OMISSION', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { foo } from './helper';" },
      { path: 'src/helper.ts', content: "export const foo = 1;" }
    ]);
    const extractor = new ASTAnchorExtractor();
    const resolver = new F0RestrictedResolver(fs);
    const producer = new DependencyClosureProducer(fs, extractor, resolver);
    const manifest = createManifest();
    const manifestDigest = hashContract(ArtifactDomain.MANIFEST, SAJIMORA_CERTIFIED_EVIDENCE_V1, manifest);
    const rootVertices = new CanonicalSet<Vertex>([{ projectId: 'proj', fileId: 'src/index.ts' }]);

    const cert = producer.produceClosure(
      { domain: ArtifactDomain.MANIFEST, digest: manifestDigest },
      RootPolicyId.F0_ENV_GIT_SEALED_V1,
      rootVertices,
      { manifest }
    );

    // Tamper with anchor ID UTF-16 span
    const covArr = Array.from(cert.traversalCoverage);
    covArr[0].dependencyAnchorIds = ['src/index.ts:999:1000:IMPORT_DECLARATION'];
    // Also recompute digest so it tests the anchor ID equality check
    covArr[0].parsedSyntaxDigest = extractor.computeSyntaxDigest(covArr[0].vertex, extractor.extractAnchors(covArr[0].vertex, fs.readBytes(covArr[0].vertex.fileId)));
    cert.traversalCoverage = new CanonicalSet(covArr);

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new DependencyClosureVerifier(fs, extractor, resolver, budget, manifest);
    const result = verifier.verify(cert, { manifest, facts: cert.facts });

    assert.strictEqual(result.status, 'REJECTED');
    if (result.status === 'REJECTED') {
      assert.strictEqual(result.blockerCode, BlockerCode.EDGE_OMISSION);
    }
  });

  // 3. Altered syntax kind
  it('rejects altered syntax kind with EDGE_OMISSION', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { foo } from './helper';" },
      { path: 'src/helper.ts', content: "export const foo = 1;" }
    ]);
    const extractor = new ASTAnchorExtractor();
    const resolver = new F0RestrictedResolver(fs);
    const producer = new DependencyClosureProducer(fs, extractor, resolver);
    const manifest = createManifest();
    const manifestDigest = hashContract(ArtifactDomain.MANIFEST, SAJIMORA_CERTIFIED_EVIDENCE_V1, manifest);
    const rootVertices = new CanonicalSet<Vertex>([{ projectId: 'proj', fileId: 'src/index.ts' }]);

    const cert = producer.produceClosure(
      { domain: ArtifactDomain.MANIFEST, digest: manifestDigest },
      RootPolicyId.F0_ENV_GIT_SEALED_V1,
      rootVertices,
      { manifest }
    );

    const covArr = Array.from(cert.traversalCoverage);
    covArr[0].dependencyAnchorIds = [covArr[0].dependencyAnchorIds[0].replace('IMPORT_DECLARATION', 'EXPORT_DECLARATION')];
    covArr[0].parsedSyntaxDigest = extractor.computeSyntaxDigest(covArr[0].vertex, extractor.extractAnchors(covArr[0].vertex, fs.readBytes(covArr[0].vertex.fileId)));
    cert.traversalCoverage = new CanonicalSet(covArr);

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new DependencyClosureVerifier(fs, extractor, resolver, budget, manifest);
    const result = verifier.verify(cert, { manifest, facts: cert.facts });

    assert.strictEqual(result.status, 'REJECTED');
    if (result.status === 'REJECTED') {
      assert.strictEqual(result.blockerCode, BlockerCode.EDGE_OMISSION);
    }
  });

  // 4. Omitted anchor
  it('rejects omitted anchor with EDGE_OMISSION', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { a } from './a';\nimport { b } from './b';" },
      { path: 'src/a.ts', content: "export const a = 1;" },
      { path: 'src/b.ts', content: "export const b = 2;" }
    ]);
    const extractor = new ASTAnchorExtractor();
    const resolver = new F0RestrictedResolver(fs);
    const producer = new DependencyClosureProducer(fs, extractor, resolver);
    const manifest = createManifest();
    const manifestDigest = hashContract(ArtifactDomain.MANIFEST, SAJIMORA_CERTIFIED_EVIDENCE_V1, manifest);
    const rootVertices = new CanonicalSet<Vertex>([{ projectId: 'proj', fileId: 'src/index.ts' }]);

    const cert = producer.produceClosure(
      { domain: ArtifactDomain.MANIFEST, digest: manifestDigest },
      RootPolicyId.F0_ENV_GIT_SEALED_V1,
      rootVertices,
      { manifest }
    );

    const covArr = Array.from(cert.traversalCoverage);
    covArr[0].dependencyAnchorIds = [covArr[0].dependencyAnchorIds[0]]; // omit second anchor
    covArr[0].parsedSyntaxDigest = extractor.computeSyntaxDigest(covArr[0].vertex, extractor.extractAnchors(covArr[0].vertex, fs.readBytes(covArr[0].vertex.fileId)));
    cert.traversalCoverage = new CanonicalSet(covArr);

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new DependencyClosureVerifier(fs, extractor, resolver, budget, manifest);
    const result = verifier.verify(cert, { manifest, facts: cert.facts });

    assert.strictEqual(result.status, 'REJECTED');
    if (result.status === 'REJECTED') {
      assert.strictEqual(result.blockerCode, BlockerCode.EDGE_OMISSION);
    }
  });

  // 5. Duplicate anchor
  it('rejects duplicate anchor in certificate with EDGE_OMISSION', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { a } from './a';" },
      { path: 'src/a.ts', content: "export const a = 1;" }
    ]);
    const extractor = new ASTAnchorExtractor();
    const resolver = new F0RestrictedResolver(fs);
    const producer = new DependencyClosureProducer(fs, extractor, resolver);
    const manifest = createManifest();
    const manifestDigest = hashContract(ArtifactDomain.MANIFEST, SAJIMORA_CERTIFIED_EVIDENCE_V1, manifest);
    const rootVertices = new CanonicalSet<Vertex>([{ projectId: 'proj', fileId: 'src/index.ts' }]);

    const cert = producer.produceClosure(
      { domain: ArtifactDomain.MANIFEST, digest: manifestDigest },
      RootPolicyId.F0_ENV_GIT_SEALED_V1,
      rootVertices,
      { manifest }
    );

    const covArr = Array.from(cert.traversalCoverage);
    covArr[0].dependencyAnchorIds.push(covArr[0].dependencyAnchorIds[0]); // duplicate
    covArr[0].parsedSyntaxDigest = extractor.computeSyntaxDigest(covArr[0].vertex, extractor.extractAnchors(covArr[0].vertex, fs.readBytes(covArr[0].vertex.fileId)));
    cert.traversalCoverage = new CanonicalSet(covArr);

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new DependencyClosureVerifier(fs, extractor, resolver, budget, manifest);
    const result = verifier.verify(cert, { manifest, facts: cert.facts });

    assert.strictEqual(result.status, 'REJECTED');
    if (result.status === 'REJECTED') {
      assert.strictEqual(result.blockerCode, BlockerCode.EDGE_OMISSION);
    }
  });

  // 6. Missing ResolutionFact
  it('rejects missing ResolutionFact with MISSING_EVIDENCE', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { a } from './a';" },
      { path: 'src/a.ts', content: "export const a = 1;" }
    ]);
    const extractor = new ASTAnchorExtractor();
    const resolver = new F0RestrictedResolver(fs);
    const producer = new DependencyClosureProducer(fs, extractor, resolver);
    const manifest = createManifest();
    const manifestDigest = hashContract(ArtifactDomain.MANIFEST, SAJIMORA_CERTIFIED_EVIDENCE_V1, manifest);
    const rootVertices = new CanonicalSet<Vertex>([{ projectId: 'proj', fileId: 'src/index.ts' }]);

    const cert = producer.produceClosure(
      { domain: ArtifactDomain.MANIFEST, digest: manifestDigest },
      RootPolicyId.F0_ENV_GIT_SEALED_V1,
      rootVertices,
      { manifest }
    );

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new DependencyClosureVerifier(fs, extractor, resolver, budget, manifest);
    // Provide empty facts list
    const result = verifier.verify(cert, { manifest, facts: [] });

    assert.strictEqual(result.status, 'REJECTED');
    if (result.status === 'REJECTED') {
      assert.strictEqual(result.blockerCode, BlockerCode.MISSING_EVIDENCE);
    }
  });

  // 7. Conflicting ResolutionFact / AmbientRoot discharge
  it('rejects conflicting resolution fact and discharge with AMBIGUOUS_DECLARATION_GROUP', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { a } from './a';" },
      { path: 'src/a.ts', content: "export const a = 1;" },
      { path: 'ambient/a.d.ts', content: "declare module 'a' {}" }
    ]);
    const extractor = new ASTAnchorExtractor();
    const resolver = new F0RestrictedResolver(fs);
    const producer = new DependencyClosureProducer(fs, extractor, resolver);

    const ambientRoot: AmbientRoot = {
      vertex: { projectId: 'proj', fileId: 'ambient/a.d.ts' },
      originKind: 'GLOBAL_SCRIPT',
      rootSelectionEvidenceRef: { domain: ArtifactDomain.MANIFEST, digest: 'd1' }
    };
    const manifest = createManifest({
      ambientRoots: new CanonicalSet<AmbientRoot>([ambientRoot])
    });
    const manifestDigest = hashContract(ArtifactDomain.MANIFEST, SAJIMORA_CERTIFIED_EVIDENCE_V1, manifest);
    const rootVertices = new CanonicalSet<Vertex>([{ projectId: 'proj', fileId: 'src/index.ts' }]);

    const cert = producer.produceClosure(
      { domain: ArtifactDomain.MANIFEST, digest: manifestDigest },
      RootPolicyId.F0_ENV_GIT_SEALED_V1,
      rootVertices,
      { manifest }
    );

    // Provide both fact and discharge for the same anchor
    const anchors = extractor.extractAnchors({ projectId: 'proj', fileId: 'src/index.ts' }, fs.readBytes('src/index.ts'));
    const conflictingDischarge: BoundaryDischarge = {
      anchor: anchors[0],
      targetVertex: ambientRoot.vertex,
      ambientRoot,
      justification: 'Conflicting discharge'
    };

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new DependencyClosureVerifier(fs, extractor, resolver, budget, manifest);
    const result = verifier.verify(cert, {
      manifest,
      facts: cert.facts,
      discharges: [conflictingDischarge]
    });

    assert.strictEqual(result.status, 'REJECTED');
    if (result.status === 'REJECTED') {
      assert.strictEqual(result.blockerCode, BlockerCode.AMBIGUOUS_DECLARATION_GROUP);
    }
  });

  // 8. Wrong resolution target
  it('rejects forged/wrong resolution target with HASH_MISMATCH', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { a } from './a';" },
      { path: 'src/a.ts', content: "export const a = 1;" },
      { path: 'src/wrong.ts', content: "export const wrong = 2;" }
    ]);
    const extractor = new ASTAnchorExtractor();
    const resolver = new F0RestrictedResolver(fs);
    const producer = new DependencyClosureProducer(fs, extractor, resolver);
    const manifest = createManifest();
    const manifestDigest = hashContract(ArtifactDomain.MANIFEST, SAJIMORA_CERTIFIED_EVIDENCE_V1, manifest);
    const rootVertices = new CanonicalSet<Vertex>([{ projectId: 'proj', fileId: 'src/index.ts' }]);

    const cert = producer.produceClosure(
      { domain: ArtifactDomain.MANIFEST, digest: manifestDigest },
      RootPolicyId.F0_ENV_GIT_SEALED_V1,
      rootVertices,
      { manifest }
    );

    // Mutate the fact to claim wrong target
    const facts = cert.facts.map(f => ({
      ...f,
      selectedTargetOrNull: 'src/wrong.ts'
    }));

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new DependencyClosureVerifier(fs, extractor, resolver, budget, manifest);
    const result = verifier.verify(cert, { manifest, facts });

    assert.strictEqual(result.status, 'REJECTED');
    if (result.status === 'REJECTED') {
      assert.strictEqual(result.blockerCode, BlockerCode.HASH_MISMATCH);
    }
  });

  // 9. Malformed package metadata
  it('rejects malformed package.json with UNSUPPORTED_CONFIGURATION', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { pkg } from 'pkg';" },
      { path: 'node_modules/pkg/package.json', content: '{ malformed json: true ' }
    ]);
    const extractor = new ASTAnchorExtractor();
    const resolver = new F0RestrictedResolver(fs);

    const res = resolver.resolve('pkg', 'src/index.ts');
    assert.strictEqual(res.outcome, 'UNSUPPORTED');
    assert.strictEqual(res.blockerCode, BlockerCode.UNSUPPORTED_CONFIGURATION);
  });

  // 10. types -> typings -> main precedence
  it('strictly enforces types -> typings -> main precedence with no fallback', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { a } from 'pkg';" },
      { 
        path: 'node_modules/pkg/package.json', 
        content: JSON.stringify({
          name: 'pkg',
          types: './types.d.ts',
          typings: './typings.d.ts',
          main: './index.js'
        })
      },
      { path: 'node_modules/pkg/types.d.ts', content: 'export const a: number;' },
      { path: 'node_modules/pkg/typings.d.ts', content: 'export const b: number;' },
      { path: 'node_modules/pkg/index.js', content: 'module.exports = {};' }
    ]);

    const resolver = new F0RestrictedResolver(fs);
    const res = resolver.resolve('pkg', 'src/index.ts');
    assert.strictEqual(res.outcome, 'RESOLVED');
    assert.strictEqual(res.selectedTargetOrNull, 'node_modules/pkg/types.d.ts');
  });

  // 11. Selected field no fallback
  it('strictly fails closed without fallback when selected field does not resolve', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { a } from 'pkg';" },
      { 
        path: 'node_modules/pkg/package.json', 
        content: JSON.stringify({
          name: 'pkg',
          types: './nonexistent.d.ts', // selected field fails to resolve!
          typings: './valid.d.ts',
          main: './index.js'
        })
      },
      { path: 'node_modules/pkg/valid.d.ts', content: 'export const a: number;' },
      { path: 'node_modules/pkg/index.js', content: 'module.exports = {};' }
    ]);

    const resolver = new F0RestrictedResolver(fs);
    const res = resolver.resolve('pkg', 'src/index.ts');
    // Must NOT fall back to typings or main!
    assert.strictEqual(res.outcome, 'UNRESOLVED');
    assert.strictEqual(res.selectedTargetOrNull, null);
  });

  // 12. paths / baseUrl reject
  it('rejects paths/baseUrl options with UNSUPPORTED_CONFIGURATION', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { a } from 'alias/a';" }
    ]);
    const resolver = new F0RestrictedResolver(fs);
    const res = resolver.resolve('alias/a', 'src/index.ts', { paths: { 'alias/*': ['src/*'] } });
    assert.strictEqual(res.outcome, 'UNSUPPORTED');
    assert.strictEqual(res.blockerCode, BlockerCode.UNSUPPORTED_CONFIGURATION);
  });

  // 13. Conditional exports reject
  it('rejects conditional exports in package.json with UNSUPPORTED_CONFIGURATION', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { a } from 'pkg';" },
      {
        path: 'node_modules/pkg/package.json',
        content: JSON.stringify({
          name: 'pkg',
          exports: { '.': './index.js' }
        })
      }
    ]);
    const resolver = new F0RestrictedResolver(fs);
    const res = resolver.resolve('pkg', 'src/index.ts');
    assert.strictEqual(res.outcome, 'UNSUPPORTED');
    assert.strictEqual(res.blockerCode, BlockerCode.UNSUPPORTED_CONFIGURATION);
  });

  // 14. typesVersions reject
  it('rejects typesVersions in package.json with UNSUPPORTED_CONFIGURATION', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { a } from 'pkg';" },
      {
        path: 'node_modules/pkg/package.json',
        content: JSON.stringify({
          name: 'pkg',
          typesVersions: { '>=4.0': { '*': ['ts4.0/*'] } }
        })
      }
    ]);
    const resolver = new F0RestrictedResolver(fs);
    const res = resolver.resolve('pkg', 'src/index.ts');
    assert.strictEqual(res.outcome, 'UNSUPPORTED');
    assert.strictEqual(res.blockerCode, BlockerCode.UNSUPPORTED_CONFIGURATION);
  });

  // 15. Missing AmbientRoot
  it('rejects unmanifested triple-slash type reference with UNJUSTIFIED_BOUNDARY_EXCLUSION', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "/// <reference types=\"node\" />\nexport const x = 1;" }
    ]);
    const extractor = new ASTAnchorExtractor();
    const resolver = new F0RestrictedResolver(fs);
    const producer = new DependencyClosureProducer(fs, extractor, resolver);
    const manifest = createManifest(); // empty ambient roots!
    const manifestDigest = hashContract(ArtifactDomain.MANIFEST, SAJIMORA_CERTIFIED_EVIDENCE_V1, manifest);
    const rootVertices = new CanonicalSet<Vertex>([{ projectId: 'proj', fileId: 'src/index.ts' }]);

    const cert = producer.produceClosure(
      { domain: ArtifactDomain.MANIFEST, digest: manifestDigest },
      RootPolicyId.F0_ENV_GIT_SEALED_V1,
      rootVertices,
      { manifest }
    );

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new DependencyClosureVerifier(fs, extractor, resolver, budget, manifest);
    const result = verifier.verify(cert, { manifest, facts: cert.facts, discharges: cert.discharges });

    assert.strictEqual(result.status, 'REJECTED');
    if (result.status === 'REJECTED') {
      assert.strictEqual(result.blockerCode, BlockerCode.UNJUSTIFIED_BOUNDARY_EXCLUSION);
    }
  });

  // 16. Forged AmbientRoot
  it('rejects forged AmbientRoot discharge with UNJUSTIFIED_BOUNDARY_EXCLUSION', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "/// <reference types=\"node\" />\nexport const x = 1;" },
      { path: 'node.d.ts', content: "declare module 'node' {}" }
    ]);
    const extractor = new ASTAnchorExtractor();
    const resolver = new F0RestrictedResolver(fs);
    const producer = new DependencyClosureProducer(fs, extractor, resolver);

    const manifest = createManifest(); // manifest does NOT have ambient root!
    const manifestDigest = hashContract(ArtifactDomain.MANIFEST, SAJIMORA_CERTIFIED_EVIDENCE_V1, manifest);
    const rootVertices = new CanonicalSet<Vertex>([{ projectId: 'proj', fileId: 'src/index.ts' }]);

    const cert = producer.produceClosure(
      { domain: ArtifactDomain.MANIFEST, digest: manifestDigest },
      RootPolicyId.F0_ENV_GIT_SEALED_V1,
      rootVertices,
      { manifest }
    );

    const anchors = extractor.extractAnchors({ projectId: 'proj', fileId: 'src/index.ts' }, fs.readBytes('src/index.ts'));
    const forgedDischarge: BoundaryDischarge = {
      anchor: anchors[0],
      targetVertex: { projectId: 'proj', fileId: 'node.d.ts' },
      ambientRoot: {
        vertex: { projectId: 'proj', fileId: 'node.d.ts' },
        originKind: 'GLOBAL_SCRIPT',
        rootSelectionEvidenceRef: { domain: ArtifactDomain.MANIFEST, digest: 'fake_digest' }
      },
      justification: 'Forged ambient root'
    };

    // Add target to reached vertices so it tests ambient root verification
    cert.reachedVertices.add({ projectId: 'proj', fileId: 'node.d.ts' });
    cert.traversalCoverage.add({
      vertex: { projectId: 'proj', fileId: 'node.d.ts' },
      parsedSyntaxDigest: extractor.computeSyntaxDigest({ projectId: 'proj', fileId: 'node.d.ts' }, []),
      dependencyAnchorIds: []
    });

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new DependencyClosureVerifier(fs, extractor, resolver, budget, manifest);
    const result = verifier.verify(cert, { manifest, facts: cert.facts, discharges: [forgedDischarge] });

    assert.strictEqual(result.status, 'REJECTED');
    if (result.status === 'REJECTED') {
      assert.strictEqual(result.blockerCode, BlockerCode.UNJUSTIFIED_BOUNDARY_EXCLUSION);
    }
  });

  // 17. Wrong AmbientRoot target
  it('rejects wrong AmbientRoot target vertex with UNJUSTIFIED_BOUNDARY_EXCLUSION', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "/// <reference types=\"node\" />\nexport const x = 1;" },
      { path: 'node.d.ts', content: "declare module 'node' {}" },
      { path: 'wrong.d.ts', content: "declare module 'wrong' {}" }
    ]);
    const extractor = new ASTAnchorExtractor();
    const resolver = new F0RestrictedResolver(fs);

    const realAmbientRoot: AmbientRoot = {
      vertex: { projectId: 'proj', fileId: 'node.d.ts' },
      originKind: 'GLOBAL_SCRIPT',
      rootSelectionEvidenceRef: { domain: ArtifactDomain.MANIFEST, digest: 'd1' }
    };
    const manifest = createManifest({
      ambientRoots: new CanonicalSet<AmbientRoot>([realAmbientRoot])
    });
    const manifestDigest = hashContract(ArtifactDomain.MANIFEST, SAJIMORA_CERTIFIED_EVIDENCE_V1, manifest);

    const producer = new DependencyClosureProducer(fs, extractor, resolver);
    const rootVertices = new CanonicalSet<Vertex>([{ projectId: 'proj', fileId: 'src/index.ts' }]);
    const cert = producer.produceClosure(
      { domain: ArtifactDomain.MANIFEST, digest: manifestDigest },
      RootPolicyId.F0_ENV_GIT_SEALED_V1,
      rootVertices,
      { manifest }
    );

    const anchors = extractor.extractAnchors({ projectId: 'proj', fileId: 'src/index.ts' }, fs.readBytes('src/index.ts'));
    // Mismatch targetVertex and ambientRoot.vertex
    const mismatchedDischarge: BoundaryDischarge = {
      anchor: anchors[0],
      targetVertex: { projectId: 'proj', fileId: 'wrong.d.ts' }, // target does not match ambientRoot!
      ambientRoot: realAmbientRoot,
      justification: 'Mismatched target'
    };

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new DependencyClosureVerifier(fs, extractor, resolver, budget, manifest);
    const result = verifier.verify(cert, { manifest, facts: cert.facts, discharges: [mismatchedDischarge] });

    assert.strictEqual(result.status, 'REJECTED');
    if (result.status === 'REJECTED') {
      assert.strictEqual(result.blockerCode, BlockerCode.UNJUSTIFIED_BOUNDARY_EXCLUSION);
    }
  });

  // 18. Unsupported syntax (computed dynamic import)
  it('rejects dynamic import syntax with UNSUPPORTED_SYNTAX', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "const mod = import(dynamicPath);" }
    ]);
    const extractor = new ASTAnchorExtractor();
    const resolver = new F0RestrictedResolver(fs);
    const manifest = createManifest();
    const manifestDigest = hashContract(ArtifactDomain.MANIFEST, SAJIMORA_CERTIFIED_EVIDENCE_V1, manifest);

    const anchors = extractor.extractAnchors({ projectId: 'proj', fileId: 'src/index.ts' }, fs.readBytes('src/index.ts'));
    assert.strictEqual(anchors[0].syntaxKind, 'UNSUPPORTED_SYNTAX');

    const cert: DependencyClosureCertificate = {
      schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
      environmentRef: { domain: ArtifactDomain.MANIFEST, digest: manifestDigest },
      rootPolicyId: RootPolicyId.F0_ENV_GIT_SEALED_V1,
      rootVertices: new CanonicalSet<Vertex>([{ projectId: 'proj', fileId: 'src/index.ts' }]),
      reachedVertices: new CanonicalSet<Vertex>([{ projectId: 'proj', fileId: 'src/index.ts' }]),
      dependencyEdgeRefs: new CanonicalSet(),
      resolutionFactRefs: new CanonicalSet(),
      augmentationFactRefs: new CanonicalSet(),
      declarationGroups: new CanonicalSet(),
      traversalCoverage: new CanonicalSet([{
        vertex: { projectId: 'proj', fileId: 'src/index.ts' },
        parsedSyntaxDigest: extractor.computeSyntaxDigest({ projectId: 'proj', fileId: 'src/index.ts' }, anchors),
        dependencyAnchorIds: anchors.map(a => extractor.canonicalAnchorId(a))
      }]),
      boundaryDischarges: new CanonicalSet(),
      ruleSetId: 'F0_RULES_V1'
    };

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new DependencyClosureVerifier(fs, extractor, resolver, budget, manifest);
    const result = verifier.verify(cert, { manifest });

    assert.strictEqual(result.status, 'REJECTED');
    if (result.status === 'REJECTED') {
      assert.strictEqual(result.blockerCode, BlockerCode.UNSUPPORTED_SYNTAX);
    }
  });
});
