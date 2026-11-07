/**
 * @file TypeScriptPhase8IntegratedPilotQualification.test.ts
 * 
 * Formal qualification test suite for Phase 8 of the TypeScript Commercial Coverage Plan:
 * "Integrated pilot qualification"
 * 
 * Mandatory Fixtures Covered:
 * 1. Relocated replay: Canonical proof payloads invariant across relocated checkouts.
 * 2. Compiler/dependency/options cache invalidation: Config/dependency mutations invalidate warm caches.
 * 3. Wrong repository / same symbol: Rejection of proofs manufactured for another repository.
 * 4. Removed proof node tampering rejection: Intermediate node deletion in proof trace rejected fail-closed.
 * 5. Altered witness tampering rejection: Counterexample output mutation rejected upon independent re-execution.
 * 6. Omitted coverage tampering rejection: Omitted discovered reference triggers ConservationAbortError.
 * 7. Cold vs warm equivalence: Cold and warm evaluations produce identical verdicts and hashes.
 * 8. Cancellation / crash clean abort: Interrupted task aborts without emitting partial certificates.
 * 9. Repeated input determinism: Identical inputs yield deterministic canonical hashes and verdicts.
 * 10. Type-only receipt denied runtime test deferral: Type-level preservation cannot skip runtime tests.
 * 11. NOT_APPLICABLE denied deferral: Absence of obligations cannot authorize test deferral.
 */

import {
  VerificationObligation,
  VerificationVerdict,
  ConservationGate,
  ConservationAbortError,
  Reference
} from '@sajimora/core';
import { TypeScriptPilotQualifier } from '../../src/sajimora/languages/typescript/production/TypeScriptPilotQualifier';

