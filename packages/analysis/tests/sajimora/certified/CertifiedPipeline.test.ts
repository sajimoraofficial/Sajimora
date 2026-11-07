import { test } from 'node:test';
import * as assert from 'node:assert';
import { CertifiedEvaluationOrchestrator, CertifiedExecutionInput } from '../../../src/sajimora/certified/integration/CertifiedEvaluationOrchestrator';
import { HistoricalObligationGenerator } from '../../../src/sajimora/certified/obligations/HistoricalObligationGenerator';
import { ProofProducer } from '../../../src/sajimora/certified/proof/ProofProducer';
import { CoverageProducer } from '../../../src/sajimora/certified/coverage/CoverageProducer';
import { DependencyClosureProducer } from '../../../src/sajimora/certified/closure/DependencyClosureProducer';
import { ASTAnchorExtractor } from '../../../src/sajimora/certified/closure/ASTExtractor';
import { F0RestrictedResolver } from '../../../src/sajimora/certified/closure/F0RestrictedResolver';
import { FragmentAdmissionProducer } from '../../../src/sajimora/certified/fragment/FragmentAdmissionProducer';
import { SealedFilesystem } from '../../../src/sajimora/certified/environment/SealedFilesystem';
import { VerificationBudget } from '../../../src/sajimora/certified/proof/VerificationBudget';
import {
  INITIAL_RESOURCE_PROFILE,
  ArtifactDomain,
  SAJIMORA_CERTIFIED_EVIDENCE_V1,
  RootPolicyId,
  BoundaryPolicyId,
  ParserProfileId,
  SemanticProfileId,
  RuleSetId,
  NormalizationProfileId
} from '../../../../core/src/sajimora/certified/protocol';
import { BlockerCode, ArtifactRef } from '../../../../core/src/sajimora/certified/blockers';
import {
  EnvironmentManifest,
  FileEntry,
  Vertex,
  Phase5EvidenceBundle
} from '../../../../core/src/sajimora/certified/contracts';
import {
  CanonicalSet,
  computeDomainSeparatedHash,
  hashContract
} from '../../../../core/src/sajimora/certified/canonicalEncoding';
import { CrossVersionIdentityBundle } from '../../../../core/src/sajimora/types/identity';
import { ObligationVerifier } from '../../../src/sajimora/certified/obligations/ObligationVerifier';
import { ProofChecker } from '../../../src/sajimora/certified/proof/ProofChecker';
import { CoverageVerifier } from '../../../src/sajimora/certified/coverage/CoverageVerifier';
import { CertifiedEvidenceNormalizer } from '../../../src/sajimora/certified/integration/CertifiedEvidenceNormalizer';

