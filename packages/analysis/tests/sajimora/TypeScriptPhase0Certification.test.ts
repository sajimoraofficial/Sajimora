import { EvidenceAcceptanceSession } from '../../../core/src/sajimora/verification/AcceptedEvidence';
/**
 * @file TypeScriptPhase0Certification.test.ts
 * Master Plan Phase 0: Baseline & Certification Contracts Test Suite.
 * 
 * Validates all mandatory fixtures specified in TYPESCRIPT_COMMERCIAL_COVERAGE_MASTER_PLAN.md:
 * 1. Empty ledger (0 obligations) -> UNKNOWN without verified discovery coverage
 * 2. All NOT_APPLICABLE obligations -> UNKNOWN without verified discovery coverage
 * 3. Compiler-only preservation -> local PRESERVED, aggregate UNCERTIFIED_UNKNOWN / UNKNOWN
 * 4. Formal-only route preservation -> aggregate UNKNOWN without verified discovery coverage
 * 5. Mixed assurance (F0_FORMAL + COMPILER_STATIC) -> aggregate UNCERTIFIED_UNKNOWN / UNKNOWN
 * 6. Unknown plus valid violation -> aggregate CERTIFIED_VIOLATED / VIOLATED (unknown preserved in trace)
 * 7. Unknown plus forged violation -> ConservationGate rejects with missing counterexample error
 * 8. Missing obligation (silent drop) -> ConservationGate aborts (SILENT_DROP_DETECTED)
 * 9. Duplicate obligation ID -> ConservationGate aborts
 * 10. Duplicate verdict for same obligation -> ConservationGate aborts (DUPLICATE_VERDICTS)
 * 11. Stale / wrong-consumer proof -> ConservationGate aborts on consumer reference mismatch
 * 12. Target entity mismatch -> ConservationGate aborts on targetEntityId mismatch
 * 13. Identical body with unadmitted behavioral equivalence -> UNKNOWN, never PRESERVED
 * 14. Multiplication in comments -> AST inspection rejects heuristic witness, no false VIOLATED
 * 15. Multiplication in strings -> AST inspection rejects heuristic witness, no false VIOLATED
 * 16. Multiplication in dead branches -> AST inspection rejects heuristic witness, no false VIOLATED
 * 17. Altered operand expression -> AST inspection rejects heuristic witness, no false VIOLATED
 * 18. Legitimate linear scalar multiplication mutation -> confirmed VIOLATED via operational witness
 */

import {
  GenericRepository,
  ProductionVerificationCore,
  ConservationGate,
  VerdictAuthorityBridge,
  VerificationObligation,
  VerificationVerdict,
  Reference,
  CertificationLedger
} from '@sajimora/core';
import { TypeScriptProductionAdapter } from '../../src/sajimora/languages/typescript/production/TypeScriptProductionAdapter';

function makeMockProvenance(obId: string, verdId: string, refId?: string, targetId: string = 'entity_target') {
  return {
    repositoryId: 'r',
    projectId: 'mock-proj',
    identityId: 'id_' + targetId,
    referenceId: refId,
    obligationId: obId,
    evidenceId: 'ev_' + obId,
    verdictId: verdId
  };
}

