/**
 * @file ProductionVerificationCore.test.ts
 * Tests verifying the repository-agnostic and language-agnostic production verification core.
 */

import { EvidenceAcceptanceSession } from '../../src/sajimora/verification/AcceptedEvidence';
import {
  GenericRepository,
  GenericRepositorySnapshot,
  GenericProjectGraph,
  AsymmetricProjectMapping,
  GenericLanguageAdapter,
  ProductionVerificationCore,
  ConservationGate,
  ConservationAbortError,
  SemanticEntity,
  SemanticChange,
  Reference,
  VerificationObligation,
  VerificationVerdict,
  ProvenanceChain,
  VerdictAuthorityBridge
} from '../../src/sajimora';

function createMockRepository(repoId: string = 'test-generic-repo'): GenericRepository {
  return {
    repositoryId: repoId,
    parentSnapshot: {
      snapshotId: 'commit-parent-123',
      rootIdentifier: '/',
      files: [
        { path: 'src/calc.mod', byteLength: 100, hash: 'h1' },
        { path: 'src/app.mod', byteLength: 200, hash: 'h2' }
      ],
      readTextFile: (p) => p === 'src/calc.mod' ? 'export fn add(a, b) { a + b }' : 'import { add } from "./calc"; add(1, 2);',
      readBinaryFile: () => undefined
    },
    candidateSnapshot: {
      snapshotId: 'commit-cand-456',
      rootIdentifier: '/',
      files: [
        { path: 'src/calc.mod', byteLength: 105, hash: 'h3' },
        { path: 'src/app.mod', byteLength: 200, hash: 'h2' }
      ],
      readTextFile: (p) => p === 'src/calc.mod' ? 'export fn add(a, b) { a + b }' : 'import { add } from "./calc"; add(1, 2);',
      readBinaryFile: () => undefined
    }
  };
}

class MockGenericLanguageAdapter implements GenericLanguageAdapter {
  public readonly languageId = 'generic-test-lang';
  public readonly adapterVersion = '1.0.0';

  public canHandle(repo: GenericRepository): boolean {
    return repo.parentSnapshot.files.some(f => f.path.endsWith('.mod'));
  }

  public async discoverProjectGraph(snapshot: GenericRepositorySnapshot): Promise<GenericProjectGraph> {
    return {
      graphId: `graph_${snapshot.snapshotId}`,
      projects: [
        {
          projectId: 'mock-proj-1',
          rootDirectory: '/',
          sourceFiles: snapshot.files.map(f => f.path),
          projectReferences: []
        }
      ],
      edges: []
    };
  }

  public async mapProjectGraphs(
    parentGraph: GenericProjectGraph,
    candidateGraph: GenericProjectGraph
  ): Promise<AsymmetricProjectMapping> {
    return {
      matched: [{ parentProjectId: 'mock-proj-1', candidateProjectId: 'mock-proj-1' }],
      added: [],
      deleted: []
    };
  }

  public async identifyEntitiesAndChanges(): Promise<{
    entities: SemanticEntity[];
    changes: SemanticChange[];
  }> {
    const parentEntity: SemanticEntity = {
      entityId: 'calc.mod::add',
      projectId: 'mock-proj-1',
      name: 'add',
      kind: 'FUNCTION',
      qualifiedName: 'calc::add',
      filePath: 'src/calc.mod',
      signatureFingerprint: 'fn(Int, Int) -> Int',
      isExported: true
    };

    const change: SemanticChange = {
      changeId: 'change-add-1',
      identity: {
        identityId: 'id-add',
        status: 'CONFIRMED_IDENTITY',
        parentEntity,
        candidateEntity: { ...parentEntity, signatureFingerprint: 'fn(Int, Int) -> Int' },
        confidence: 'CERTAIN'
      },
      changeKind: 'UNCHANGED',
      description: 'Signature identical'
    };

    return {
      entities: [parentEntity],
      changes: [change]
    };
  }

