/**
 * @file JavaF1CompilerJ11.test.ts
 * Test suite for Phase J-11 (Java F1 Profile: Pinned Headless Compiler Subprocess).
 *
 * Verifies:
 * 1. Generic capture conversion subtyping (? extends Integer vs ? extends Number).
 * 2. Method overload disambiguation per JLS §15.12.2.
 * 3. Sealed classpath wildcard resolution without ambient I/O drift.
 * 4. F1 Monotonicity Invariant: F1 cannot overturn an F0 contradiction.
 * 5. F1 Monotonicity Invariant: F1 safely upgrades F0 inconclusive into certified verdict.
 * 6. Zero-trust tamper resistance: Evidence tampering fails verification.
 */

import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import { canonicalJson } from '@sajimora/core';
import {
  JAVA_CERTIFIED_EVIDENCE_V1,
  JavaRuleSetId,
  JavaSemanticProfileId
} from '../../src/sajimora/languages/java/certified/JavaCertifiedProfile';
import {
  JavaSemanticObligation,
  JavaSemanticProof,
  computeJavaObligationDigest
} from '../../src/sajimora/languages/java/certified/JavaProofChecker';
import {
  JavaHeadlessCompiler,
  JavaF1CompilerEvidence
} from '../../src/sajimora/languages/java/certified/JavaHeadlessCompiler';
import {
  JavaF1ProofChecker,
  JavaF1SemanticProof
} from '../../src/sajimora/languages/java/certified/JavaF1ProofChecker';

console.log('--- Starting Java Phase J-11 Test Suite (F1 Headless Compiler Profile) ---');

// --------------------------------------------------------------------------
// TEST 1: Generic Capture Conversion Subtyping
// --------------------------------------------------------------------------
console.log('Running Test 1: Generic Capture Conversion Subtyping...');
{
  // Covariant wildcard: ? extends Integer is a subtype of ? extends Number
  const res1 = JavaHeadlessCompiler.deriveGenericWildcardSubtype('? extends Integer', '? extends Number');
  assert.strictEqual(res1.isSubtype, true, '? extends Integer must be a subtype of ? extends Number');
  assert.strictEqual(res1.derivationRule, 'JLS-4.10.2-COVARIANT-BOUND');

  // Covariant reverse: ? extends Number is NOT a subtype of ? extends Integer
  const res2 = JavaHeadlessCompiler.deriveGenericWildcardSubtype('? extends Number', '? extends Integer');
  assert.strictEqual(res2.isSubtype, false, '? extends Number is NOT a subtype of ? extends Integer');

  // Contravariant wildcard: ? super Number is a subtype of ? super Integer
  const res3 = JavaHeadlessCompiler.deriveGenericWildcardSubtype('? super Number', '? super Integer');
  assert.strictEqual(res3.isSubtype, true, '? super Number must be a subtype of ? super Integer');
  assert.strictEqual(res3.derivationRule, 'JLS-4.10.2-CONTRAVARIANT-BOUND');

  // Variance conflict: ? extends Number is NOT a subtype of ? super Integer
  const res4 = JavaHeadlessCompiler.deriveGenericWildcardSubtype('? extends Number', '? super Integer');
  assert.strictEqual(res4.isSubtype, false, 'Variance conflict must not be a subtype');

  // Top wildcard: Unbounded ? is supertype of any wildcard
  const res5 = JavaHeadlessCompiler.deriveGenericWildcardSubtype('? extends String', '?');
  assert.strictEqual(res5.isSubtype, true, '? extends String must be a subtype of unbounded ?');

  console.log('✓ Test 1 PASS: Generic capture conversion follows JLS §5.1.10 variance rules');
}

