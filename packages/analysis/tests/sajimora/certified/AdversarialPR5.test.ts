import { test } from 'node:test';
import * as assert from 'node:assert';
import {
  CertifiedEvaluationOrchestrator,
  CertifiedExecutionInput
} from '../../../src/sajimora/certified/integration/CertifiedEvaluationOrchestrator';
import { HistoricalObligationGenerator } from '../../../src/sajimora/certified/obligations/HistoricalObligationGenerator';
import { ObligationVerifier } from '../../../src/sajimora/certified/obligations/ObligationVerifier';
import { ProofProducer } from '../../../src/sajimora/certified/proof/ProofProducer';
import { ProofChecker } from '../../../src/sajimora/certified/proof/ProofChecker';
import { CoverageProducer } from '../../../src/sajimora/certified/coverage/CoverageProducer';
import { CoverageVerifier } from '../../../src/sajimora/certified/coverage/CoverageVerifier';
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
  ProofNode
} from '../../../../core/src/sajimora/certified/contracts';
import {
  CanonicalSet,
  canonicalEncode,
  computeDomainSeparatedHash,
  hashContract
} from '../../../../core/src/sajimora/certified/canonicalEncoding';
import { CrossVersionIdentityBundle } from '../../../../core/src/sajimora/types/identity';