function createManifestAndSealedFs(files: { path: string; content: string }[], revisionSha: string = 'rev1'): {
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
    revision: { commitId: revisionSha, treeId: 't1', parentSelection: 'p1' },
    environmentBasis: 'RECORDED_BUILD',
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
        effectiveOptions: {} as any,
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

function buildPipelineFixtures(options: {
  parentProviderCode: string;
  candidateProviderCode: string;
  consumerCode: string;
  targetSymbol: string;
  isCompatible: boolean;
  isCaseB?: boolean;
}) {
  const parentFiles = [
    { path: 'provider.ts', content: options.parentProviderCode },
    { path: 'consumer.ts', content: options.consumerCode }
  ];

  const candFiles = [
    { path: 'provider.ts', content: options.candidateProviderCode },
    { path: 'consumer.ts', content: options.consumerCode }
  ];

  const { manifest: pManifest, sealedFs: pFs } = createManifestAndSealedFs(parentFiles, 'parentSha');
  const { manifest: cManifest, sealedFs: cFs } = createManifestAndSealedFs(candFiles, 'candidateSha');

  const pEnvRef: ArtifactRef = {
    domain: ArtifactDomain.MANIFEST,
    digest: hashContract(ArtifactDomain.MANIFEST, pManifest.schemaVersion, pManifest)
  };
  const cEnvRef: ArtifactRef = {
    domain: ArtifactDomain.MANIFEST,
    digest: hashContract(ArtifactDomain.MANIFEST, cManifest.schemaVersion, cManifest)
  };

  const pRoots = parentFiles.map(f => ({ projectId: 'p0', fileId: f.path }));
  const cRoots = candFiles.map(f => ({ projectId: 'p0', fileId: f.path }));

  const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
  const pExtractor = new ASTAnchorExtractor();
  const pResolver = new F0RestrictedResolver(pFs, budget);
  const pClosureProducer = new DependencyClosureProducer(pFs, pExtractor, pResolver);
  const pClosure = pClosureProducer.produceClosure(pEnvRef, RootPolicyId.F0_ENV_GIT_SEALED_V1, new CanonicalSet<Vertex>(pRoots));

  const cExtractor = new ASTAnchorExtractor();
  const cResolver = new F0RestrictedResolver(cFs, budget);
  const cClosureProducer = new DependencyClosureProducer(cFs, cExtractor, cResolver);
  const cClosure = cClosureProducer.produceClosure(cEnvRef, RootPolicyId.F0_ENV_GIT_SEALED_V1, new CanonicalSet<Vertex>(cRoots));

  const pClosureRef: ArtifactRef = {
    domain: ArtifactDomain.CLOSURE,
    digest: hashContract(ArtifactDomain.CLOSURE, pClosure.schemaVersion, pClosure)
  };
  const cClosureRef: ArtifactRef = {
    domain: ArtifactDomain.CLOSURE,
    digest: hashContract(ArtifactDomain.CLOSURE, cClosure.schemaVersion, cClosure)
  };

  const pAdmissionProducer = new FragmentAdmissionProducer(pFs);
  const pAdmission = pAdmissionProducer.produceAdmission(pEnvRef, pClosureRef, pRoots);

  const cAdmissionProducer = new FragmentAdmissionProducer(cFs);
  const cAdmission = cAdmissionProducer.produceAdmission(cEnvRef, cClosureRef, cRoots);

  const pAdmissionRef: ArtifactRef = {
    domain: ArtifactDomain.ADMISSION,
    digest: hashContract(ArtifactDomain.ADMISSION, pAdmission.schemaVersion, pAdmission)
  };
  const cAdmissionRef: ArtifactRef = {
    domain: ArtifactDomain.ADMISSION,
    digest: hashContract(ArtifactDomain.ADMISSION, cAdmission.schemaVersion, cAdmission)
  };

  const targetIdRef: ArtifactRef = { domain: ArtifactDomain.SOURCE_BYTES, digest: '1'.repeat(64) };
  const lifecycleRef: ArtifactRef = targetIdRef;

  const makeSym = (file: string, name: string) => ({
    identityId: name,
    projectId: 'p0',
    moduleIdentity: file,
    ownerChain: [],
    localName: name,
    declarationKind: 'FunctionDeclaration',
    declarationOrdinal: 0,
    sourceSpan: { start: 0, end: 10, line: 1, column: 1, endLine: 1, endColumn: 11 },
    exportPaths: [file],
    parameterShape: '()',
    astFingerprint: 'fp123'
  });

  // Identity bundle
  const identityBundle: CrossVersionIdentityBundle = {
    targetMappings: [
      {
        parent: makeSym('provider.ts', options.targetSymbol),
        candidate: makeSym('provider.ts', options.targetSymbol),
        status: options.isCaseB ? 'SAME_DECLARATION' : (options.parentProviderCode === options.candidateProviderCode ? 'SAME_DECLARATION' : 'UNRESOLVED'),
        evidence: [],
        plausibleCandidateIds: [options.targetSymbol]
      }
    ],
    consumerMappings: [],
    status: 'COMPLETE',
    blockers: [],
    phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' },
    boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 }
  };

  const { obligations } = HistoricalObligationGenerator.generateObligations(
    pManifest,
    cManifest,
    pFs,
    cFs,
    options.targetSymbol,
    targetIdRef,
    lifecycleRef
  );

  const proofs = obligations.map(obl =>
    ProofProducer.produceProof(obl, {
      sourceScalar: { kind: 'literal', value: 'valid' },
      targetScalar: options.isCompatible
        ? { kind: 'primitive', name: 'string' }
        : { kind: 'primitive', name: 'number' } // Incompatible!
    })
  );

  const coverage = CoverageProducer.produceCoverage(
    pManifest,
    cManifest,
    pFs,
    options.targetSymbol,
    targetIdRef,
    new CanonicalSet<ArtifactRef>([pAdmissionRef]),
    obligations
  );

  const covRef: ArtifactRef = {
    domain: ArtifactDomain.COVERAGE,
    digest: hashContract(ArtifactDomain.COVERAGE, coverage.schemaVersion, coverage)
  };

  const oblRefs = obligations.map(o => ({
    domain: ArtifactDomain.OBLIGATION,
    digest: hashContract(ArtifactDomain.OBLIGATION, o.schemaVersion, o)
  }));
  const proofRefs = proofs.map(p => ({
    domain: ArtifactDomain.PROOF,
    digest: hashContract(ArtifactDomain.PROOF, p.schemaVersion, p)
  }));

  const bundle: Phase5EvidenceBundle = {
    schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
    claimKind: 'HISTORICAL_TYPED_CONTRACT_PRESERVATION',
    repositoryId: 'repo-test',
    parentEnvironmentRef: pEnvRef,
    candidateEnvironmentRef: cEnvRef,
    obligationRequestRef: targetIdRef,
    identityEvidenceRef: targetIdRef,
    dependencyClosureRefs: new CanonicalSet<ArtifactRef>([pClosureRef, cClosureRef]),
    fragmentAdmissionRefs: new CanonicalSet<ArtifactRef>([pAdmissionRef, cAdmissionRef]),
    semanticObligationRefs: new CanonicalSet<ArtifactRef>(oblRefs),
    semanticProofRefs: new CanonicalSet<ArtifactRef>(proofRefs),
    coverageRef: covRef,
    normalizationProfileId: NormalizationProfileId.F0_NORMALIZATION_V1,
    ruleSetId: RuleSetId.F0_RULES_V1,
    resourceProfileId: 'INITIAL'
  };

  return {
    input: {
      parentManifest: pManifest,
      candidateManifest: cManifest,
      parentClosure: pClosure,
      candidateClosure: cClosure,
      parentClosureFacts: pClosure.facts,
      candidateClosureFacts: cClosure.facts,
      parentAdmission: pAdmission,
      candidateAdmission: cAdmission,
      identityBundle,
      targetSymbolId: options.targetSymbol,
      invariantId: 'INV_F0',
      obligations,
      proofs,
      coverage,
      bundle,
      parentSealedFs: pFs,
      candidateSealedFs: cFs,
      budget: new VerificationBudget(INITIAL_RESOURCE_PROFILE)
    }
  };
}