  public async discoverReferences(): Promise<{
    staticReferences: Reference[];
    unresolvedBoundaries: Reference[];
  }> {
    const staticRef: Reference = {
      referenceId: 'ref-1',
      projectId: 'mock-proj-1',
      kind: 'STATIC_CALL',
      targetEntityId: 'calc.mod::add',
      location: { filePath: 'src/app.mod', line: 1, character: 30 },
      isUnresolvedBoundary: false
    };

    const unresolvedBoundary: Reference = {
      referenceId: 'ref-dynamic-2',
      projectId: 'mock-proj-1',
      kind: 'DYNAMIC_PROPERTY_ACCESS',
      targetEntityId: 'calc.mod::add',
      location: { filePath: 'src/app.mod', line: 2, character: 10 },
      isUnresolvedBoundary: true,
      boundaryTaxonomyReason: 'DYNAMIC_INDEX_ACCESS'
    };

    return {
      staticReferences: [staticRef],
      unresolvedBoundaries: [unresolvedBoundary]
    };
  }

  public async generateObligations(
    changes: readonly SemanticChange[],
    references: readonly Reference[]
  ): Promise<VerificationObligation[]> {
    const obligations: VerificationObligation[] = [];

    // Obligation 1: API compatibility
    obligations.push({
      obligationId: 'ob-api-1',
      projectId: 'mock-proj-1',
      question: 'API_COMPATIBILITY',
      change: changes[0],
      scope: 'PROVIDER',
      createdAt: new Date().toISOString()
    });

    // Obligation 2: Static consumer compatibility
    obligations.push({
      obligationId: 'ob-consumer-1',
      projectId: 'mock-proj-1',
      question: 'CONSUMER_COMPATIBILITY',
      change: changes[0],
      reference: references[0],
      scope: 'CONSUMER',
      createdAt: new Date().toISOString()
    });

    // Obligation 3: Dynamic boundary
    obligations.push({
      obligationId: 'ob-dynamic-2',
      projectId: 'mock-proj-1',
      question: 'CONSUMER_COMPATIBILITY',
      change: changes[0],
      reference: references[1],
      scope: 'CONSUMER',
      createdAt: new Date().toISOString()
    });

    return obligations;
  }

  public async evaluateObligation(
    obligation: VerificationObligation,
    repository: GenericRepository
  ): Promise<VerificationVerdict> {
    const verdictId = `v_${obligation.obligationId}`;
    const evidenceId = `ev_${obligation.obligationId}`;

    const provenance: ProvenanceChain = {
      repositoryId: repository.repositoryId,
      projectId: obligation.projectId,
      identityId: obligation.change.identity.identityId,
      referenceId: obligation.reference?.referenceId,
      obligationId: obligation.obligationId,
      evidenceId,
      verdictId
    };

    if (obligation.question === 'API_COMPATIBILITY') {
      return {
        verdictId,
        obligationId: obligation.obligationId,
        targetEntityId: obligation.change.identity.parentEntity!.entityId,
        outcome: 'PRESERVED',
        assurance: 'COMPILER_STATIC',
        property: 'API_TYPE',
        scope: 'PROVIDER',
        provenance,
        evidence: {
          evidenceId,
          assurance: 'COMPILER_STATIC',
          property: 'API_TYPE',
          compilerStatic: {
            diagnosticDelta: 0,
            parentDiagnosticCount: 0,
            candidateDiagnosticCount: 0,
            introducedDiagnostics: []
          }
        },
        timestamp: new Date().toISOString()
      };
    }

    if (obligation.reference?.isUnresolvedBoundary) {
      return {
        verdictId,
        obligationId: obligation.obligationId,
        targetEntityId: obligation.change.identity.parentEntity!.entityId,
        outcome: 'UNKNOWN',
        assurance: 'UNRESOLVED',
        property: 'RESOLUTION',
        scope: 'CONSUMER',
        provenance,
        evidence: {
          evidenceId,
          assurance: 'UNRESOLVED',
          property: 'RESOLUTION',
          unresolvedBoundary: {
            taxonomyCode: 'DYNAMIC_INDEX_ACCESS',
            description: 'Consumer accesses target via dynamic string variable',
            remediation: {
              code: 'USE_EXPLICIT_NAME',
              suggestion: 'Use static member access instead of dynamic index'
            }
          }
        },
        timestamp: new Date().toISOString()
      };
    }

    // Static consumer
    return {
      verdictId,
      obligationId: obligation.obligationId,
      targetEntityId: obligation.change.identity.parentEntity!.entityId,
      outcome: 'PRESERVED',
      assurance: 'COMPILER_STATIC',
      property: 'CONSUMER_TYPE',
      scope: 'CONSUMER',
      provenance,
      evidence: {
        evidenceId,
        assurance: 'COMPILER_STATIC',
        property: 'CONSUMER_TYPE',
        compilerStatic: {
          diagnosticDelta: 0,
          parentDiagnosticCount: 0,
          candidateDiagnosticCount: 0,
          introducedDiagnostics: []
        }
      },
      timestamp: new Date().toISOString()
    };
  }
}