function createManifestAndSealedFs(files: { path: string; content: string }[], rev: string = 'rev1') {
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
    repositoryId: 'adversarial-repo',
    revision: { commitId: rev, treeId: 't1', parentSelection: 'p1' },
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

function createBaselineAdversarialInput(options?: { candidateCode?: string; isCaseB?: boolean }): CertifiedExecutionInput {
  const code = `export function run(x: string): string { return x; }`;
  const candidateCode = options?.candidateCode ?? code;
  const consumer = `
    import { run } from './provider';
    export const out: string = run("hello");
  `;

  const { manifest: pManifest, sealedFs: pFs } = createManifestAndSealedFs(
    [{ path: 'provider.ts', content: code }, { path: 'consumer.ts', content: consumer }],
    'parentRev'
  );
  const { manifest: cManifest, sealedFs: cFs } = createManifestAndSealedFs(
    [{ path: 'provider.ts', content: candidateCode }, { path: 'consumer.ts', content: consumer }],
    'candidateRev'
  );

  const pEnvRef: ArtifactRef = {
    domain: ArtifactDomain.MANIFEST,
    digest: hashContract(ArtifactDomain.MANIFEST, pManifest.schemaVersion, pManifest)
  };
  const cEnvRef: ArtifactRef = {
    domain: ArtifactDomain.MANIFEST,
    digest: hashContract(ArtifactDomain.MANIFEST, cManifest.schemaVersion, cManifest)
  };

  const pRoots = [{ projectId: 'p0', fileId: 'provider.ts' }, { projectId: 'p0', fileId: 'consumer.ts' }];
  const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
  const pExtractor = new ASTAnchorExtractor();
  const pResolver = new F0RestrictedResolver(pFs, budget);
  const pClosure = new DependencyClosureProducer(pFs, pExtractor, pResolver).produceClosure(
    pEnvRef,
    RootPolicyId.F0_ENV_GIT_SEALED_V1,
    new CanonicalSet<Vertex>(pRoots)
  );

  const cExtractor = new ASTAnchorExtractor();
  const cResolver = new F0RestrictedResolver(cFs, budget);
  const cClosure = new DependencyClosureProducer(cFs, cExtractor, cResolver).produceClosure(
    cEnvRef,
    RootPolicyId.F0_ENV_GIT_SEALED_V1,
    new CanonicalSet<Vertex>(pRoots)
  );

  const pClosureRef: ArtifactRef = {
    domain: ArtifactDomain.CLOSURE,
    digest: hashContract(ArtifactDomain.CLOSURE, pClosure.schemaVersion, pClosure)
  };
  const cClosureRef: ArtifactRef = {
    domain: ArtifactDomain.CLOSURE,
    digest: hashContract(ArtifactDomain.CLOSURE, cClosure.schemaVersion, cClosure)
  };

  const pAdmission = new FragmentAdmissionProducer(pFs).produceAdmission(pEnvRef, pClosureRef, pRoots);
  const cAdmission = new FragmentAdmissionProducer(cFs).produceAdmission(cEnvRef, cClosureRef, pRoots);

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

  const identityBundle: CrossVersionIdentityBundle = {
    targetMappings: [
      {
        parent: makeSym('provider.ts', 'run'),
        candidate: makeSym('provider.ts', 'run'),
        status: options?.isCaseB ? 'SAME_DECLARATION' : (code === candidateCode ? 'SAME_DECLARATION' : 'UNRESOLVED'),
        evidence: [],
        plausibleCandidateIds: ['run']
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
    'run',
    targetIdRef,
    lifecycleRef
  );

  const proofs = obligations.map(obl =>
    ProofProducer.produceProof(obl, {
      sourceScalar: { kind: 'literal', value: 'hello' },
      targetScalar: { kind: 'primitive', name: 'string' }
    })
  );

  const coverage = CoverageProducer.produceCoverage(
    pManifest,
    cManifest,
    pFs,
    'run',
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
    repositoryId: 'adversarial-repo',
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
    parentManifest: pManifest,
    candidateManifest: cManifest,
    parentClosure: pClosure,
    candidateClosure: cClosure,
    parentClosureFacts: pClosure.facts,
    candidateClosureFacts: cClosure.facts,
    parentAdmission: pAdmission,
    candidateAdmission: cAdmission,
    identityBundle,
    targetSymbolId: 'run',
    invariantId: 'INV_ADVERSARIAL',
    obligations,
    proofs,
    coverage,
    bundle,
    parentSealedFs: pFs,
    candidateSealedFs: cFs,
    budget: new VerificationBudget(INITIAL_RESOURCE_PROFILE)
  };
}

test('Adversarial PR5 Trust Boundary Attack Matrix', async (t) => {
  await t.test('Attack 1: altered certificate (wrong schema version)', () => {
    const input = createBaselineAdversarialInput();
    const tampered = {
      ...input,
      bundle: { ...input.bundle, schemaVersion: 'SAJIMORA_V99_FORGED' as any }
    };
    const res = CertifiedEvaluationOrchestrator.evaluate(tampered);
    assert.strictEqual(res.verdictResult.verdict, 'UNKNOWN');
    assert.strictEqual(res.failedGate, 'BUNDLE_INTEGRITY');
    assert.strictEqual(res.blockerCode, BlockerCode.INVALID_SCHEMA);
  });

  await t.test('Attack 2: altered evidence (forged environment hash in bundle)', () => {
    const input = createBaselineAdversarialInput();
    const tampered = {
      ...input,
      bundle: {
        ...input.bundle,
        parentEnvironmentRef: { domain: ArtifactDomain.MANIFEST, digest: 'deadbeef'.repeat(8) }
      }
    };
    const res = CertifiedEvaluationOrchestrator.evaluate(tampered);
    assert.strictEqual(res.verdictResult.verdict, 'UNKNOWN');
    assert.strictEqual(res.failedGate, 'BUNDLE_INTEGRITY');
    assert.strictEqual(res.blockerCode, BlockerCode.HASH_MISMATCH);
  });

  await t.test('Attack 3: omitted evidence (dropped obligation from list)', () => {
    const input = createBaselineAdversarialInput();
    const tampered = {
      ...input,
      obligations: [] // Omit all obligations
    };
    const res = CertifiedEvaluationOrchestrator.evaluate(tampered);
    assert.strictEqual(res.verdictResult.verdict, 'UNKNOWN');
    assert.strictEqual(res.failedGate, 'OBLIGATION');
    assert.strictEqual(res.blockerCode, BlockerCode.MISSING_OBLIGATION);
  });

  await t.test('Attack 4: duplicate evidence (duplicated obligation in list)', () => {
    const input = createBaselineAdversarialInput();
    const tampered = {
      ...input,
      obligations: [...input.obligations, input.obligations[0]]
    };
    const res = CertifiedEvaluationOrchestrator.evaluate(tampered);
    assert.strictEqual(res.verdictResult.verdict, 'UNKNOWN');
    assert.strictEqual(res.failedGate, 'OBLIGATION');
    assert.strictEqual(res.blockerCode, BlockerCode.INVALID_SCHEMA);
  });

  await t.test('Attack 5: forged dependency reference (invalid ruleId in proof)', () => {
    const input = createBaselineAdversarialInput();
    const forgedProof = {
      ...input.proofs[0],
      ruleSetId: 'FORGED_RULESET' as any
    };
    const tampered = {
      ...input,
      proofs: [forgedProof]
    };
    const res = CertifiedEvaluationOrchestrator.evaluate(tampered);
    assert.strictEqual(res.verdictResult.verdict, 'UNKNOWN');
    assert.strictEqual(res.failedGate, 'PROOF_VERIFICATION');
    assert.strictEqual(res.blockerCode, BlockerCode.UNSUPPORTED_PROTOCOL);
  });

  await t.test('Attack 6: missing dependency reference (missing proof for obligation)', () => {
    const input = createBaselineAdversarialInput();
    const tampered = {
      ...input,
      proofs: [] // Empty proof list
    };
    const res = CertifiedEvaluationOrchestrator.evaluate(tampered);
    assert.strictEqual(res.verdictResult.verdict, 'UNKNOWN');
    assert.strictEqual(res.failedGate, 'PROOF_VERIFICATION');
    assert.strictEqual(res.blockerCode, BlockerCode.MISSING_EVIDENCE);
  });

  await t.test('Attack 7: contradictory evidence (producer claims COMPATIBLE but rule refutes)', () => {
    const input = createBaselineAdversarialInput();
    const failingProof = ProofProducer.produceProof(input.obligations[0]);
    // Claim a refutation despite the sealed compatible witness.
    const contradictoryProof = {
      ...failingProof,
      claimedConclusion: 'INCOMPATIBLE' as const
    };

    const tampered = {
      ...input,
      proofs: [contradictoryProof]
    };
    const res = CertifiedEvaluationOrchestrator.evaluate(tampered);
    assert.strictEqual(res.verdictResult.verdict, 'UNKNOWN');
    assert.strictEqual(res.failedGate, 'PROOF_VERIFICATION');
    assert.strictEqual(res.blockerCode, BlockerCode.PREMISE_NOT_SATISFIED);
  });

  await t.test('Attack 8: producer/verifier disagreement (altered node ID in proof)', () => {
    const input = createBaselineAdversarialInput();
    const node = Array.from(input.proofs[0].nodes)[0];
    const tamperedNode: ProofNode = {
      ...node,
      nodeId: 'altered_node_id_0000000000000000'
    };
    const tamperedProof = {
      ...input.proofs[0],
      nodes: new CanonicalSet<ProofNode>([tamperedNode]),
      rootNodeIds: new CanonicalSet<string>([tamperedNode.nodeId])
    };

    const tampered = {
      ...input,
      proofs: [tamperedProof]
    };
    const res = CertifiedEvaluationOrchestrator.evaluate(tampered);
    assert.strictEqual(res.verdictResult.verdict, 'UNKNOWN');
    assert.strictEqual(res.failedGate, 'PROOF_VERIFICATION');
    assert.strictEqual(res.blockerCode, BlockerCode.INVALID_RULE_APPLICATION);
  });

  await t.test('Attack 9: budget exhaustion (exceeding max work units)', () => {
    const input = createBaselineAdversarialInput();
    const exhaustedBudget = new VerificationBudget({
      ...INITIAL_RESOURCE_PROFILE,
      maxWorkUnits: 1 // Tiny budget
    });

    const tampered = {
      ...input,
      budget: exhaustedBudget
    };
    const res = CertifiedEvaluationOrchestrator.evaluate(tampered);
    assert.strictEqual(res.verdictResult.verdict, 'UNKNOWN');
    assert.strictEqual(res.failedGate, 'RESOURCE_BUDGET');
    assert.strictEqual(res.blockerCode, BlockerCode.RESOURCE_EXHAUSTED);
  });

  await t.test('Attack 10: Case-B uncertainty escalation attempt (modified file claimed SAME)', () => {
    // Simulate modified provider file by creating different candidate bytes with isCaseB: true
    const input = createBaselineAdversarialInput({
      candidateCode: `export function run(x: string): string { return "modified"; }`,
      isCaseB: true
    });

    const res = CertifiedEvaluationOrchestrator.evaluate(input);
    assert.strictEqual(res.verdictResult.verdict, 'UNKNOWN');
    assert.strictEqual(res.failedGate, 'IDENTITY');
    assert.strictEqual(res.blockerCode, BlockerCode.IDENTITY_MISMATCH);
  });

  await t.test('Attack 11: attempted VERIFIED result from incomplete coverage mode', () => {
    const input = createBaselineAdversarialInput();
    const tamperedCoverage = {
      ...input.coverage,
      mode: 'PERMISSIVE_SUPERSET' as any
    };

    const tampered = {
      ...input,
      coverage: tamperedCoverage
    };

    const res = CertifiedEvaluationOrchestrator.evaluate(tampered);
    assert.strictEqual(res.verdictResult.verdict, 'UNKNOWN');
    assert.strictEqual(res.failedGate, 'COVERAGE');
    assert.strictEqual(res.blockerCode, BlockerCode.UNSUPPORTED_COVERAGE_MODE);
  });
});