test('CertifiedEvaluationOrchestrator End-to-End Pipeline Suite', async (t) => {
  await t.test('Case 1: returns PRESERVED on fully sound compatible evidence', () => {
    const code = `export function greet(name: string): string { return name; }`;
    const consumer = `
      import { greet } from './provider';
      export const res: string = greet("world");
    `;

    // Candidate is unchanged (Case-A: identical provider bytes -> identical files -> PROVEN SAME_DECLARATION)
    const { input } = buildPipelineFixtures({
      parentProviderCode: code,
      candidateProviderCode: code,
      consumerCode: consumer,
      targetSymbol: 'greet',
      isCompatible: true
    });

    const result = CertifiedEvaluationOrchestrator.evaluate(input);
    if (result.verdictResult.verdict !== 'PRESERVED') {
      console.log('DEBUG Case 1 failedGate:', result.failedGate, 'detail:', result.detailMessage, 'blocker:', result.blockerCode);
    }
    assert.strictEqual(result.verdictResult.verdict, 'PRESERVED');
    assert.ok(result.passedGates.includes('VERDICT_AUTHORITY'));
  });

  await t.test('Case 2: caller-supplied incompatible terms cannot fabricate VIOLATED', () => {
    const code = `export function greet(name: string): string { return "hello"; }`;
    const consumer = `
      import { greet } from './provider';
      export const res: string = greet("world");
    `;

    const { input } = buildPipelineFixtures({
      parentProviderCode: code,
      candidateProviderCode: code,
      consumerCode: consumer,
      targetSymbol: 'greet',
      isCompatible: false // Incompatible proof!
    });

    const result = CertifiedEvaluationOrchestrator.evaluate(input);
    assert.strictEqual(result.verdictResult.verdict, 'PRESERVED');
    assert.ok(result.passedGates.includes('VERDICT_AUTHORITY'));
  });

  await t.test('Case 3: returns NOT_APPLICABLE on verified empty closure domain (0 consumers)', () => {
    const code = `export function unused(): string { return "hello"; }`;
    const consumer = `export const other: number = 42;`; // Does not use unused()

    const { input } = buildPipelineFixtures({
      parentProviderCode: code,
      candidateProviderCode: code,
      consumerCode: consumer,
      targetSymbol: 'unused',
      isCompatible: true
    });

    const result = CertifiedEvaluationOrchestrator.evaluate(input);
    assert.strictEqual(result.verdictResult.verdict, 'NOT_APPLICABLE');
    assert.ok(result.passedGates.includes('VERDICT_AUTHORITY'));
  });

  await t.test('Case 4: fails closed with UNKNOWN (UNCERTAIN_IDENTITY) when Case-B modified file escalates', () => {
    const parentCode = `export function calc(x: string): string { return x; }`;
    const candidateCode = `export function calc(x: string): string { return "different"; }`; // Modified file!
    const consumer = `
      import { calc } from './provider';
      export const val: string = calc("test");
    `;

    const { input } = buildPipelineFixtures({
      parentProviderCode: parentCode,
      candidateProviderCode: candidateCode,
      consumerCode: consumer,
      targetSymbol: 'calc',
      isCompatible: true,
      isCaseB: true // Modified file claimed SAME_DECLARATION
    });

    const result = CertifiedEvaluationOrchestrator.evaluate(input);
    assert.strictEqual(result.verdictResult.verdict, 'UNKNOWN');
    assert.strictEqual(result.failedGate, 'IDENTITY');
    assert.strictEqual(result.blockerCode, BlockerCode.IDENTITY_MISMATCH);
  });

  await t.test('Case 5: fails closed with UNKNOWN (HASH_MISMATCH) on tampered bundle ref', () => {
    const code = `export function greet(name: string): string { return "hello"; }`;
    const consumer = `
      import { greet } from './provider';
      export const res: string = greet("world");
    `;

    const { input } = buildPipelineFixtures({
      parentProviderCode: code,
      candidateProviderCode: code,
      consumerCode: consumer,
      targetSymbol: 'greet',
      isCompatible: true
    });

    // Tamper parentEnvironmentRef in bundle
    const tamperedInput = {
      ...input,
      bundle: {
        ...input.bundle,
        parentEnvironmentRef: {
          domain: ArtifactDomain.MANIFEST,
          digest: 'f'.repeat(64)
        }
      }
    };

    const result = CertifiedEvaluationOrchestrator.evaluate(tamperedInput);
    assert.strictEqual(result.verdictResult.verdict, 'UNKNOWN');
    assert.strictEqual(result.failedGate, 'BUNDLE_INTEGRITY');
    assert.strictEqual(result.blockerCode, BlockerCode.HASH_MISMATCH);
  });

  await t.test('literal require and import expressions are closure edges, while later admission remains fail-closed', () => {
    const code = `export function greet(name: string): string { return name; }`;
    const consumer = `
      const required = require('./provider');
      void import('./provider');
      export const res: string = required.greet('world');
    `;

    const { input } = buildPipelineFixtures({
      parentProviderCode: code,
      candidateProviderCode: code,
      consumerCode: consumer,
      targetSymbol: 'greet',
      isCompatible: true
    });

    const result = CertifiedEvaluationOrchestrator.evaluate(input);
    assert.ok(result.passedGates.includes('DEPENDENCY_CLOSURE'));
    assert.strictEqual(result.failedGate, 'SEMANTIC_SCOPE');
    assert.strictEqual(result.verdictResult.verdict, 'UNKNOWN');
  });

  await t.test('computed require and dynamic import stay unsupported', () => {
    const extractor = new ASTAnchorExtractor();
    const anchors = extractor.extractAnchors(
      { projectId: 'p0', fileId: 'consumer.ts' },
      Buffer.from(`const name = './provider'; require(name); import(name);`, 'utf8')
    );

    assert.strictEqual(anchors.length, 2);
    assert.ok(anchors.every(anchor => anchor.syntaxKind === 'UNSUPPORTED_SYNTAX'));
  });
});

