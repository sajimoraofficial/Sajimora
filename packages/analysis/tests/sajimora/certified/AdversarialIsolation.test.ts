import { test } from 'node:test';
import * as assert from 'node:assert';
import {
  CertifiedEvaluationOrchestrator,
  CertifiedExecutionInput
} from '../../../src/sajimora/certified/integration/CertifiedEvaluationOrchestrator';
import { CertifiedEvidenceNormalizer } from '../../../src/sajimora/certified/integration/CertifiedEvidenceNormalizer';
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
  Phase5EvidenceBundle,
  SemanticObligation,
  SemanticProof
} from '../../../../core/src/sajimora/certified/contracts';
import {
  CanonicalSet,
  computeDomainSeparatedHash,
  hashContract
} from '../../../../core/src/sajimora/certified/canonicalEncoding';
import { CrossVersionIdentityBundle } from '../../../../core/src/sajimora/types/identity';
import { VerdictAuthority } from '../../../../core/src/sajimora/authority/VerdictAuthority';

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

function buildTwoSiteFixtures(options: {
  isCompatibleA: boolean;
  isCompatibleB: boolean;
}) {
  const providerCode = `export function compute(x: string): string { return x; }`;
  const consumerCode = `
    import { compute } from './provider';
    export const callA: string = compute("first");
    export const callB: string = compute("second");
  `;

  const files = [
    { path: 'provider.ts', content: providerCode },
    { path: 'consumer.ts', content: consumerCode }
  ];

  const { manifest: pManifest, sealedFs: pFs } = createManifestAndSealedFs(files, 'pSha');
  const { manifest: cManifest, sealedFs: cFs } = createManifestAndSealedFs(files, 'cSha');

  const pEnvRef: ArtifactRef = {
    domain: ArtifactDomain.MANIFEST,
    digest: hashContract(ArtifactDomain.MANIFEST, pManifest.schemaVersion, pManifest)
  };
  const cEnvRef: ArtifactRef = {
    domain: ArtifactDomain.MANIFEST,
    digest: hashContract(ArtifactDomain.MANIFEST, cManifest.schemaVersion, cManifest)
  };

  const pRoots = files.map(f => ({ projectId: 'p0', fileId: f.path }));
  const cRoots = files.map(f => ({ projectId: 'p0', fileId: f.path }));

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

  const targetIdRef: ArtifactRef = {
    domain: ArtifactDomain.SOURCE_BYTES,
    digest: computeDomainSeparatedHash(
      ArtifactDomain.SOURCE_BYTES,
      SAJIMORA_CERTIFIED_EVIDENCE_V1,
      Buffer.from('target:compute', 'utf8')
    )
  };

  const lifecycleRef: ArtifactRef = targetIdRef;

  const makeSym = (file: string, name: string) => ({
    identityId: name,
    symbolId: `p0:${file}:${name}`,
    canonicalSpan: { start: 0, end: 10, line: 1, column: 1, endLine: 1, endColumn: 11 },
    escapedName: name,
    flags: 0,
    kind: 'FunctionDeclaration',
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

  const identityBundle: CrossVersionIdentityBundle = {
    targetMappings: [
      {
        parent: makeSym('provider.ts', 'compute'),
        candidate: makeSym('provider.ts', 'compute'),
        status: 'SAME_DECLARATION',
        evidence: [],
        plausibleCandidateIds: ['compute']
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
    'compute',
    targetIdRef,
    lifecycleRef
  );

  // obligations[0] corresponds to callA, obligations[1] corresponds to callB
  assert.strictEqual(obligations.length, 2, 'Expected 2 call site obligations');

  const proofA = ProofProducer.produceProof(obligations[0], {
    sourceScalar: { kind: 'literal', value: 'callA' },
    targetScalar: options.isCompatibleA
      ? { kind: 'primitive', name: 'string' }
      : { kind: 'primitive', name: 'number' }
  });

  const proofB = ProofProducer.produceProof(obligations[1], {
    sourceScalar: { kind: 'literal', value: 'callB' },
    targetScalar: options.isCompatibleB
      ? { kind: 'primitive', name: 'string' }
      : { kind: 'primitive', name: 'number' }
  });

  const coverage = CoverageProducer.produceCoverage(
    pManifest,
    cManifest,
    pFs,
    'compute',
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
  const proofRefs = [proofA, proofB].map(p => ({
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

  const input: CertifiedExecutionInput = {
    parentManifest: pManifest,
    candidateManifest: cManifest,
    parentClosure: pClosure,
    candidateClosure: cClosure,
    parentClosureFacts: pClosure.facts,
    candidateClosureFacts: cClosure.facts,
    parentAdmission: pAdmission,
    candidateAdmission: cAdmission,
    identityBundle,
    targetSymbolId: 'compute',
    invariantId: 'INV_F0',
    obligations,
    proofs: [proofA, proofB],
    coverage,
    bundle,
    parentSealedFs: pFs,
    candidateSealedFs: cFs,
    budget: new VerificationBudget(INITIAL_RESOURCE_PROFILE)
  };

  return { input, obligations, proofA, proofB, coverage, bundle };
}

test('Adversarial Proof Isolation Suite (Probes A-E)', async (t) => {
  const verifiedFixtureFacts = { identityProven: true, parentClosureVerified: true,
    candidateClosureVerified: true, parentAdmissionVerified: true, candidateAdmissionVerified: true,
    coverageVerified: true, unchangedConsumerFiles: new Set(['consumer.ts']) } as const;
  await t.test('Probe A: Obligation A + Proof A + unrelated valid Proof B in normalizer -> identical result to A + Proof A', () => {
    const { obligations, proofA, proofB, coverage, bundle } = buildTwoSiteFixtures({
      isCompatibleA: true,
      isCompatibleB: true
    });

    // Baseline: Obligation A with only Proof A
    const evidenceOnlyA = CertifiedEvidenceNormalizer.normalize(
      bundle,
      'compute',
      'INV_F0',
      [obligations[0]],
      [proofA],
      coverage,
      verifiedFixtureFacts
    );

    // With unrelated valid Proof B included in proofs[]
    const evidenceWithB = CertifiedEvidenceNormalizer.normalize(
      bundle,
      'compute',
      'INV_F0',
      [obligations[0]],
      [proofA, proofB],
      coverage,
      verifiedFixtureFacts
    );

    const siteIdA = `${obligations[0].historicalOccurrenceAnchor.fileId}:${obligations[0].historicalOccurrenceAnchor.utf16Start}:${obligations[0].historicalOccurrenceAnchor.utf16End}`;

    assert.deepStrictEqual(
      evidenceWithB.compatibilityResults.get(siteIdA),
      evidenceOnlyA.compatibilityResults.get(siteIdA),
      'Obligation A result must be identical regardless of unrelated Proof B presence'
    );
    assert.strictEqual(evidenceWithB.compatibilityResults.get(siteIdA)?.status, 'COMPATIBLE');
  });

  await t.test('Probe B: Obligation A + Proof A + unrelated incompatible Proof B -> Proof B cannot change A result', () => {
    const { obligations, proofA, proofB, coverage, bundle } = buildTwoSiteFixtures({
      isCompatibleA: true,
      isCompatibleB: false // Proof B is incompatible!
    });

    // Baseline: Obligation A alone
    const evidenceOnlyA = CertifiedEvidenceNormalizer.normalize(
      bundle,
      'compute',
      'INV_F0',
      [obligations[0]],
      [proofA],
      coverage,
      verifiedFixtureFacts
    );

    // Contamination attempt: pass incompatible Proof B alongside Proof A
    const evidenceContaminated = CertifiedEvidenceNormalizer.normalize(
      bundle,
      'compute',
      'INV_F0',
      [obligations[0]],
      [proofA, proofB],
      coverage,
      verifiedFixtureFacts
    );

    const siteIdA = `${obligations[0].historicalOccurrenceAnchor.fileId}:${obligations[0].historicalOccurrenceAnchor.utf16Start}:${obligations[0].historicalOccurrenceAnchor.utf16End}`;

    assert.deepStrictEqual(
      evidenceContaminated.compatibilityResults.get(siteIdA),
      evidenceOnlyA.compatibilityResults.get(siteIdA),
      'Unrelated incompatible Proof B must NOT contaminate Obligation A'
    );
    assert.strictEqual(evidenceContaminated.compatibilityResults.get(siteIdA)?.status, 'COMPATIBLE');

    // Authority evaluation on evidence for A must remain PRESERVED
    const verdict = VerdictAuthority.evaluateProof(evidenceContaminated);
    assert.strictEqual(verdict.verdict, 'PRESERVED');
  });

  await t.test('Probe C: caller terms cannot turn only proof B into a refutation', () => {
    const { obligations, proofA, proofB, coverage, bundle } = buildTwoSiteFixtures({
      isCompatibleA: true,  // A is compatible
      isCompatibleB: false  // B is incompatible
    });

    const evidenceBoth = CertifiedEvidenceNormalizer.normalize(
      bundle,
      'compute',
      'INV_F0',
      [obligations[0], obligations[1]],
      [proofA, proofB],
      coverage,
      verifiedFixtureFacts
    );

    const siteIdA = `${obligations[0].historicalOccurrenceAnchor.fileId}:${obligations[0].historicalOccurrenceAnchor.utf16Start}:${obligations[0].historicalOccurrenceAnchor.utf16End}`;
    const siteIdB = `${obligations[1].historicalOccurrenceAnchor.fileId}:${obligations[1].historicalOccurrenceAnchor.utf16Start}:${obligations[1].historicalOccurrenceAnchor.utf16End}`;

    assert.strictEqual(evidenceBoth.compatibilityResults.get(siteIdA)?.status, 'COMPATIBLE', 'A must receive COMPATIBLE');
    assert.strictEqual(evidenceBoth.compatibilityResults.get(siteIdB)?.status, 'COMPATIBLE', 'B must remain bound to its sealed witness');
  });

  await t.test('Probe D: Missing Proof A while Proof B exists -> A fails closed (UNDECIDABLE), B remains independently evaluated', () => {
    const { obligations, proofB, coverage, bundle } = buildTwoSiteFixtures({
      isCompatibleA: true,
      isCompatibleB: true
    });

    // Only supply Proof B in proof set
    const evidenceMissingA = CertifiedEvidenceNormalizer.normalize(
      bundle,
      'compute',
      'INV_F0',
      [obligations[0], obligations[1]],
      [proofB], // Missing proof A
      coverage,
      verifiedFixtureFacts
    );

    const siteIdA = `${obligations[0].historicalOccurrenceAnchor.fileId}:${obligations[0].historicalOccurrenceAnchor.utf16Start}:${obligations[0].historicalOccurrenceAnchor.utf16End}`;
    const siteIdB = `${obligations[1].historicalOccurrenceAnchor.fileId}:${obligations[1].historicalOccurrenceAnchor.utf16Start}:${obligations[1].historicalOccurrenceAnchor.utf16End}`;

    assert.strictEqual(evidenceMissingA.compatibilityResults.get(siteIdA)?.status, 'UNDECIDABLE', 'Missing Proof A must fail closed to UNDECIDABLE');
    assert.strictEqual(evidenceMissingA.compatibilityResults.get(siteIdB)?.status, 'COMPATIBLE', 'Proof B must be evaluated independently');

    const verdict = VerdictAuthority.evaluateProof(evidenceMissingA);
    assert.strictEqual(verdict.verdict, 'UNKNOWN', 'Any UNDECIDABLE usage site must make final authority verdict UNKNOWN');
  });

  await t.test('Probe E: Incompatible Proof B supplied while evaluating Obligation A -> B cannot affect A', () => {
    const { obligations, proofA, proofB, coverage, bundle } = buildTwoSiteFixtures({
      isCompatibleA: true,
      isCompatibleB: false
    });

    // Supply both Proof A and incompatible Proof B, but only evaluate Obligation A
    const evidence = CertifiedEvidenceNormalizer.normalize(
      bundle,
      'compute',
      'INV_F0',
      [obligations[0]],
      [proofA, proofB],
      coverage,
      verifiedFixtureFacts
    );

    const siteIdA = `${obligations[0].historicalOccurrenceAnchor.fileId}:${obligations[0].historicalOccurrenceAnchor.utf16Start}:${obligations[0].historicalOccurrenceAnchor.utf16End}`;

    assert.strictEqual(evidence.compatibilityResults.get(siteIdA)?.status, 'COMPATIBLE');
    assert.strictEqual(evidence.canonicalOccurrences.length, 1);
  });

  await t.test('Gate 7: Unverified extra proof cannot reach normalizer', () => {
    const { input, proofB } = buildTwoSiteFixtures({
      isCompatibleA: true,
      isCompatibleB: true
    });

    // Create a 3rd unrelated or extra proof
    const extraProof: SemanticProof = {
      ...proofB,
      obligationRef: { domain: ArtifactDomain.OBLIGATION, digest: 'e'.repeat(64) }
    };

    // Tamper input to include extra proof
    const tamperedInput = {
      ...input,
      proofs: [...input.proofs, extraProof]
    };

    const res = CertifiedEvaluationOrchestrator.evaluate(tamperedInput);
    assert.strictEqual(res.verdictResult.verdict, 'UNKNOWN');
    assert.strictEqual(res.failedGate, 'PROOF_VERIFICATION');
    assert.strictEqual(res.blockerCode, BlockerCode.INVALID_SCHEMA);
    assert.ok(
      res.detailMessage?.includes('extra') || res.detailMessage?.includes('unknown'),
      `Gate 7 must reject extra/unverified proofs before normalizer: got ${res.detailMessage}`
    );
    assert.ok(!res.passedGates.includes('NORMALIZATION'), 'Extra unverified proof must NOT reach NORMALIZATION');
  });

  await t.test('Gate 7: Duplicate proof for single obligation is rejected', () => {
    const { input } = buildTwoSiteFixtures({
      isCompatibleA: true,
      isCompatibleB: true
    });

    // Duplicate proof for obligation[0]
    const tamperedInput = {
      ...input,
      proofs: [input.proofs[0], input.proofs[0], input.proofs[1]]
    };

    const res = CertifiedEvaluationOrchestrator.evaluate(tamperedInput);
    assert.strictEqual(res.verdictResult.verdict, 'UNKNOWN');
    assert.strictEqual(res.failedGate, 'PROOF_VERIFICATION');
    assert.strictEqual(res.blockerCode, BlockerCode.INVALID_SCHEMA);
    assert.ok(!res.passedGates.includes('NORMALIZATION'), 'Duplicate proof must NOT reach NORMALIZATION');
  });
});