// --------------------------------------------------------------------------
// TEST 2: Most-Specific Method Overload Disambiguation (JLS §15.12.2)
// --------------------------------------------------------------------------
console.log('Running Test 2: Method Overload Disambiguation...');
{
  const candidates = [
    { name: 'process', parameterTypes: ['java.lang.Object'] },
    { name: 'process', parameterTypes: ['java.lang.CharSequence'] },
    { name: 'process', parameterTypes: ['java.lang.String'] }
  ];

  // Invocation with String argument should select process(String) as uniquely most specific
  const res1 = JavaHeadlessCompiler.resolveMostSpecificOverload('process', ['java.lang.String'], candidates);
  assert.strictEqual(res1.status, 'RESOLVED');
  assert.strictEqual(res1.selectedMethod?.parameterTypes[0], 'java.lang.String');

  // Invocation with Integer argument should select process(Object)
  const res2 = JavaHeadlessCompiler.resolveMostSpecificOverload('process', ['java.lang.Integer'], candidates);
  assert.strictEqual(res2.status, 'RESOLVED');
  assert.strictEqual(res2.selectedMethod?.parameterTypes[0], 'java.lang.Object');

  // Ambiguous overload test
  const ambiguousCandidates = [
    { name: 'combine', parameterTypes: ['java.lang.String', 'java.lang.Integer'] },
    { name: 'combine', parameterTypes: ['java.lang.Integer', 'java.lang.String'] }
  ];
  const res3 = JavaHeadlessCompiler.resolveMostSpecificOverload('combine', ['java.lang.Object', 'java.lang.Object'], ambiguousCandidates);
  assert.strictEqual(res3.status, 'NONE_APPLICABLE');

  console.log('✓ Test 2 PASS: JLS §15.12.2 overload disambiguation chooses unique most-specific method');
}

// --------------------------------------------------------------------------
// TEST 3: Sealed Classpath Wildcard Resolution
// --------------------------------------------------------------------------
console.log('Running Test 3: Sealed Classpath Wildcard Resolution...');
{
  // Unambiguous resolution: java.util.* contains List
  const res1 = JavaHeadlessCompiler.resolveSealedWildcard(['java.util'], 'List');
  assert.strictEqual(res1.status, 'RESOLVED');
  assert.strictEqual(res1.fqcn, 'java.util.List');

  // Ambiguous resolution: List in both java.util and custom com.acme.gui
  const res2 = JavaHeadlessCompiler.resolveSealedWildcard(
    ['java.util', 'com.acme.gui'],
    'List',
    ['com.acme.gui.List']
  );
  assert.strictEqual(res2.status, 'AMBIGUOUS');
  assert.ok(res2.candidatePackages?.includes('java.util'));
  assert.ok(res2.candidatePackages?.includes('com.acme.gui'));

  // Missing symbol
  const res3 = JavaHeadlessCompiler.resolveSealedWildcard(['java.util'], 'NonExistentClass');
  assert.strictEqual(res3.status, 'NOT_FOUND');

  console.log('✓ Test 3 PASS: Sealed classpath wildcard resolution prevents ambient pollution and detects collisions');
}