async function runTests() {
  console.log('--- Running Generic Production Verification Core Tests ---');

  const repo = createMockRepository();
  const adapter = new MockGenericLanguageAdapter();
  const core = new ProductionVerificationCore();
  core.registerAdapter(adapter);

  // Test 1: Complete end-to-end verification
  console.log('Test 1: End-to-end pipeline execution...');
  const result = await core.verifyRepository(repo);
  if (result.ledger.summary.total !== 3) {
    throw new Error(`Expected 3 total obligations, got ${result.ledger.summary.total}`);
  }
  if (result.ledger.conservationReport.silentDropsCount !== 0) {
    throw new Error(`Expected 0 silent drops, got ${result.ledger.conservationReport.silentDropsCount}`);
  }
  if (!result.ledger.conservationReport.conservationSatisfied) {
    throw new Error('Conservation was not satisfied');
  }
  console.log('✓ Test 1 passed: 3/3 obligations accounted, 0 silent drops.');

  // Test 2: Invariant Check - Conservation Gate aborts on missing obligation (Silent Drop)
  console.log('Test 2: Conservation Gate silent drop rejection...');
  const fakeRefs: Reference[] = [
    {
      referenceId: 'r1',
      projectId: 'proj-1',
      kind: 'STATIC_CALL',
      targetEntityId: 'e1',
      location: { filePath: 'f.mod', line: 1, character: 1 },
      isUnresolvedBoundary: false
    }
  ];
  const fakeObligations: VerificationObligation[] = [
    {
      obligationId: 'ob-1',
      projectId: 'proj-1',
      question: 'API_COMPATIBILITY',
      change: { identity: { identityId: 'id-1' } } as any,
      scope: 'PROVIDER',
      createdAt: ''
    },
    {
      obligationId: 'ob-2',
      projectId: 'proj-1',
      question: 'CONSUMER_COMPATIBILITY',
      change: { identity: { identityId: 'id-1' } } as any,
      scope: 'CONSUMER',
      createdAt: ''
    }
  ];
  const partialVerdicts: VerificationVerdict[] = [
    {
      verdictId: 'v1',
      obligationId: 'ob-1', // ob-2 is missing!
      targetEntityId: 'e1',
      outcome: 'PRESERVED',
      assurance: 'COMPILER_STATIC',
      property: 'API_TYPE',
      scope: 'PROVIDER',
      provenance: {
        repositoryId: 'r',
        projectId: 'proj-1',
        identityId: 'id-1',
        obligationId: 'ob-1',
        evidenceId: 'ev1',
        verdictId: 'v1'
      },
      evidence: {
        evidenceId: 'ev1',
        assurance: 'COMPILER_STATIC',
        property: 'API_TYPE',
        compilerStatic: {
          diagnosticDelta: 0,
          parentDiagnosticCount: 0,
          candidateDiagnosticCount: 0,
          introducedDiagnostics: []
        }
      },
      timestamp: ''
    }
  ];

  let aborted = false;
  try {
    ConservationGate.reconcileAndEnforce(fakeRefs, fakeObligations, partialVerdicts);
  } catch (err) {
    if (err instanceof ConservationAbortError) {
      aborted = true;
      if (err.report.silentDropsCount !== 2) {
        throw new Error(`Expected one missing verdict and one uncovered reference, got ${err.report.silentDropsCount}`);
      }
    }
  }
  if (!aborted) {
    throw new Error('ConservationGate failed to abort on silent drop!');
  }
  console.log('✓ Test 2 passed: Silent drop correctly triggered ConservationAbortError.');

  // Test 3: Invariant Check - Compiler Static cannot claim BEHAVIOR preservation
  console.log('Test 3: Rejecting illicit BEHAVIOR promotion from compiler static evidence...');
  const illicitVerdict: VerificationVerdict = {
    verdictId: 'v-illicit',
    obligationId: 'ob-1',
    targetEntityId: 'e1',
    outcome: 'PRESERVED',
    assurance: 'COMPILER_STATIC',
    property: 'BEHAVIOR', // ILLEGAL!
    scope: 'CONSUMER',
    provenance: {
      repositoryId: 'r',
      projectId: 'proj-1',
      identityId: 'id-1',
      obligationId: 'ob-1',
      evidenceId: 'ev-il',
      verdictId: 'v-illicit'
    },
    evidence: {
      evidenceId: 'ev-il',
      assurance: 'COMPILER_STATIC',
      property: 'BEHAVIOR',
      compilerStatic: {
        diagnosticDelta: 0,
        parentDiagnosticCount: 0,
        candidateDiagnosticCount: 0,
        introducedDiagnostics: []
      }
    },
    timestamp: ''
  };

  let rejectedPromotion = false;
  try {
    ConservationGate.reconcileAndEnforce(fakeRefs, [fakeObligations[0]], [illicitVerdict]);
  } catch (err: any) {
    if (err.message.includes('BEHAVIOR preservation claimed under non-formal assurance tier') ||
        err.message.includes('Compiler static analysis cannot claim BEHAVIOR preservation')) {
      rejectedPromotion = true;
    }
  }
  if (!rejectedPromotion) {
    throw new Error('ConservationGate failed to reject illicit BEHAVIOR promotion!');
  }
  console.log('✓ Test 3 passed: Illicit BEHAVIOR promotion correctly rejected.');

  // Test 4: Invariant Check - UNRESOLVED boundary can NEVER produce PRESERVED
  console.log('Test 4: Rejecting PRESERVED on UNRESOLVED boundary...');
  const illicitUnresolved: VerificationVerdict = {
    verdictId: 'v-unresolved-bad',
    obligationId: 'ob-1',
    targetEntityId: 'e1',
    outcome: 'PRESERVED', // ILLEGAL for UNRESOLVED!
    assurance: 'UNRESOLVED',
    property: 'RESOLUTION',
    scope: 'CONSUMER',
    provenance: {
      repositoryId: 'r',
      projectId: 'proj-1',
      identityId: 'id-1',
      obligationId: 'ob-1',
      evidenceId: 'ev-un',
      verdictId: 'v-unresolved-bad'
    },
    evidence: {
      evidenceId: 'ev-un',
      assurance: 'UNRESOLVED',
      property: 'RESOLUTION',
      unresolvedBoundary: {
        taxonomyCode: 'CODE',
        description: 'desc',
        remediation: { code: 'c', suggestion: 's' }
      }
    },
    timestamp: ''
  };

  let rejectedUnresolvedPreserved = false;
  try {
    ConservationGate.reconcileAndEnforce(fakeRefs, [fakeObligations[0]], [illicitUnresolved]);
  } catch (err: any) {
    if (err.message.includes('UNRESOLVED boundary can never produce PRESERVED verdict')) {
      rejectedUnresolvedPreserved = true;
    }
  }
  if (!rejectedUnresolvedPreserved) {
    throw new Error('ConservationGate failed to reject PRESERVED on UNRESOLVED boundary!');
  }
  console.log('✓ Test 4 passed: PRESERVED on UNRESOLVED boundary correctly rejected.');

  // Test 5: Reconciling Empty & All-NOT_APPLICABLE ledgers
  console.log('Test 5: Verifying Empty and All-NOT_APPLICABLE ledger statuses...');
  const emptyReport = ConservationGate.reconcileAndEnforce([], [], []);
  const emptyLedger = {
    ledgerId: 'ledger-empty-test',
    repositoryId: 'r',
    parentSnapshotId: 'p',
    candidateSnapshotId: 'c',
    conservationReport: emptyReport,
    verdicts: [],
    summary: { total: 0, preserved: 0, violated: 0, notApplicable: 0, unknown: 0 },
    certificationStatus: 'UNCERTIFIED_UNKNOWN' as const,
    issuedAt: new Date().toISOString()
  };
  const emptyResult = VerdictAuthorityBridge.evaluateAuthoritative(emptyLedger, 'root');
  if (emptyResult.verdict !== 'UNKNOWN') {
    throw new Error(`Expected UNKNOWN without checked discovery coverage, got ${emptyResult.verdict}`);
  }
  console.log('✓ Test 5 passed: Empty ledger remains UNKNOWN without checked discovery coverage.');

  // Test 6: Invariant Check - Mixed Assurance yields UNCERTIFIED_UNKNOWN
  console.log('Test 6: Verifying mixed assurance (F0_FORMAL + COMPILER_STATIC) yields aggregate UNKNOWN...');
  const f0Verdict: VerificationVerdict = {
    verdictId: 'v-f0-1',
    obligationId: 'ob-1',
    targetEntityId: 'e1',
    outcome: 'PRESERVED',
    assurance: 'F0_FORMAL',
    property: 'CONSUMER_TYPE',
    scope: 'CONSUMER',
    provenance: {
      repositoryId: 'r',
      projectId: 'proj-1',
      identityId: 'id-1',
      referenceId: 'ref-1',
      obligationId: 'ob-1',
      evidenceId: 'ev-f0',
      verdictId: 'v-f0-1'
    },
    evidence: {
      evidenceId: 'ev-f0',
      assurance: 'F0_FORMAL',
      property: 'CONSUMER_TYPE',
      f0Formal: { proofTrace: [{ ruleApplied: 'F0_RULE', stepIndex: 1, premises: [], conclusion: 'Passed' }] }
    },
    timestamp: ''
  };
  const csVerdict: VerificationVerdict = {
    verdictId: 'v-cs-2',
    obligationId: 'ob-2',
    targetEntityId: 'e1',
    outcome: 'PRESERVED',
    assurance: 'COMPILER_STATIC',
    property: 'CONSUMER_TYPE',
    scope: 'CONSUMER',
    provenance: {
      repositoryId: 'r',
      projectId: 'proj-1',
      identityId: 'id-1',
      referenceId: 'ref-2',
      obligationId: 'ob-2',
      evidenceId: 'ev-cs',
      verdictId: 'v-cs-2'
    },
    evidence: {
      evidenceId: 'ev-cs',
      assurance: 'COMPILER_STATIC',
      property: 'CONSUMER_TYPE',
      compilerStatic: { diagnosticDelta: 0, parentDiagnosticCount: 0, candidateDiagnosticCount: 0, introducedDiagnostics: [] }
    },
    timestamp: ''
  };
  const mixedRef1: Reference = { referenceId: 'ref-1', projectId: 'proj-1', kind: 'STATIC_CALL', targetEntityId: 'e1', location: { filePath: 'f1', line: 1, character: 1 }, isUnresolvedBoundary: false };
  const mixedRef2: Reference = { referenceId: 'ref-2', projectId: 'proj-1', kind: 'STATIC_CALL', targetEntityId: 'e1', location: { filePath: 'f2', line: 1, character: 1 }, isUnresolvedBoundary: false };
  const mixedOb1: VerificationObligation = { ...fakeObligations[0], question: 'CONSUMER_COMPATIBILITY', scope: 'CONSUMER', change: { ...fakeObligations[0].change, identity: { ...fakeObligations[0].change.identity, status: 'CONFIRMED_IDENTITY' } }, obligationId: 'ob-1', reference: mixedRef1 };
  const mixedOb2: VerificationObligation = { ...fakeObligations[0], obligationId: 'ob-2', reference: mixedRef2 };
  // This generic aggregation test models a verifier that has already accepted
  // its proof; source/proof rejection is covered by the production regressions.
  f0Verdict.evidence.metadata = { verificationProfile: 'TEST_AGGREGATION_ONLY' };
  const snapshot = (snapshotId: string) => ({ snapshotId, rootIdentifier: '/', files: [], readTextFile: () => undefined, readBinaryFile: () => undefined });
  const acceptance = new EvidenceAcceptanceSession({ repositoryId: 'r', parentSnapshot: snapshot('p'), candidateSnapshot: snapshot('c') },
    [{ profileId: 'TEST_AGGREGATION_ONLY', check: (_ob, _repo, verdict) => verdict === f0Verdict }]);
  if (!acceptance.verifyAndAccept(mixedOb1, f0Verdict)) throw new Error('Aggregation fixture acceptance failed');
  const mixedReport = ConservationGate.reconcileAndEnforce([mixedRef1, mixedRef2], [mixedOb1, mixedOb2], [f0Verdict, csVerdict], acceptance);
  const mixedLedger = {
    ledgerId: 'ledger-mixed-test',
    repositoryId: 'r',
    parentSnapshotId: 'p',
    candidateSnapshotId: 'c',
    conservationReport: mixedReport,
    verdicts: [f0Verdict, csVerdict],
    summary: { total: 2, preserved: 2, violated: 0, notApplicable: 0, unknown: 0 },
    certificationStatus: 'UNCERTIFIED_UNKNOWN' as const,
    issuedAt: new Date().toISOString()
  };
  const mixedResult = VerdictAuthorityBridge.evaluateAuthoritative(mixedLedger, 'e1', acceptance);
  if (mixedResult.verdict !== 'UNKNOWN') {
    throw new Error(`Expected UNKNOWN for mixed assurance ledger, got ${mixedResult.verdict}`);
  }
  console.log('✓ Test 6 passed: Mixed assurance correctly yields UNCERTIFIED_UNKNOWN / UNKNOWN.');

  console.log('Test 7: Unverified producer claims must become UNKNOWN in the full pipeline...');
  for (const assurance of ['F0_FORMAL', 'WITNESS'] as const) {
    for (const checkerMode of ['absent', 'reject', 'throw'] as const) {
      const untrustedAdapter = new MockGenericLanguageAdapter();
      const originalEvaluate = untrustedAdapter.evaluateObligation.bind(untrustedAdapter);
      untrustedAdapter.evaluateObligation = async (obligation, repository) => {
        const original = await originalEvaluate(obligation, repository);
        if (obligation.question !== 'API_COMPATIBILITY') return original;
        return Object.freeze({ ...original, assurance,
          outcome: assurance === 'F0_FORMAL' ? 'PRESERVED' : 'VIOLATED',
          evidence: { ...original.evidence, assurance,
            metadata: { verificationProfile: 'UNTRUSTED_PRODUCER_V1' },
            f0Formal: { proofTrace: [] },
            witness: { description: 'Producer assertion only' }
          }
        }) as VerificationVerdict;
      };
      const rejectingCore = new ProductionVerificationCore(checkerMode === 'absent' ? [] : [{
        profileId: 'UNTRUSTED_PRODUCER_V1',
        check: () => {
          if (checkerMode === 'throw') throw new Error('Checker failed');
          return false;
        }
      }]);
      rejectingCore.registerAdapter(untrustedAdapter);
      const rejected = await rejectingCore.verifyRepository(repo);
      const proposal = rejected.ledger.verdicts.find(v => v.scope === 'PROVIDER');
      if (proposal?.outcome !== 'UNKNOWN' || proposal.assurance !== 'UNRESOLVED' ||
          proposal.evidence.unresolvedBoundary?.taxonomyCode !== 'EVIDENCE_VERIFICATION_FAILED' ||
          rejected.ledger.summary.violated !== 0 || !rejected.ledger.conservationReport.conservationSatisfied ||
          rejected.ledger.certificationStatus !== 'UNCERTIFIED_UNKNOWN') {
        throw new Error(`Producer claim escaped verification: ${assurance}/${checkerMode}`);
      }
    }
  }
  console.log('✓ Test 7 passed: missing, rejecting and throwing checkers cannot certify producer claims.');

  const compilerAdapter = new MockGenericLanguageAdapter();
  const compilerEvaluate = compilerAdapter.evaluateObligation.bind(compilerAdapter);
  compilerAdapter.evaluateObligation = async (obligation, repository) => {
    const route = await compilerEvaluate(obligation, repository);
    return route.assurance === 'COMPILER_STATIC' ? { ...route, outcome: 'VIOLATED' } : route;
  };
  const compilerCore = new ProductionVerificationCore();
  compilerCore.registerAdapter(compilerAdapter);
  const compilerResult = await compilerCore.verifyRepository(repo);
  if (compilerResult.ledger.summary.violated !== 2 || compilerResult.ledger.certificationStatus !== 'UNCERTIFIED_UNKNOWN' ||
      compilerResult.authoritativeVerdict.verdict !== 'UNKNOWN') {
    throw new Error('Compiler findings must remain visible without being promoted to verified F0/witness certification');
  }
  console.log('✓ Test 8 passed: compiler violation claims remain findings, not independently verified certificates.');

  console.log('\nAll generic production verification core tests PASSED!');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