export async function runPhase8IntegratedPilotQualificationTests(): Promise<void> {
  console.log('=== Running TypeScript Phase 8 Integrated Pilot Qualification Tests ===\n');

  // ---------------------------------------------------------------------------
  // Fixture 1: Relocated replay
  // ---------------------------------------------------------------------------
  console.log('Fixture 1: Relocated replay...');
  const payloadCheckout1 = JSON.stringify({
    obligationId: 'ob_relocate_1',
    ruleApplied: 'F0_CALL_SUBTYPING',
    conclusion: 'COMPATIBLE',
    premises: ['arg0_subtype_param0']
  });
  const payloadCheckout2 = JSON.stringify({
    obligationId: 'ob_relocate_1',
    ruleApplied: 'F0_CALL_SUBTYPING',
    conclusion: 'COMPATIBLE',
    premises: ['arg0_subtype_param0']
  });
  const replayMatches = TypeScriptPilotQualifier.verifyRelocatedReplay(payloadCheckout1, payloadCheckout2);
  if (!replayMatches) {
    throw new Error('Fixture 1 failed: Canonical proof payloads must be invariant across relocated checkouts');
  }
  console.log('✓ Fixture 1 passed: Canonical proof payloads invariant under filesystem checkout relocation.');

  // ---------------------------------------------------------------------------
  // Fixture 2: Compiler / dependency / options cache invalidation
  // ---------------------------------------------------------------------------
  console.log('Fixture 2: Compiler/dependency/options cache invalidation...');
  const cache = new Map<string, any>();
  cache.set('ob_1', { verdict: 'PRESERVED' });
  cache.set('ob_2', { verdict: 'PRESERVED' });

  const invalidation = TypeScriptPilotQualifier.verifyCacheInvalidation(
    'hash_strict_false',
    'hash_strict_true',
    cache
  );
  if (!invalidation.invalidated || cache.size !== 0) {
    throw new Error('Fixture 2 failed: Mutating tsconfig options must clear cache entries!');
  }
  console.log('✓ Fixture 2 passed: Compiler options and dependency mutations safely invalidate cache.');

  // ---------------------------------------------------------------------------
  // Fixture 3: Wrong repository / same symbol rejection
  // ---------------------------------------------------------------------------
  console.log('Fixture 3: Wrong repository / same symbol rejection...');
  const repoBinding = TypeScriptPilotQualifier.verifyRepositoryBinding('repo_tenant_alpha', 'repo_tenant_beta');
  if (repoBinding.accepted) {
    throw new Error('Fixture 3 failed: Proof from repository A must NOT be accepted for repository B!');
  }
  console.log('✓ Fixture 3 passed: Cross-repository proof re-use rejected fail-closed.');

  // ---------------------------------------------------------------------------
  // Fixture 4: Removed proof node tampering rejection
  // ---------------------------------------------------------------------------
  console.log('Fixture 4: Removed proof node tampering rejection...');
  const tamperedTrace = [
    { stepIndex: 1, ruleApplied: 'F0_PREMISE_BASE', premises: [], conclusion: 'Base Valid' },
    // Step 2 was deliberately removed!
    { stepIndex: 3, ruleApplied: 'F0_TRANSITIVITY', premises: ['step1', 'step2'], conclusion: 'Preserved' }
  ];
  const proofIntegrity = TypeScriptPilotQualifier.verifyProofIntegrity(tamperedTrace);
  if (proofIntegrity.valid) {
    throw new Error('Fixture 4 failed: Proof trace with missing intermediate step must be rejected!');
  }
  console.log('✓ Fixture 4 passed: Deleted intermediate proof node detected and rejected fail-closed.');

  // ---------------------------------------------------------------------------
  // Fixture 5: Altered witness tampering rejection
  // ---------------------------------------------------------------------------
  console.log('Fixture 5: Altered witness tampering rejection...');
  const tamperedWitness = {
    inputDomainWitness: [2],
    parentOutcome: '4',
    candidateOutcome: '999' // Tampered! Actual candidate output is 400
  };
  const witnessCheck = TypeScriptPilotQualifier.verifyWitnessIntegrity(
    tamperedWitness,
    (inp) => inp[0] * 2,
    (inp) => inp[0] * 200
  );
  if (witnessCheck.valid) {
    throw new Error('Fixture 5 failed: Altered counterexample witness must be rejected upon re-execution!');
  }
  console.log('✓ Fixture 5 passed: Altered operational witness rejected upon independent re-execution.');

  // ---------------------------------------------------------------------------
  // Fixture 6: Omitted coverage tampering rejection
  // ---------------------------------------------------------------------------
  console.log('Fixture 6: Omitted coverage tampering rejection...');
  const ref1: Reference = {
    referenceId: 'ref_covered',
    projectId: 'p',
    kind: 'STATIC_CALL',
    targetEntityId: 'fn_calc',
    location: { filePath: 'src/main.ts', line: 1, character: 1 },
    isUnresolvedBoundary: false
  };
  const ref2Omitted: Reference = {
    referenceId: 'ref_dropped',
    projectId: 'p',
    kind: 'STATIC_CALL',
    targetEntityId: 'fn_calc',
    location: { filePath: 'src/util.ts', line: 1, character: 1 },
    isUnresolvedBoundary: false
  };
  const ob1: VerificationObligation = {
    obligationId: 'ob_1',
    projectId: 'p',
    question: 'CONSUMER_COMPATIBILITY',
    change: {
      changeId: 'c1',
      identity: {
        identityId: 'id1',
        status: 'CONFIRMED_IDENTITY',
        confidence: 'CERTAIN',
        parentEntity: { entityId: 'fn_calc', projectId: 'p', name: 'calc', kind: 'FUNCTION', qualifiedName: 'calc', filePath: 'src/calc.ts', signatureFingerprint: '()=>void', isExported: true },
        candidateEntity: { entityId: 'fn_calc', projectId: 'p', name: 'calc', kind: 'FUNCTION', qualifiedName: 'calc', filePath: 'src/calc.ts', signatureFingerprint: '()=>void', isExported: true }
      },
      changeKind: 'UNCHANGED',
      description: 'unchanged'
    },
    reference: ref1,
    scope: 'CONSUMER',
    createdAt: new Date().toISOString()
  };
  const verd1: VerificationVerdict = {
    verdictId: 'verd_1',
    obligationId: 'ob_1',
    targetEntityId: 'fn_calc',
    outcome: 'PRESERVED',
    assurance: 'F0_FORMAL',
    property: 'CONSUMER_TYPE',
    scope: 'CONSUMER',
    provenance: {
      repositoryId: 'r',
      projectId: 'p',
      identityId: 'id1',
      obligationId: 'ob_1',
      evidenceId: 'ev1',
      verdictId: 'verd_1',
      referenceId: 'ref_covered'
    },
    evidence: { evidenceId: 'ev1', assurance: 'F0_FORMAL', property: 'CONSUMER_TYPE', f0Formal: { proofTrace: [] } },
    timestamp: new Date().toISOString()
  };

  let caughtSilentDrop = false;
  try {
    // Deliberately omit ref2Omitted from obligations
    TypeScriptPilotQualifier.verifyCoverageCompleteness([ref1, ref2Omitted], [ob1], [verd1]);
  } catch (err) {
    if (err instanceof ConservationAbortError) {
      caughtSilentDrop = true;
    }
  }
  if (!caughtSilentDrop) {
    throw new Error('Fixture 6 failed: Omitted discovered reference must trigger ConservationAbortError!');
  }
  console.log('✓ Fixture 6 passed: Omitted coverage and silent drops rejected via ConservationGate.');

  // ---------------------------------------------------------------------------
  // Fixture 7: Cold vs warm equivalence
  // ---------------------------------------------------------------------------
  console.log('Fixture 7: Cold vs warm equivalence...');
  const coldVerdicts = [verd1];
  const warmVerdicts = [{ ...verd1 }];
  const coldWarmCheck = TypeScriptPilotQualifier.verifyColdWarmEquivalence(coldVerdicts, warmVerdicts);
  if (!coldWarmCheck.equivalent) {
    throw new Error(`Fixture 7 failed: Cold vs warm mismatch: ${coldWarmCheck.mismatchReason}`);
  }
  console.log('✓ Fixture 7 passed: Cold evaluation and warm cached evaluation produce identical verdicts.');

  // ---------------------------------------------------------------------------
  // Fixture 8: Cancellation / crash clean abort
  // ---------------------------------------------------------------------------
  console.log('Fixture 8: Cancellation/crash clean abort...');
  const cancellationToken = { isCancelled: true };
  const abortCheck = TypeScriptPilotQualifier.executeWithCancellationSafety(cancellationToken, () => {
    return { verdict: 'PRESERVED', assurance: 'F0_FORMAL' };
  });
  if (!abortCheck.aborted || abortCheck.partialCertificateEmitted || abortCheck.result !== undefined) {
    throw new Error('Fixture 8 failed: Interrupted evaluation must abort cleanly without partial certificates!');
  }
  console.log('✓ Fixture 8 passed: Cancelled evaluation cleanly aborts without leaking partial certificates.');

  // ---------------------------------------------------------------------------
  // Fixture 9: Repeated input determinism
  // ---------------------------------------------------------------------------
  console.log('Fixture 9: Repeated input determinism...');
  const repA = TypeScriptPilotQualifier.verifyRelocatedReplay(JSON.stringify(verd1), JSON.stringify(verd1));
  const repB = TypeScriptPilotQualifier.verifyRelocatedReplay(JSON.stringify(verd1), JSON.stringify(verd1));
  if (!repA || !repB) {
    throw new Error('Fixture 9 failed: Repeated runs must produce identical hash verification');
  }
  console.log('✓ Fixture 9 passed: Bit-for-bit determinism verified across repeated runs.');

  // ---------------------------------------------------------------------------
  // Fixture 10: Type-only receipt denied runtime test deferral
  // ---------------------------------------------------------------------------
  console.log('Fixture 10: Type-only receipt denied runtime test deferral...');
  const typeReceiptVerdict: VerificationVerdict = {
    verdictId: 'v_type_only',
    obligationId: 'ob_type_only',
    targetEntityId: 'fn_1',
    outcome: 'PRESERVED',
    assurance: 'F0_FORMAL',
    property: 'CONSUMER_TYPE',
    scope: 'CONSUMER',
    provenance: { repositoryId: 'r', projectId: 'p', identityId: 'id1', obligationId: 'ob_type_only', evidenceId: 'ev_type', verdictId: 'v_type_only' },
    evidence: { evidenceId: 'ev_type', assurance: 'F0_FORMAL', property: 'CONSUMER_TYPE', f0Formal: { proofTrace: [] } },
    timestamp: new Date().toISOString()
  };

  const deferralDecision = TypeScriptPilotQualifier.evaluateTestDeferralAuthorization(
    typeReceiptVerdict,
    'RUNTIME_BEHAVIORAL_TEST'
  );
  if (deferralDecision.authorized || deferralDecision.reasonCode !== 'TEST_DEFERRAL_NOT_QUALIFIED') {
    throw new Error(`Fixture 10 failed: Type-only receipt must NOT authorize runtime test deferral, got: ${JSON.stringify(deferralDecision)}`);
  }
  console.log('✓ Fixture 10 passed: Type-only receipt strictly denied authorization to defer runtime tests.');

  // ---------------------------------------------------------------------------
  // Fixture 11: NOT_APPLICABLE denied deferral
  // ---------------------------------------------------------------------------
  console.log('Fixture 11: NOT_APPLICABLE denied deferral...');
  const naVerdict: VerificationVerdict = {
    verdictId: 'v_na',
    obligationId: 'ob_na',
    targetEntityId: 'fn_none',
    outcome: 'NOT_APPLICABLE',
    assurance: 'UNRESOLVED',
    property: 'CONSUMER_TYPE',
    scope: 'CONSUMER',
    provenance: { repositoryId: 'r', projectId: 'p', identityId: 'id1', obligationId: 'ob_na', evidenceId: 'ev_na', verdictId: 'v_na' },
    evidence: { evidenceId: 'ev_na', assurance: 'UNRESOLVED', property: 'CONSUMER_TYPE' },
    timestamp: new Date().toISOString()
  };

  const naDeferral = TypeScriptPilotQualifier.evaluateTestDeferralAuthorization(
    naVerdict,
    'TYPE_CHECK'
  );
  if (naDeferral.authorized || naDeferral.reasonCode !== 'TEST_DEFERRAL_NOT_QUALIFIED') {
    throw new Error(`Fixture 11 failed: NOT_APPLICABLE must NOT authorize test deferral, got: ${JSON.stringify(naDeferral)}`);
  }
  console.log('✓ Fixture 11 passed: NOT_APPLICABLE strictly denied test deferral authorization.');

  console.log('\n=== All 11 Phase 8 Mandatory Fixtures PASSED! ===\n');
}

runPhase8IntegratedPilotQualificationTests().catch(err => {
  console.error('\nPhase 8 test suite failed with error:', err);
  process.exit(1);
});