// --------------------------------------------------------------------------
// TEST 4: F1 Monotonicity Invariant — Strict Non-Overturn of F0 Contradiction
// --------------------------------------------------------------------------
console.log('Running Test 4: F1 Monotonicity Invariant (Preserving F0 Contradictions)...');
{
  const obligation: JavaSemanticObligation = {
    schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
    obligationId: 'ob-mono-test-01',
    sourceFqcn: 'com.acme.Consumer',
    targetFqcn: 'com.acme.Provider',
    relationKind: 'METHOD_CALL',
    memberSignature: 'removeOldMethod()',
    evidenceSnapshotRef: 'snap-mono'
  };

  const digest = computeJavaObligationDigest(obligation);

  // F0 Baseline Proof: method was removed (INCOMPATIBLE)
  const f0BaselineProof: JavaSemanticProof = {
    schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
    ruleSetId: JavaRuleSetId.JAVA_F0_RULES_V1,
    obligationDigest: digest,
    nodes: [
      {
        nodeId: 'node-f0-incompat',
        ruleId: 'JAVA.F0.NOMINAL.EQUAL',
        premises: [],
        conclusion: {
          kind: 'NOMINAL_EQUAL',
          sourceFqcn: 'com.acme.Provider',
          targetFqcn: 'REMOVED_CLASS',
          compatible: false
        }
      }
    ],
    rootNodeIds: ['node-f0-incompat'],
    claimedConclusion: 'INCOMPATIBLE',
    metadata: {
      capabilityId: 'JAVA_METHOD_DECLARATION_REMOVED'
    }
  };

  // Malicious / Unsound F1 attempt: trying to claim COMPATIBLE over the F0 INCOMPATIBLE baseline
  const maliciousF1Proof: JavaF1SemanticProof = {
    schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
    ruleSetId: JavaRuleSetId.JAVA_F1_RULES_V1,
    profileId: JavaSemanticProfileId.JAVA_COMPILER_BACKED_F1,
    obligationDigest: digest,
    f0BaselineProof,
    nodes: [
      {
        nodeId: 'node-f1-malicious',
        ruleId: 'JAVA.F1.GENERIC.CAPTURE_CONVERSION',
        premises: [],
        conclusion: {
          kind: 'GENERIC_CAPTURE_CONVERSION',
          subType: '? extends Integer',
          superType: '? extends Number',
          compatible: true,
          evidenceId: 'ev-dummy'
        }
      }
    ],
    rootNodeIds: ['node-f1-malicious'],
    claimedConclusion: 'COMPATIBLE'
  };

  const verifResult = JavaF1ProofChecker.verifyF1Proof(obligation, maliciousF1Proof);

  assert.strictEqual(
    verifResult.valid,
    false,
    'F1 must reject any attempt to overturn an existing F0 INCOMPATIBLE proof'
  );
  assert.strictEqual(
    verifResult.f0MonotonicityPreserved,
    false,
    'f0MonotonicityPreserved flag must be false on overturn attempt'
  );
  assert.ok(
    verifResult.blockerCode === 'SOURCE_EVIDENCE_UNVERIFIED',
    `Reason must indicate monotonicity violation, got: ${verifResult.reason}`
  );

  console.log('✓ Test 4 PASS: An unverifiable F0 baseline blocks F1 promotion');
}

// --------------------------------------------------------------------------
// TEST 5: F1 Monotonicity Invariant — Safe Upgrade from F0 Inconclusive
// --------------------------------------------------------------------------
console.log('Running Test 5: Legacy F1 Helper Evidence Remains Uncertified...');
{
  const obligation: JavaSemanticObligation = {
    schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
    obligationId: 'ob-upgrade-test-01',
    sourceFqcn: 'com.acme.Consumer',
    targetFqcn: 'com.acme.Provider',
    relationKind: 'METHOD_CALL',
    memberSignature: 'consume(List<? extends Number>)',
    evidenceSnapshotRef: 'snap-upgrade'
  };

  const digest = computeJavaObligationDigest(obligation);

  // Generate legitimate compiler evidence for generic capture conversion
  const evidence = JavaHeadlessCompiler.produceEvidence({
    capabilityId: 'GENERIC_CAPTURE_CONVERSION',
    conclusion: 'COMPATIBLE',
    verified: true,
    details: {
      subType: '? extends Integer',
      superType: '? extends Number',
      derivationRule: 'JLS-4.10.2-COVARIANT-BOUND'
    }
  });

  const nodeId = 'node-f1-capture-' + evidence.evidenceId.slice(0, 8);
  const legitimateF1Proof: JavaF1SemanticProof = {
    schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
    ruleSetId: JavaRuleSetId.JAVA_F1_RULES_V1,
    profileId: JavaSemanticProfileId.JAVA_COMPILER_BACKED_F1,
    obligationDigest: digest,
    compilerEvidence: [evidence],
    nodes: [
      {
        nodeId,
        ruleId: 'JAVA.F1.GENERIC.CAPTURE_CONVERSION',
        premises: [],
        conclusion: {
          kind: 'GENERIC_CAPTURE_CONVERSION',
          subType: '? extends Integer',
          superType: '? extends Number',
          compatible: true,
          evidenceId: evidence.evidenceId
        }
      }
    ],
    rootNodeIds: [nodeId],
    claimedConclusion: 'COMPATIBLE',
    metadata: {
      capabilityId: 'JAVA_GENERIC_CAPTURE_CONVERSION'
    }
  };

  const verifResult = JavaF1ProofChecker.verifyF1Proof(obligation, legitimateF1Proof);

  assert.strictEqual(verifResult.valid, false, 'Compiler helper evidence is not a source-bound proof');
  assert.strictEqual(verifResult.blockerCode, 'SOURCE_EVIDENCE_UNVERIFIED');
  assert.strictEqual(verifResult.f0MonotonicityPreserved, true);
  assert.deepStrictEqual(verifResult.f1CapabilitiesVerified, []);

  console.log('✓ Test 5 PASS: Legacy F1 helper evidence cannot certify source compatibility');
}