test('diagnostic: controlled Case B gate isolation', () => {
  const parent = 'export function calc(): number { return 1; }';
  const candidate = 'export function calc(): number { return 2; }';
  const consumer = "import { calc } from './provider'; export const result: number = calc();";
  const { input } = buildPipelineFixtures({
    parentProviderCode: parent, candidateProviderCode: candidate,
    consumerCode: consumer, targetSymbol: 'calc', isCompatible: true
  });
  const trace: Record<string, unknown> = {};
  const providerOnly = new DependencyClosureProducer(
    input.parentSealedFs, new ASTAnchorExtractor(), new F0RestrictedResolver(input.parentSealedFs)
  ).produceClosure(input.bundle.parentEnvironmentRef, RootPolicyId.F0_ENV_GIT_SEALED_V1,
    new CanonicalSet<Vertex>([{ projectId: 'p0', fileId: 'provider.ts' }]));
  trace.providerOnlyReached = Array.from(providerOnly.reachedVertices).map(v => v.fileId);
  trace.explicitReached = Array.from(input.parentClosure.reachedVertices).map(v => v.fileId);
  trace.parentEdges = input.parentClosure.edges.map(e => ({ kind: e.edgeKind, from: e.from.fileId,
    targets: e.targetVertices.map(v => v.fileId) }));
  trace.obligations = input.obligations.map(o => ({ file: o.historicalOccurrenceAnchor.fileId, kind: o.contextKind,
    relations: Array.from(o.requiredRelations).map(r => r.kind) }));
  trace.coverage = { actual: Array.from(input.coverage.actualOccurrenceRefs).length,
    dispositions: Array.from(input.coverage.contextDispositionLedger).map(x => x.disposition) };

  const ordinary = CertifiedEvaluationOrchestrator.evaluate(input);
  trace.normal = { passed: ordinary.passedGates, failed: ordinary.failedGate,
    blocker: ordinary.blockerCode, verdict: ordinary.verdictResult.verdict };
  input.identityBundle.targetMappings[0].status = 'SAME_DECLARATION';
  const assertedKnown = CertifiedEvaluationOrchestrator.evaluate(input);
  trace.assertedKnown = { passed: assertedKnown.passedGates, failed: assertedKnown.failedGate,
    blocker: assertedKnown.blockerCode, verdict: assertedKnown.verdictResult.verdict };

  const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
  const lifecycleRef = input.obligations[0]?.lifecycleEvidenceRef ?? input.bundle.identityEvidenceRef;
  const obl = ObligationVerifier.verify(input.parentManifest, input.candidateManifest,
    input.parentSealedFs, input.candidateSealedFs, 'calc', input.bundle.identityEvidenceRef,
    lifecycleRef, input.obligations, budget);
  trace.obligationVerification = { valid: obl.valid, blocker: obl.blockerCode, detail: obl.detail?.message };
  const proofChecks = input.obligations.map((o, i) => ProofChecker.verify(o, input.proofs[i], budget));
  trace.proofChecks = proofChecks.map(p => ({ valid: p.valid, blocker: p.blockerCode, detail: p.detail?.message }));
  const numericProofs = input.obligations.map(o => ProofProducer.produceProof(o, {
    sourceScalar: { kind: 'primitive', name: 'number' },
    targetScalar: { kind: 'primitive', name: 'number' }, isArityOk: true
  }));
  trace.numericProofChecks = numericProofs.map((p, i) => ProofChecker.verify(input.obligations[i], p, budget).valid);
  trace.proofArityNodes = numericProofs.flatMap(p => Array.from(p.nodes)
    .filter(n => n.ruleId === 'F0.OBL.ARITY').map(n => n.conclusion));
  const cov = CoverageVerifier.verify(input.parentManifest, input.candidateManifest,
    input.parentSealedFs, 'calc', input.obligations, input.coverage, budget);
  trace.coverageVerification = { valid: cov.valid, blocker: cov.blockerCode, detail: cov.detail?.message };
  trace.directNormalizationRejected = true;
  assert.throws(() => CertifiedEvidenceNormalizer.normalize(input.bundle, 'calc', 'INV_F0',
    input.obligations, input.proofs, input.coverage, undefined as any));
  console.log('CASE_B_GATE_ISOLATION', JSON.stringify(trace));
  assert.equal(ordinary.failedGate, 'IDENTITY');
  assert.equal(assertedKnown.failedGate, 'IDENTITY');
  assert.equal(input.obligations.length, 0, 'Unverified Case-B correspondence cannot materialize semantic obligations');
  assert.deepEqual(trace.providerOnlyReached, ['provider.ts']);
  assert.equal(obl.valid, true);
  assert.equal(cov.valid, false, 'An empty producer ledger cannot hide a historical consumer');
  assert.equal(cov.blockerCode, BlockerCode.MISSING_EVIDENCE);
  assert.equal(proofChecks.length, 0);
});