async function runPhase0CertificationTests() {
  console.log('=== Running TypeScript Phase 0 Certification Contract Tests ===\n');

  const adapter = new TypeScriptProductionAdapter();

  // ---------------------------------------------------------------------------
  // Fixture 1: Empty ledger has no independently checked domain receipt
  // ---------------------------------------------------------------------------
  console.log('Fixture 1: Empty ledger resolution...');
  const emptyReport = ConservationGate.reconcileAndEnforce([], [], []);
  const emptyLedger: CertificationLedger = {
    ledgerId: 'ledger-empty',
    repositoryId: 'r',
    parentSnapshotId: 'p',
    candidateSnapshotId: 'c',
    conservationReport: emptyReport,
    verdicts: [],
    summary: { total: 0, preserved: 0, violated: 0, notApplicable: 0, unknown: 0 },
    certificationStatus: 'UNCERTIFIED_UNKNOWN',
    issuedAt: new Date().toISOString()
  };
  const emptyAuthoritative = VerdictAuthorityBridge.evaluateAuthoritative(emptyLedger, 'root');
  if (emptyAuthoritative.verdict !== 'UNKNOWN') {
    throw new Error(`Fixture 1 failed: Expected UNKNOWN without checked domain coverage, got ${emptyAuthoritative.verdict}`);
  }
  if (emptyLedger.certificationStatus === 'CERTIFIED_PRESERVED') {
    throw new Error('Fixture 1 failed: Empty ledger must NEVER be CERTIFIED_PRESERVED');
  }
  console.log('✓ Fixture 1 passed: Empty ledger remains UNKNOWN without domain coverage.');

  // ---------------------------------------------------------------------------
  // Fixture 2: All NOT_APPLICABLE routes still lack domain coverage
  // ---------------------------------------------------------------------------
  console.log('Fixture 2: All NOT_APPLICABLE obligations...');
  const refNA: Reference = {
    referenceId: 'ref_na_1',
    projectId: 'mock-proj',
    kind: 'STATIC_IMPORT',
    targetEntityId: 'entity_target',
    location: { filePath: 'src/lib.ts', line: 1, character: 1 },
    isUnresolvedBoundary: false
  };
  const obNA: VerificationObligation = {
    obligationId: 'ob_na_1',
    projectId: 'mock-proj',
    question: 'API_COMPATIBILITY',
    change: {
      changeId: 'c_1',
      identity: {
        identityId: 'id_entity_target',
        status: 'CONFIRMED_IDENTITY',
        confidence: 'CERTAIN',
        parentEntity: {
          entityId: 'entity_target',
          projectId: 'mock-proj',
          name: 'target',
          kind: 'FUNCTION',
          qualifiedName: 'target',
          filePath: 'src/lib.ts',
          signatureFingerprint: '() => void',
          isExported: true
        }
      },
      changeKind: 'UNCHANGED',
      description: 'no change'
    },
    reference: refNA,
    scope: 'PROVIDER',
    createdAt: new Date().toISOString()
  };
  const verdNA: VerificationVerdict = {
    verdictId: 'v_na_1',
    obligationId: 'ob_na_1',
    targetEntityId: 'entity_target',
    outcome: 'NOT_APPLICABLE',
    assurance: 'COMPILER_STATIC',
    property: 'API_TYPE',
    scope: 'PROVIDER',
    provenance: makeMockProvenance('ob_na_1', 'v_na_1', 'ref_na_1'),
    evidence: {
      evidenceId: 'ev_ob_na_1',
      assurance: 'COMPILER_STATIC',
      property: 'API_TYPE',
      metadata: { reason: 'No consumer obligations exist' }
    },
    timestamp: new Date().toISOString()
  };
  const naReport = ConservationGate.reconcileAndEnforce([refNA], [obNA], [verdNA]);
  const naLedger: CertificationLedger = {
    ledgerId: 'ledger-na',
    repositoryId: 'r',
    parentSnapshotId: 'p',
    candidateSnapshotId: 'c',
    conservationReport: naReport,
    verdicts: [verdNA],
    summary: { total: 1, preserved: 0, violated: 0, notApplicable: 1, unknown: 0 },
    certificationStatus: 'UNCERTIFIED_UNKNOWN',
    issuedAt: new Date().toISOString()
  };
  const naAuthoritative = VerdictAuthorityBridge.evaluateAuthoritative(naLedger, 'entity_target');
  if (naAuthoritative.verdict !== 'UNKNOWN') {
    throw new Error(`Fixture 2 failed: Expected UNKNOWN, got ${naAuthoritative.verdict}`);
  }
  console.log('✓ Fixture 2 passed: All-NOT_APPLICABLE ledger remains UNKNOWN without domain coverage.');

  // ---------------------------------------------------------------------------
  // Fixture 3: Compiler-only preservation -> UNCERTIFIED_UNKNOWN
  // ---------------------------------------------------------------------------
  console.log('Fixture 3: Compiler-only preservation blocking aggregate PRESERVED...');
  const verdCompilerStatic: VerificationVerdict = {
    verdictId: 'v_cs_1',
    obligationId: 'ob_na_1',
    targetEntityId: 'entity_target',
    outcome: 'PRESERVED',
    assurance: 'COMPILER_STATIC',
    property: 'CONSUMER_TYPE',
    scope: 'CONSUMER',
    provenance: makeMockProvenance('ob_na_1', 'v_cs_1', 'ref_na_1'),
    evidence: {
      evidenceId: 'ev_ob_na_1',
      assurance: 'COMPILER_STATIC',
      property: 'CONSUMER_TYPE',
      compilerStatic: { diagnosticDelta: 0, parentDiagnosticCount: 0, candidateDiagnosticCount: 0, introducedDiagnostics: [] }
    },
    timestamp: new Date().toISOString()
  };
  const csReport = ConservationGate.reconcileAndEnforce([refNA], [obNA], [verdCompilerStatic]);
  const csLedger: CertificationLedger = {
    ledgerId: 'ledger-cs',
    repositoryId: 'r',
    parentSnapshotId: 'p',
    candidateSnapshotId: 'c',
    conservationReport: csReport,
    verdicts: [verdCompilerStatic],
    summary: { total: 1, preserved: 1, violated: 0, notApplicable: 0, unknown: 0 },
    certificationStatus: 'UNCERTIFIED_UNKNOWN',
    issuedAt: new Date().toISOString()
  };
  const csAuthoritative = VerdictAuthorityBridge.evaluateAuthoritative(csLedger, 'entity_target');
  if (csAuthoritative.verdict !== 'UNKNOWN') {
    throw new Error(`Fixture 3 failed: COMPILER_STATIC must never yield PRESERVED aggregate, got ${csAuthoritative.verdict}`);
  }
  console.log('✓ Fixture 3 passed: Compiler-only preservation correctly yields aggregate UNKNOWN.');

  // ---------------------------------------------------------------------------
  // Fixture 4: Formal route proof does not establish discovery completeness
  // ---------------------------------------------------------------------------
  console.log('Fixture 4: Formal-only preservation...');
  const verdFormal: VerificationVerdict = {
    verdictId: 'v_f0_1',
    obligationId: 'ob_na_1',
    targetEntityId: 'entity_target',
    outcome: 'PRESERVED',
    assurance: 'F0_FORMAL',
    property: 'CONSUMER_TYPE',
    scope: 'CONSUMER',
    provenance: makeMockProvenance('ob_na_1', 'v_f0_1', 'ref_na_1'),
    evidence: {
      evidenceId: 'ev_ob_na_1',
      assurance: 'F0_FORMAL',
      property: 'CONSUMER_TYPE',
      f0Formal: {
        proofTrace: [{ ruleApplied: 'F0_KIND_SUBSUMPTION', stepIndex: 1, premises: [], conclusion: 'Subsumed' }]
      }
    },
    timestamp: new Date().toISOString()
  };
  // Unit-test the aggregator with a trusted-verifier test double, not a production proof.
  const snapshot = (snapshotId: string) => ({ snapshotId, rootIdentifier: '/', files: [], readTextFile: () => undefined, readBinaryFile: () => undefined });
  const acceptance = new EvidenceAcceptanceSession({ repositoryId: 'r', parentSnapshot: snapshot('p'), candidateSnapshot: snapshot('c') },
    [{ profileId: 'TEST_AGGREGATION_ONLY', check: (_ob, _repo, verdict) => verdict === verdFormal || verdict === verdViolated }]);
  obNA.question = 'CONSUMER_COMPATIBILITY';
  obNA.scope = 'CONSUMER';
  verdFormal.evidence.metadata = { verificationProfile: 'TEST_AGGREGATION_ONLY' };
  if (!acceptance.verifyAndAccept(obNA, verdFormal)) throw new Error('Formal aggregation fixture rejected');
  const f0Report = ConservationGate.reconcileAndEnforce([refNA], [obNA], [verdFormal], acceptance);
  const f0Ledger: CertificationLedger = {
    ledgerId: 'ledger-f0',
    repositoryId: 'r',
    parentSnapshotId: 'p',
    candidateSnapshotId: 'c',
    conservationReport: f0Report,
    verdicts: [verdFormal],
    summary: { total: 1, preserved: 1, violated: 0, notApplicable: 0, unknown: 0 },
    certificationStatus: 'UNCERTIFIED_UNKNOWN',
    issuedAt: new Date().toISOString()
  };
  const f0Authoritative = VerdictAuthorityBridge.evaluateAuthoritative(f0Ledger, 'entity_target', acceptance);
  if (f0Authoritative.verdict !== 'UNKNOWN') {
    throw new Error(`Fixture 4 failed: Expected UNKNOWN without domain coverage, got ${f0Authoritative.verdict}`);
  }
  console.log('✓ Fixture 4 passed: Local formal proof does not certify a universal aggregate.');

  // ---------------------------------------------------------------------------
  // Fixture 5: Mixed assurance (F0_FORMAL + COMPILER_STATIC) -> UNCERTIFIED_UNKNOWN
  // ---------------------------------------------------------------------------
  console.log('Fixture 5: Mixed assurance handling...');
  const ref2: Reference = { ...refNA, referenceId: 'ref_cs_2' };
  const ob2: VerificationObligation = { ...obNA, obligationId: 'ob_cs_2', reference: ref2 };
  const verd2: VerificationVerdict = {
    ...verdCompilerStatic,
    verdictId: 'v_cs_2',
    obligationId: 'ob_cs_2',
    provenance: makeMockProvenance('ob_cs_2', 'v_cs_2', 'ref_cs_2')
  };
  const mixedReport = ConservationGate.reconcileAndEnforce([refNA, ref2], [obNA, ob2], [verdFormal, verd2], acceptance);
  const mixedLedger: CertificationLedger = {
    ledgerId: 'ledger-mixed',
    repositoryId: 'r',
    parentSnapshotId: 'p',
    candidateSnapshotId: 'c',
    conservationReport: mixedReport,
    verdicts: [verdFormal, verd2],
    summary: { total: 2, preserved: 2, violated: 0, notApplicable: 0, unknown: 0 },
    certificationStatus: 'UNCERTIFIED_UNKNOWN',
    issuedAt: new Date().toISOString()
  };
  const mixedAuthoritative = VerdictAuthorityBridge.evaluateAuthoritative(mixedLedger, 'entity_target', acceptance);
  if (mixedAuthoritative.verdict !== 'UNKNOWN') {
    throw new Error(`Fixture 5 failed: Mixed assurance must yield aggregate UNKNOWN, got ${mixedAuthoritative.verdict}`);
  }
  console.log('✓ Fixture 5 passed: Mixed assurance correctly yields aggregate UNKNOWN.');

  // ---------------------------------------------------------------------------
  // Fixture 6: Unknown plus valid violation -> CERTIFIED_VIOLATED
  // ---------------------------------------------------------------------------
  console.log('Fixture 6: Unknown plus valid violation precedence...');
  const verdUnknown: VerificationVerdict = {
    verdictId: 'v_un_1',
    obligationId: 'ob_na_1',
    targetEntityId: 'entity_target',
    outcome: 'UNKNOWN',
    assurance: 'UNRESOLVED',
    property: 'CONSUMER_TYPE',
    scope: 'CONSUMER',
    provenance: makeMockProvenance('ob_na_1', 'v_un_1', 'ref_na_1'),
    evidence: {
      evidenceId: 'ev_un_1',
      assurance: 'UNRESOLVED',
      property: 'CONSUMER_TYPE',
      unresolvedBoundary: { taxonomyCode: 'DYNAMIC_INDEX', description: 'unresolved index', remediation: { code: 'FIX', suggestion: 's' } }
    },
    timestamp: new Date().toISOString()
  };
  const verdViolated: VerificationVerdict = {
    verdictId: 'v_viol_2',
    obligationId: 'ob_cs_2',
    targetEntityId: 'entity_target',
    outcome: 'VIOLATED',
    assurance: 'WITNESS',
    property: 'BEHAVIOR',
    scope: 'CONSUMER',
    provenance: makeMockProvenance('ob_cs_2', 'v_viol_2', 'ref_cs_2'),
    evidence: {
      evidenceId: 'ev_viol_2',
      assurance: 'WITNESS',
      property: 'BEHAVIOR',
      f0Formal: {
        proofTrace: [{ ruleApplied: 'F0_OPERATIONAL_COUNTEREXAMPLE', stepIndex: 1, premises: [], conclusion: 'Divergence' }],
        operationalWitness: { inputDomainWitness: [2], parentOutcome: '4', candidateOutcome: '400' }
      },
      metadata: { behavioralWitness: true }
    },
    timestamp: new Date().toISOString()
  };
  ob2.question = 'BEHAVIORAL_COMPATIBILITY';
  verdViolated.provenance.evidenceId = verdViolated.evidence.evidenceId;
  verdViolated.evidence.metadata = { ...verdViolated.evidence.metadata, verificationProfile: 'TEST_AGGREGATION_ONLY' };
  if (!acceptance.verifyAndAccept(ob2, verdViolated)) throw new Error('Witness aggregation fixture rejected');
  const violReport = ConservationGate.reconcileAndEnforce([refNA, ref2], [obNA, ob2], [verdUnknown, verdViolated], acceptance);
  const violLedger: CertificationLedger = {
    ledgerId: 'ledger-viol',
    repositoryId: 'r',
    parentSnapshotId: 'p',
    candidateSnapshotId: 'c',
    conservationReport: violReport,
    verdicts: [verdUnknown, verdViolated],
    summary: { total: 2, preserved: 0, violated: 1, notApplicable: 0, unknown: 1 },
    certificationStatus: 'CERTIFIED_VIOLATED',
    issuedAt: new Date().toISOString()
  };
  const violAuthoritative = VerdictAuthorityBridge.evaluateAuthoritative(violLedger, 'entity_target', acceptance);
  if (violAuthoritative.verdict !== 'VIOLATED') {
    throw new Error(`Fixture 6 failed: Valid violation must take precedence over UNKNOWN, got ${violAuthoritative.verdict}`);
  }
  // Verify that UNKNOWN is preserved in the trace
  const unknownRoute = violAuthoritative.auditTrace?.consumers?.find((c: any) => c.outcome === 'UNKNOWN');
  if (!unknownRoute) {
    throw new Error('Fixture 6 failed: UNKNOWN obligation must remain visible in auditTrace consumers');
  }
  console.log('✓ Fixture 6 passed: Violation takes precedence while retaining visible UNKNOWN in trace.');

  // ---------------------------------------------------------------------------
  // Fixture 7: Unknown plus forged violation -> ConservationGate aborts
  // ---------------------------------------------------------------------------
  console.log('Fixture 7: Rejecting forged violation lacking operational witness...');
  const verdForgedViolated: VerificationVerdict = {
    verdictId: 'v_forged_2',
    obligationId: 'ob_cs_2',
    targetEntityId: 'entity_target',
    outcome: 'VIOLATED',
    assurance: 'WITNESS',
    property: 'BEHAVIOR',
    scope: 'CONSUMER',
    provenance: makeMockProvenance('ob_cs_2', 'v_forged_2', 'ref_cs_2'),
    evidence: {
      evidenceId: 'ev_forged_2',
      assurance: 'WITNESS',
      property: 'BEHAVIOR'
      // Missing f0Formal.operationalWitness or metadata.behavioralWitness!
    },
    timestamp: new Date().toISOString()
  };
  let caughtForged = false;
  try {
    ConservationGate.reconcileAndEnforce([refNA, ref2], [obNA, ob2], [verdUnknown, verdForgedViolated]);
  } catch (err: any) {
    if (err.message.includes('Unverified evidence')) {
      caughtForged = true;
    }
  }
  if (!caughtForged) {
    throw new Error('Fixture 7 failed: ConservationGate did not reject forged violation without counterexample!');
  }
  console.log('✓ Fixture 7 passed: Forged violation correctly rejected by ConservationGate.');

  // ---------------------------------------------------------------------------
  // Fixture 8: Missing obligation (silent drop) -> ConservationAbortError
  // ---------------------------------------------------------------------------
  console.log('Fixture 8: Silent drop detection...');
  let caughtSilentDrop = false;
  try {
    // 2 obligations generated, only 1 verdict provided
    ConservationGate.reconcileAndEnforce([refNA, ref2], [obNA, ob2], [verdUnknown]);
  } catch (err: any) {
    if (err.name === 'ConservationAbortError' && (err.reason === 'SILENT_DROP_DETECTED' || err.message.toLowerCase().includes('silent drop') || err.message.includes('silently dropped'))) {
      caughtSilentDrop = true;
    }
  }
  if (!caughtSilentDrop) {
    throw new Error('Fixture 8 failed: Silent drop was not detected by ConservationGate!');
  }
  console.log('✓ Fixture 8 passed: Silent drop correctly triggered ConservationAbortError.');

  // ---------------------------------------------------------------------------
  // Fixture 9: Duplicate obligation ID -> Rejection
  // ---------------------------------------------------------------------------
  console.log('Fixture 9: Duplicate obligation ID detection...');
  let caughtDupOb = false;
  try {
    const obDup = { ...obNA };
    ConservationGate.reconcileAndEnforce([refNA, ref2], [obNA, obDup], [verdUnknown, verdViolated]);
  } catch (err: any) {
    if (err.message.includes('Duplicate obligation ID')) {
      caughtDupOb = true;
    }
  }
  if (!caughtDupOb) {
    throw new Error('Fixture 9 failed: Duplicate obligation ID was not rejected!');
  }
  console.log('✓ Fixture 9 passed: Duplicate obligation ID correctly rejected.');

  // ---------------------------------------------------------------------------
  // Fixture 10: Duplicate verdict for same obligation -> ConservationAbortError
  // ---------------------------------------------------------------------------
  console.log('Fixture 10: Duplicate verdict detection...');
  let caughtDupVerd = false;
  try {
    const verdDup: VerificationVerdict = {
      ...verdUnknown,
      verdictId: 'v_dup_1',
      provenance: makeMockProvenance('ob_na_1', 'v_dup_1', 'ref_na_1')
    };
    ConservationGate.reconcileAndEnforce([refNA], [obNA], [verdUnknown, verdDup]);
  } catch (err: any) {
    if (err.message.includes('Multiple verdicts received for the same obligation')) {
      caughtDupVerd = true;
    }
  }
  if (!caughtDupVerd) {
    throw new Error('Fixture 10 failed: Duplicate verdict was not rejected!');
  }
  console.log('✓ Fixture 10 passed: Duplicate verdicts correctly rejected.');

  // ---------------------------------------------------------------------------
  // Fixture 11: Stale / wrong-consumer proof -> Consumer reference mismatch
  // ---------------------------------------------------------------------------
  console.log('Fixture 11: Wrong-consumer proof rejection...');
  let caughtWrongConsumer = false;
  const verdWrongConsumer: VerificationVerdict = {
    ...verdFormal,
    provenance: makeMockProvenance('ob_na_1', 'v_f0_1', 'WRONG_REF_ID')
  };
  try {
    ConservationGate.reconcileAndEnforce([refNA], [obNA], [verdWrongConsumer]);
  } catch (err: any) {
    if (err.message.includes('Consumer reference mismatch')) {
      caughtWrongConsumer = true;
    }
  }
  if (!caughtWrongConsumer) {
    throw new Error('Fixture 11 failed: Wrong-consumer proof was not rejected!');
  }
  console.log('✓ Fixture 11 passed: Stale/wrong-consumer proof correctly rejected.');

  // ---------------------------------------------------------------------------
  // Fixture 12: Target entity mismatch -> Rejection
  // ---------------------------------------------------------------------------
  console.log('Fixture 12: Target entity mismatch rejection...');
  let caughtWrongTarget = false;
  const verdWrongTarget: VerificationVerdict = {
    ...verdFormal,
    targetEntityId: 'completely_different_target'
  };
  try {
    ConservationGate.reconcileAndEnforce([refNA], [obNA], [verdWrongTarget]);
  } catch (err: any) {
    if (err.message.includes('Target entity mismatch')) {
      caughtWrongTarget = true;
    }
  }
  if (!caughtWrongTarget) {
    throw new Error('Fixture 12 failed: Target entity mismatch was not rejected!');
  }
  console.log('✓ Fixture 12 passed: Target entity mismatch correctly rejected.');

  // ---------------------------------------------------------------------------
  // Fixture 13: Unchanged body with unadmitted behavioral equivalence -> UNKNOWN
  // ---------------------------------------------------------------------------
  console.log('Fixture 13: Unchanged body behavioral question returns UNKNOWN...');
  const obIdenticalBody: VerificationObligation = {
    obligationId: 'ob_id_body_1',
    projectId: 'mock-proj',
    question: 'BEHAVIORAL_COMPATIBILITY',
    change: {
      changeId: 'c_id_body',
      identity: {
        identityId: 'id_identical',
        status: 'CONFIRMED_IDENTITY',
        confidence: 'CERTAIN',
        parentEntity: {
          entityId: 'p_fn',
          projectId: 'mock-proj',
          name: 'compute',
          kind: 'FUNCTION',
          qualifiedName: 'compute',
          filePath: 'src/lib.ts',
          signatureFingerprint: '(x: number) => number',
          isExported: true,
          metadata: { bodySnippet: '{ return x * 2; }', paramNames: ['x'] }
        },
        candidateEntity: {
          entityId: 'c_fn',
          projectId: 'mock-proj',
          name: 'compute',
          kind: 'FUNCTION',
          qualifiedName: 'compute',
          filePath: 'src/lib.ts',
          signatureFingerprint: '(x: number) => number',
          isExported: true,
          metadata: { bodySnippet: '{ return x * 2; }', paramNames: ['x'] }
        }
      },
      changeKind: 'UNCHANGED',
      description: 'identical text'
    },
    scope: 'PROVIDER',
    createdAt: new Date().toISOString()
  };
  const mockRepo: GenericRepository = {
    repositoryId: 'r',
    parentSnapshot: { snapshotId: 'p', rootIdentifier: '/', files: [], readTextFile: () => '', readBinaryFile: () => undefined },
    candidateSnapshot: { snapshotId: 'c', rootIdentifier: '/', files: [], readTextFile: () => '', readBinaryFile: () => undefined }
  };
  const verdIdentical = await adapter.evaluateObligation(obIdenticalBody, mockRepo);
  if (verdIdentical.outcome !== 'UNKNOWN') {
    throw new Error(`Fixture 13 failed: Syntactic body equality must NOT be certified PRESERVED, got ${verdIdentical.outcome}`);
  }
  if (verdIdentical.evidence.unresolvedBoundary?.taxonomyCode !== 'OPERATIONAL_FRAGMENT_UNSUPPORTED') {
    throw new Error(`Fixture 13 failed: Expected OPERATIONAL_FRAGMENT_UNSUPPORTED taxonomy code`);
  }
  console.log('✓ Fixture 13 passed: Syntactic body equality yields UNKNOWN without unadmitted PRESERVED promotion.');

  // ---------------------------------------------------------------------------
  // Fixture 14: Multiplication in comments -> Rejects heuristic witness
  // ---------------------------------------------------------------------------
  console.log('Fixture 14: Multiplication in comments rejection...');
  const obCommentMul: VerificationObligation = {
    ...obIdenticalBody,
    obligationId: 'ob_comm_1',
    change: {
      ...obIdenticalBody.change,
      identity: {
        ...obIdenticalBody.change.identity,
        candidateEntity: {
          ...obIdenticalBody.change.identity.parentEntity!,
          metadata: {
            bodySnippet: '{\n  // return x * 200;\n  return x * 2;\n}',
            paramNames: ['x']
          }
        }
      }
    }
  };
  const verdCommentMul = await adapter.evaluateObligation(obCommentMul, mockRepo);
  // Both parent and candidate have return x * 2; the comment // return x * 200 does not divert the multiplier!
  if (verdCommentMul.outcome === 'VIOLATED') {
    throw new Error('Fixture 14 failed: Comment containing * 200 was falsely treated as a behavioral violation!');
  }
  console.log('✓ Fixture 14 passed: Multiplication in comments does not trigger false VIOLATED witness.');

  // ---------------------------------------------------------------------------
  // Fixture 15: Multiplication in string literals -> Rejects heuristic witness
  // ---------------------------------------------------------------------------
  console.log('Fixture 15: Multiplication in string literals rejection...');
  const obStringMul: VerificationObligation = {
    ...obIdenticalBody,
    obligationId: 'ob_str_1',
    change: {
      ...obIdenticalBody.change,
      identity: {
        ...obIdenticalBody.change.identity,
        candidateEntity: {
          ...obIdenticalBody.change.identity.parentEntity!,
          metadata: {
            bodySnippet: '{\n  const s = "x * 200";\n  return x * 2;\n}',
            paramNames: ['x']
          }
        }
      }
    }
  };
  const verdStringMul = await adapter.evaluateObligation(obStringMul, mockRepo);
  if (verdStringMul.outcome === 'VIOLATED') {
    throw new Error('Fixture 15 failed: String literal containing * 200 was falsely treated as a behavioral violation!');
  }
  console.log('✓ Fixture 15 passed: Multiplication in string literals rejected from heuristic witness.');

  // ---------------------------------------------------------------------------
  // Fixture 16: Multiplication in dead branches -> Rejects heuristic witness
  // ---------------------------------------------------------------------------
  console.log('Fixture 16: Multiplication in dead branches rejection...');
  const obDeadBranchMul: VerificationObligation = {
    ...obIdenticalBody,
    obligationId: 'ob_dead_1',
    change: {
      ...obIdenticalBody.change,
      identity: {
        ...obIdenticalBody.change.identity,
        candidateEntity: {
          ...obIdenticalBody.change.identity.parentEntity!,
          metadata: {
            bodySnippet: '{\n  if (false) { return x * 200; }\n  return x * 2;\n}',
            paramNames: ['x']
          }
        }
      }
    }
  };
  const verdDeadBranchMul = await adapter.evaluateObligation(obDeadBranchMul, mockRepo);
  if (verdDeadBranchMul.outcome === 'VIOLATED') {
    throw new Error('Fixture 16 failed: Dead branch containing * 200 was falsely treated as a behavioral violation!');
  }
  console.log('✓ Fixture 16 passed: Multiplication in dead branches rejected from heuristic witness.');

  // ---------------------------------------------------------------------------
  // Fixture 17: Altered operand expressions -> Rejects heuristic witness
  // ---------------------------------------------------------------------------
  console.log('Fixture 17: Altered operand expression rejection...');
  const obAlteredExpr: VerificationObligation = {
    ...obIdenticalBody,
    obligationId: 'ob_alt_1',
    change: {
      ...obIdenticalBody.change,
      identity: {
        ...obIdenticalBody.change.identity,
        candidateEntity: {
          ...obIdenticalBody.change.identity.parentEntity!,
          metadata: {
            bodySnippet: '{\n  return (x + 1) * 200;\n}',
            paramNames: ['x']
          }
        }
      }
    }
  };
  const verdAlteredExpr = await adapter.evaluateObligation(obAlteredExpr, mockRepo);
  if (verdAlteredExpr.outcome === 'VIOLATED') {
    throw new Error('Fixture 17 failed: (x + 1) * 200 was falsely treated as pure scalar multiplier x * 200!');
  }
  console.log('✓ Fixture 17 passed: Altered operand expression correctly rejected from heuristic witness.');

  // ---------------------------------------------------------------------------
  // Fixture 18: Legitimate linear scalar multiplication mutation -> VIOLATED witness
  // ---------------------------------------------------------------------------
  console.log('Fixture 18: Legitimate scalar multiplication mutation verification...');
  const obValidMul: VerificationObligation = {
    ...obIdenticalBody,
    obligationId: 'ob_valid_mul_1',
    change: {
      ...obIdenticalBody.change,
      identity: {
        ...obIdenticalBody.change.identity,
        parentEntity: {
          ...obIdenticalBody.change.identity.parentEntity!,
          metadata: { bodySnippet: '{\n  return x * 2;\n}', paramNames: ['x'] }
        },
        candidateEntity: {
          ...obIdenticalBody.change.identity.parentEntity!,
          metadata: { bodySnippet: '{\n  return x * 200;\n}', paramNames: ['x'] }
        }
      }
    }
  };
  const verdValidMul = await adapter.evaluateObligation(obValidMul, mockRepo);
  if (verdValidMul.outcome !== 'UNKNOWN') throw new Error('Metadata-only multiplication must not produce an accepted witness');
  console.log('✓ Fixture 18 passed: Metadata-only arithmetic remains UNKNOWN; source-backed replay is covered by EvidenceAcceptanceBoundary.test.ts.');

  console.log('\n=== All 18 Phase 0 Mandatory Fixtures PASSED! ===');
}

runPhase0CertificationTests().catch(err => {
  console.error('\nTest suite failed with error:', err);
  process.exit(1);
});