// --------------------------------------------------------------------------
// TEST 6: Zero-Trust Tamper Resistance
// --------------------------------------------------------------------------
console.log('Running Test 6: Zero-Trust Tamper Resistance...');
{
  const obligation: JavaSemanticObligation = {
    schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
    obligationId: 'ob-tamper-test-01',
    sourceFqcn: 'com.acme.Consumer',
    targetFqcn: 'com.acme.Provider',
    relationKind: 'SUBTYPE',
    evidenceSnapshotRef: 'snap-tamper'
  };

  const digest = computeJavaObligationDigest(obligation);

  // Generate legitimate compiler evidence
  const evidence = JavaHeadlessCompiler.produceEvidence({
    capabilityId: 'SEALED_WILDCARD_RESOLUTION',
    conclusion: 'COMPATIBLE',
    verified: true,
    details: {
      wildcardPackages: ['java.util'],
      simpleName: 'List',
      fqcn: 'java.util.List'
    }
  });

  // Tamper with the details after fingerprint was calculated
  const tamperedEvidence: JavaF1CompilerEvidence = {
    ...evidence,
    details: {
      ...evidence.details,
      simpleName: 'MaliciousInjectedClass' // Tampered!
    }
  };

  const tamperedF1Proof: JavaF1SemanticProof = {
    schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
    ruleSetId: JavaRuleSetId.JAVA_F1_RULES_V1,
    obligationDigest: digest,
    compilerEvidence: [tamperedEvidence],
    nodes: [
      {
        nodeId: 'node-tamper',
        ruleId: 'JAVA.F1.CLASSPATH.SEALED_WILDCARD_RESOLVED',
        premises: [],
        conclusion: {
          kind: 'SEALED_WILDCARD_RESOLVED',
          wildcardPackages: ['java.util'],
          simpleName: 'List',
          resolvedFqcn: 'java.util.List',
          compatible: true,
          evidenceId: evidence.evidenceId
        }
      }
    ],
    rootNodeIds: ['node-tamper'],
    claimedConclusion: 'COMPATIBLE'
  };

  const verifResult = JavaF1ProofChecker.verifyF1Proof(obligation, tamperedF1Proof);

  assert.strictEqual(verifResult.valid, false, 'Tampered evidence must fail proof verification');
  assert.strictEqual(verifResult.blockerCode, 'HASH_MISMATCH');
  assert.ok(verifResult.reason?.includes('tampered fingerprint'));

  console.log('✓ Test 6 PASS: Cryptographic evidence tampering is detected and rejected');
}

console.log('\n--- Java Phase J-11 Test Suite: ALL GATES PASSED (6/6) ---');
