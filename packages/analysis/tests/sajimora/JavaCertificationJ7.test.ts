/**
 * @file JavaCertificationJ7.test.ts
 * Comprehensive test suite for Phase J-7 (Java Certification Evaluation & F0 Profile).
 *
 * Verifies:
 * 1. Java Certified F0 Profile admission and boundary policies (explicit FQCN vs wildcards/reflection).
 * 2. Closed JavaRuleRegistry evaluators for nominal typing, subtyping, and signature preservation.
 * 3. JavaProofProducer deterministic DAG generation and boundary refusal.
 * 4. JavaProofChecker zero-trust verification and independent recomputation.
 * 5. Hostile tampering resistance (cycles, forged conclusions, obligation mismatch, rule spoofing).
 * 6. End-to-end JavaCertificationEvaluator across 7 mandatory promotion prerequisites.
 * 7. Deterministic replay and bit-for-bit stability.
 * 8. Strict language boundary isolation (zero contamination with TypeScript certified paths).
 */

import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import {
  JAVA_CERTIFIED_EVIDENCE_V1,
  JavaSemanticProfileId,
  JavaRuleSetId,
  evaluateJavaF0Admission,
  JavaRuleRegistry,
  JavaProofNode,
  JavaProofChecker,
  JavaSemanticObligation,
  JavaSemanticProof,
  computeJavaObligationDigest,
  JavaProofProducer,
  JavaCertificationEvaluator,
  JavaClassDeclIR,
  JavaMethodSignatureIR,
  JavaFieldIR,
  JavaPrimitiveTypeIR,
  JavaReferenceTypeIR
} from '../../src/sajimora/languages/java';

console.log('--- Starting Java Phase J-7 Test Suite (Certification Evaluation & F0 Profile) ---');

function mkPrimitive(kind: string): JavaPrimitiveTypeIR {
  const hash = crypto.createHash('sha256').update(`primitive:${kind}`).digest('hex');
  return {
    kind: 'JAVA_PRIMITIVE',
    primitiveKind: kind as any,
    display: kind,
    schemaVersion: 'SAJIMORA_JAVA_TYPE_IR_V1',
    irContentHash: hash
  };
}

function mkRef(fqcn: string): JavaReferenceTypeIR {
  const hash = crypto.createHash('sha256').update(`ref:${fqcn}`).digest('hex');
  return {
    kind: 'JAVA_REFERENCE',
    qualifiedName: fqcn,
    simpleName: fqcn.split('.').pop() ?? fqcn,
    isFullyQualified: fqcn.includes('.'),
    typeArguments: [],
    display: fqcn,
    schemaVersion: 'SAJIMORA_JAVA_TYPE_IR_V1',
    irContentHash: hash
  };
}

function mkMethod(
  name: string,
  returnType: any,
  params: Array<{ name: string; type: any }>,
  visibility: 'public' | 'protected' | 'package-private' | 'private' = 'public'
): JavaMethodSignatureIR {
  const paramIRs = params.map(p => ({
    name: p.name,
    type: p.type,
    isVararg: false,
    isFinal: false,
    annotations: []
  }));
  const hash = crypto.createHash('sha256').update(`method:${name}:${visibility}:${params.length}`).digest('hex');
  return {
    name,
    returnType,
    parameters: paramIRs,
    typeParameters: [],
    visibility,
    isStatic: false,
    isFinal: false,
    isAbstract: false,
    isConstructor: false,
    isDeclaredOverride: false,
    annotations: [],
    lineStart: 10,
    lineEnd: 20,
    declarationOrdinal: 0,
    irContentHash: hash
  };
}

function mkField(
  name: string,
  type: any,
  visibility: 'public' | 'protected' | 'package-private' | 'private' = 'public',
  isFinal: boolean = false
): JavaFieldIR {
  const hash = crypto.createHash('sha256').update(`field:${name}:${visibility}:${isFinal}`).digest('hex');
  return {
    name,
    type,
    visibility,
    isStatic: false,
    isFinal,
    isVolatile: false,
    isTransient: false,
    annotations: [],
    line: 5,
    irContentHash: hash
  };
}

function mkClass(
  fqcn: string,
  methods: JavaMethodSignatureIR[] = [],
  fields: JavaFieldIR[] = [],
  extendsName?: string,
  implementsNames: string[] = []
): JavaClassDeclIR {
  const parts = fqcn.split('.');
  const simpleName = parts.pop() ?? fqcn;
  const packageName = parts.join('.');
  return {
    name: simpleName,
    fqcn,
    simpleName,
    binaryName: fqcn,
    packageName,
    kind: 'class',
    extendsName,
    implementsNames,
    fields,
    methods,
    annotations: [],
    isExported: true,
    lineStart: 1,
    lineEnd: 100,
    filePath: `src/${fqcn.replace(/\./g, '/')}.java`
  };
}

// --------------------------------------------------------------------------
// TEST 1: Java Certified Profile F0 Admission & Boundary Enforcement
// --------------------------------------------------------------------------
console.log('Running Test 1: Certified Profile F0 Admission & Boundary Enforcement...');
{
  // 1a: Clean file with explicit single-type imports
  const cleanAdmission = evaluateJavaF0Admission({
    path: 'src/com/acme/OrderService.java',
    packageName: 'com.acme',
    imports: ['java.util.List', 'java.util.Map', 'com.acme.models.Order'],
    content: 'package com.acme;\npublic class OrderService { public void process() {} }'
  });
  assert.strictEqual(cleanAdmission.admitted, true, 'Clean file must be admitted to F0');
  assert.strictEqual(cleanAdmission.status, 'ADMITTED_F0');
  assert.strictEqual(cleanAdmission.profileId, JavaSemanticProfileId.JAVA_PUBLIC_API_F0);
  assert.strictEqual(cleanAdmission.disqualificationReasons.length, 0);

  // 1b: Wildcard import disqualification
  const wildcardAdmission = evaluateJavaF0Admission({
    path: 'src/com/acme/OrderService.java',
    packageName: 'com.acme',
    imports: ['java.util.*', 'com.acme.models.Order'],
    content: 'package com.acme;\npublic class OrderService {}'
  });
  assert.strictEqual(wildcardAdmission.admitted, false, 'Wildcard import must be disqualified from F0');
  assert.strictEqual(wildcardAdmission.status, 'DISQUALIFIED_ADVISORY_ONLY');
  assert.strictEqual(wildcardAdmission.profileId, null);
  assert.ok(wildcardAdmission.disqualificationReasons[0].includes('Wildcard import(s) detected'));

  // 1c: Reflection / Dynamic proxy disqualification (J-X1..J-X3)
  const reflectionAdmission = evaluateJavaF0Admission({
    path: 'src/com/acme/DynamicPlugin.java',
    packageName: 'com.acme',
    imports: ['java.lang.reflect.Method'],
    content: 'package com.acme;\npublic class DynamicPlugin { void run() { Class.forName("foo"); } }'
  });
  assert.strictEqual(reflectionAdmission.admitted, false, 'Reflection must be disqualified from F0');
  assert.strictEqual(reflectionAdmission.status, 'DISQUALIFIED_ADVISORY_ONLY');
  assert.ok(reflectionAdmission.disqualificationReasons.some(r => r.includes('Undecidable dynamic construct')));

  console.log('✓ Test 1 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 2: Closed JavaRuleRegistry Rule Evaluators
// --------------------------------------------------------------------------
console.log('Running Test 2: Closed JavaRuleRegistry Rule Evaluators...');
{
  // 2a: Nominal equality
  const eqNode: JavaProofNode = {
    nodeId: 'n1',
    ruleId: 'JAVA.F0.NOMINAL.EQUAL',
    premises: [],
    conclusion: {
      kind: 'NOMINAL_EQUAL',
      sourceFqcn: 'java.lang.String',
      targetFqcn: 'java.lang.String',
      compatible: true
    }
  };
  const eqRes = JavaRuleRegistry.evaluate(eqNode, new Map());
  assert.strictEqual(eqRes.valid, true);
  assert.strictEqual(eqRes.computedConclusion?.compatible, true);

  // 2b: Primitive widening
  const widenNode: JavaProofNode = {
    nodeId: 'n2',
    ruleId: 'JAVA.F0.NOMINAL.PRIMITIVE_WIDENING',
    premises: [],
    conclusion: {
      kind: 'PRIMITIVE_WIDENING',
      fromPrimitive: 'int',
      toPrimitive: 'long',
      compatible: true
    }
  };
  const widenRes = JavaRuleRegistry.evaluate(widenNode, new Map());
  assert.strictEqual(widenRes.valid, true);

  // 2c: Illegal narrowing recomputation fails
  const narrowNode: JavaProofNode = {
    nodeId: 'n3',
    ruleId: 'JAVA.F0.NOMINAL.PRIMITIVE_WIDENING',
    premises: [],
    conclusion: {
      kind: 'PRIMITIVE_WIDENING',
      fromPrimitive: 'long',
      toPrimitive: 'int',
      compatible: true // falsely claimed!
    }
  };
  const narrowRes = JavaRuleRegistry.evaluate(narrowNode, new Map());
  assert.strictEqual(narrowRes.valid, false, 'Narrowing claimed compatible must fail');

  // 2d: Transitive subtyping
  const p1: JavaProofNode = {
    nodeId: 'p1',
    ruleId: 'JAVA.F0.NOMINAL.SUBTYPE',
    premises: [],
    conclusion: { kind: 'NOMINAL_SUBTYPE', subFqcn: 'com.acme.Dog', superFqcn: 'com.acme.Canine', compatible: true }
  };
  const p2: JavaProofNode = {
    nodeId: 'p2',
    ruleId: 'JAVA.F0.NOMINAL.SUBTYPE',
    premises: [],
    conclusion: { kind: 'NOMINAL_SUBTYPE', subFqcn: 'com.acme.Canine', superFqcn: 'com.acme.Animal', compatible: true }
  };
  const transNode: JavaProofNode = {
    nodeId: 'trans1',
    ruleId: 'JAVA.F0.REL.EXTENDS_TRANSITIVE',
    premises: ['p1', 'p2'],
    conclusion: { kind: 'NOMINAL_SUBTYPE', subFqcn: 'com.acme.Dog', superFqcn: 'com.acme.Animal', compatible: true }
  };
  const premisesMap = new Map([['p1', p1], ['p2', p2]]);
  const transRes = JavaRuleRegistry.evaluate(transNode, premisesMap);
  assert.strictEqual(transRes.valid, true);
  assert.strictEqual(transRes.computedConclusion?.superFqcn, 'com.acme.Animal');

  // 2e: Method signature preservation
  const methodNode: JavaProofNode = {
    nodeId: 'm1',
    ruleId: 'JAVA.F0.METHOD.SIGNATURE_PRESERVED',
    premises: ['p1'],
    conclusion: {
      kind: 'METHOD_SIGNATURE_PRESERVED',
      methodName: 'getAnimal',
      historicalVisibility: 'PUBLIC',
      candidateVisibility: 'PUBLIC',
      parameterCount: 0,
      compatible: true
    }
  };
  const methodRes = JavaRuleRegistry.evaluate(methodNode, new Map([['p1', p1]]));
  assert.strictEqual(methodRes.valid, true);

  // 2f: Visibility narrowing in method fails
  const methodNarrowVis: JavaProofNode = {
    nodeId: 'm2',
    ruleId: 'JAVA.F0.METHOD.SIGNATURE_PRESERVED',
    premises: [],
    conclusion: {
      kind: 'METHOD_SIGNATURE_PRESERVED',
      methodName: 'run',
      historicalVisibility: 'PUBLIC',
      candidateVisibility: 'PRIVATE',
      parameterCount: 0,
      compatible: true // claiming narrowing is compatible must fail
    }
  };
  const methodNarrowRes = JavaRuleRegistry.evaluate(methodNarrowVis, new Map());
  assert.strictEqual(methodNarrowRes.valid, false, 'Method visibility narrowing cannot be compatible');

  // 2g: Closed rule registry: unknown rule fails
  const unknownRuleNode: JavaProofNode = {
    nodeId: 'u1',
    ruleId: 'JAVA.F0.STRUCTURAL.DUCK_TYPING',
    premises: [],
    conclusion: { kind: 'UNKNOWN', compatible: true }
  };
  const unknownRes = JavaRuleRegistry.evaluate(unknownRuleNode, new Map());
  assert.strictEqual(unknownRes.valid, false);
  assert.ok(unknownRes.reason?.includes('not registered'));

  console.log('✓ Test 2 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 3: JavaProofProducer Generation & Boundary Refusal
// --------------------------------------------------------------------------
console.log('Running Test 3: JavaProofProducer Generation & Boundary Refusal...');
{
  const stringType = mkRef('java.lang.String');
  const intType = mkPrimitive('int');

  const histMethod = mkMethod('calculate', intType, [{ name: 'val', type: stringType }]);
  const candMethodPreserved = mkMethod('calculate', intType, [{ name: 'val', type: stringType }]);

  const histClass = mkClass('com.acme.Calculator', [histMethod]);
  const candClassPreserved = mkClass('com.acme.Calculator', [candMethodPreserved]);
  const candClassRemoved = mkClass('com.acme.Calculator', []); // method removed

  const obligation: JavaSemanticObligation = {
    schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
    obligationId: 'ob-calc-1',
    sourceFqcn: 'com.acme.Consumer',
    targetFqcn: 'com.acme.Calculator',
    relationKind: 'METHOD_CALL',
    memberSignature: 'calculate(java.lang.String)',
    evidenceSnapshotRef: 'snapshot-git-tree-abc'
  };

  // 3a: Compatible preservation proof
  const preservedRes = JavaProofProducer.produceProof({
    obligation,
    historicalClass: histClass,
    candidateClass: candClassPreserved
  });
  assert.strictEqual(preservedRes.success, true);
  assert.strictEqual(preservedRes.proof?.claimedConclusion, 'COMPATIBLE');
  assert.strictEqual(preservedRes.proof?.schemaVersion, JAVA_CERTIFIED_EVIDENCE_V1);
  assert.strictEqual(preservedRes.proof?.ruleSetId, JavaRuleSetId.JAVA_F0_RULES_V1);

  // 3b: Breaking removal proof
  const removedRes = JavaProofProducer.produceProof({
    obligation,
    historicalClass: histClass,
    candidateClass: candClassRemoved
  });
  assert.strictEqual(removedRes.success, true);
  assert.strictEqual(removedRes.proof?.claimedConclusion, 'INCOMPATIBLE');

  // 3c: Boundary refusal when wildcards are present
  const wildcardRes = JavaProofProducer.produceProof({
    obligation,
    historicalClass: histClass,
    candidateClass: candClassPreserved,
    hasWildcardImports: true
  });
  assert.strictEqual(wildcardRes.success, false);
  assert.strictEqual(wildcardRes.refused, true);
  assert.ok(wildcardRes.reason?.includes('Wildcard import detected'));

  // 3d: Boundary refusal when reflection is present
  const reflectionRes = JavaProofProducer.produceProof({
    obligation,
    historicalClass: histClass,
    candidateClass: candClassPreserved,
    hasDynamicReflection: true
  });
  assert.strictEqual(reflectionRes.success, false);
  assert.strictEqual(reflectionRes.refused, true);
  assert.ok(reflectionRes.reason?.includes('Dynamic reflection construct'));

  console.log('✓ Test 3 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 4: JavaProofChecker Zero-Trust Verification
// --------------------------------------------------------------------------
console.log('Running Test 4: JavaProofChecker Zero-Trust Verification...');
{
  const stringType = mkRef('java.lang.String');
  const intType = mkPrimitive('int');
  const histMethod = mkMethod('calculate', intType, [{ name: 'val', type: stringType }]);
  const candMethod = mkMethod('calculate', intType, [{ name: 'val', type: stringType }]);
  const histClass = mkClass('com.acme.Calculator', [histMethod]);
  const candClass = mkClass('com.acme.Calculator', [candMethod]);

  const obligation: JavaSemanticObligation = {
    schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
    obligationId: 'ob-check-1',
    sourceFqcn: 'com.acme.Consumer',
    targetFqcn: 'com.acme.Calculator',
    relationKind: 'METHOD_CALL',
    memberSignature: 'calculate(java.lang.String)',
    evidenceSnapshotRef: 'snapshot-git-tree-abc'
  };

  const prodResult = JavaProofProducer.produceProof({
    obligation,
    historicalClass: histClass,
    candidateClass: candClass
  });
  assert.ok(prodResult.proof);

  // Independent verification
  const verifResult = JavaProofChecker.verify(obligation, prodResult.proof);
  assert.strictEqual(verifResult.valid, false, 'Legacy DAGs lack source-bound facts');
  assert.strictEqual(verifResult.blockerCode, 'SOURCE_EVIDENCE_UNVERIFIED');
  assert.ok((verifResult.validatedNodeCount ?? 0) > 0);

  // Verify removed method proof
  const candClassRemoved = mkClass('com.acme.Calculator', []);
  const removedProdResult = JavaProofProducer.produceProof({
    obligation,
    historicalClass: histClass,
    candidateClass: candClassRemoved
  });
  assert.ok(removedProdResult.proof);
  const removedVerifResult = JavaProofChecker.verify(obligation, removedProdResult.proof);
  assert.strictEqual(removedVerifResult.valid, false);
  assert.strictEqual(removedVerifResult.blockerCode, 'SOURCE_EVIDENCE_UNVERIFIED');

  console.log('✓ Test 4 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 5: Hostile Tampering & Adversarial Attack Resistance on ProofChecker
// --------------------------------------------------------------------------
console.log('Running Test 5: Hostile Tampering Attacks on JavaProofChecker...');
{
  const obligation: JavaSemanticObligation = {
    schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
    obligationId: 'ob-adv-1',
    sourceFqcn: 'com.acme.HostileTest',
    targetFqcn: 'com.acme.Target',
    relationKind: 'SUBTYPE',
    evidenceSnapshotRef: 'snapshot-123'
  };
  const expectedDigest = computeJavaObligationDigest(obligation);

  // 5a: Cycle Injection Attack
  const cyclicProof: JavaSemanticProof = {
    schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
    ruleSetId: JavaRuleSetId.JAVA_F0_RULES_V1,
    obligationDigest: expectedDigest,
    nodes: [
      {
        nodeId: 'cycle_a',
        ruleId: 'JAVA.F0.NOMINAL.EQUAL',
        premises: ['cycle_b'],
        conclusion: { kind: 'NOMINAL_EQUAL', sourceFqcn: 'A', targetFqcn: 'A', compatible: true }
      },
      {
        nodeId: 'cycle_b',
        ruleId: 'JAVA.F0.NOMINAL.EQUAL',
        premises: ['cycle_a'],
        conclusion: { kind: 'NOMINAL_EQUAL', sourceFqcn: 'A', targetFqcn: 'A', compatible: true }
      }
    ],
    rootNodeIds: ['cycle_a'],
    claimedConclusion: 'COMPATIBLE'
  };
  const cycleRes = JavaProofChecker.verify(obligation, cyclicProof);
  assert.strictEqual(cycleRes.valid, false, 'Cyclic proof must be rejected');
  assert.strictEqual(cycleRes.blockerCode, 'PROOF_CYCLE_DETECTED');

  // 5b: Forged Conclusion Attack (tampering compatible boolean)
  const forgedProof: JavaSemanticProof = {
    schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
    ruleSetId: JavaRuleSetId.JAVA_F0_RULES_V1,
    obligationDigest: expectedDigest,
    nodes: [
      {
        nodeId: 'n_forged',
        ruleId: 'JAVA.F0.NOMINAL.EQUAL',
        premises: [],
        conclusion: {
          kind: 'NOMINAL_EQUAL',
          sourceFqcn: 'com.acme.ClassA',
          targetFqcn: 'com.acme.ClassB', // DIFFERENT FQCNs!
          compatible: true // FORGER claims they are compatible
        }
      }
    ],
    rootNodeIds: ['n_forged'],
    claimedConclusion: 'COMPATIBLE'
  };
  const forgedRes = JavaProofChecker.verify(obligation, forgedProof);
  assert.strictEqual(forgedRes.valid, false, 'Forged conclusion must be rejected');
  assert.strictEqual(forgedRes.blockerCode, 'CONCLUSION_MISMATCH');

  // 5c: Obligation Transplant / Digest Mismatch Attack
  const foreignObligation: JavaSemanticObligation = {
    ...obligation,
    targetFqcn: 'com.other.AttackerClass'
  };
  const validProofForOriginal = JavaProofProducer.produceProof({
    obligation,
    historicalClass: mkClass('com.acme.Target'),
    candidateClass: mkClass('com.acme.Target')
  }).proof!;
  const transplantRes = JavaProofChecker.verify(foreignObligation, validProofForOriginal);
  assert.strictEqual(transplantRes.valid, false, 'Obligation digest mismatch must be rejected');
  assert.strictEqual(transplantRes.blockerCode, 'HASH_MISMATCH');

  // 5d: Unregistered Rule Injection Attack
  const unknownRuleProof: JavaSemanticProof = {
    schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
    ruleSetId: JavaRuleSetId.JAVA_F0_RULES_V1,
    obligationDigest: expectedDigest,
    nodes: [
      {
        nodeId: 'n_unknown',
        ruleId: 'EXPLOIT.ARBITRARY.ACCEPT',
        premises: [],
        conclusion: { kind: 'EXPLOIT', compatible: true }
      }
    ],
    rootNodeIds: ['n_unknown'],
    claimedConclusion: 'COMPATIBLE'
  };
  const unknownRes = JavaProofChecker.verify(obligation, unknownRuleProof);
  assert.strictEqual(unknownRes.valid, false, 'Unknown rule must be rejected');
  assert.strictEqual(unknownRes.blockerCode, 'INVALID_RULE_APPLICATION');

  // 5e: Missing Premise Attack
  const missingPremiseProof: JavaSemanticProof = {
    schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
    ruleSetId: JavaRuleSetId.JAVA_F0_RULES_V1,
    obligationDigest: expectedDigest,
    nodes: [
      {
        nodeId: 'n_parent',
        ruleId: 'JAVA.F0.METHOD.SIGNATURE_PRESERVED',
        premises: ['non_existent_premise_id'],
        conclusion: {
          kind: 'METHOD_SIGNATURE_PRESERVED',
          methodName: 'run',
          compatible: true
        }
      }
    ],
    rootNodeIds: ['n_parent'],
    claimedConclusion: 'COMPATIBLE'
  };
  const missingPremiseRes = JavaProofChecker.verify(obligation, missingPremiseProof);
  assert.strictEqual(missingPremiseRes.valid, false, 'Missing premise must be rejected');
  assert.strictEqual(missingPremiseRes.blockerCode, 'PREMISE_NOT_SATISFIED');

  // 5f: Resource Budget Exhaustion Attack (exceeding node limit)
  const budgetRes = JavaProofChecker.verify(obligation, validProofForOriginal, { maxNodes: 0 });
  assert.strictEqual(budgetRes.valid, false, 'Exceeded node count must be rejected');
  assert.strictEqual(budgetRes.blockerCode, 'RESOURCE_EXHAUSTED');

  console.log('✓ Test 5 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 6: End-to-End JavaCertificationEvaluator Across 7 Prerequisites
// --------------------------------------------------------------------------
console.log('Running Test 6: JavaCertificationEvaluator Across 7 Prerequisites...');
{
  const stringType = mkRef('java.lang.String');
  const histMethod = mkMethod('processOrder', stringType, []);
  const candMethod = mkMethod('processOrder', stringType, []);
  const histClass = mkClass('com.acme.OrderProcessor', [histMethod]);
  const candClass = mkClass('com.acme.OrderProcessor', [candMethod]);

  const obligation: JavaSemanticObligation = {
    schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
    obligationId: 'ob-eval-1',
    sourceFqcn: 'com.acme.Controller',
    targetFqcn: 'com.acme.OrderProcessor',
    relationKind: 'METHOD_CALL',
    memberSignature: 'processOrder()',
    evidenceSnapshotRef: 'snapshot-ref-456'
  };

  // 6a: Fully compliant F0 repository promotion
  const promotionReport = JavaCertificationEvaluator.evaluate({
    candidateId: 'repo-acme-core',
    files: [
      {
        path: 'src/com/acme/OrderProcessor.java',
        packageName: 'com.acme',
        imports: ['java.lang.String'],
        classes: [candClass],
        content: 'package com.acme;\npublic class OrderProcessor { public String processOrder() { return ""; } }'
      }
    ],
    historicalClasses: [histClass],
    candidateClasses: [candClass],
    obligations: [obligation],
    benchmarkMetrics: {
      consumerDiscoveryRecall: 100.0,
      falsePositiveRate: 0.0,
      falseNegativeRate: 0.0,
      deterministicRepeatability: 100.0
    },
    adversarialSuitePassed: true
  });

  assert.strictEqual(promotionReport.certificationOutcome, 'RETAINED_IN_ADVISORY');
  assert.strictEqual(promotionReport.admittedProfileId, null);
  assert.strictEqual(promotionReport.prerequisites.sealedEvidence.satisfied, false);
  assert.strictEqual(promotionReport.prerequisites.deterministicReplay.satisfied, true);
  assert.strictEqual(promotionReport.prerequisites.independentlyVerifiableResolution.satisfied, true);
  assert.strictEqual(promotionReport.prerequisites.completeConsumerCoverage.satisfied, false);
  assert.strictEqual(promotionReport.prerequisites.explicitProofRules.satisfied, false);
  assert.strictEqual(promotionReport.prerequisites.adversarialTests.satisfied, true);
  assert.strictEqual(promotionReport.prerequisites.stableBenchmark.satisfied, true);
  assert.strictEqual(promotionReport.admittedCapabilities.length, 0);

  // 6b: Repository with wildcard imports retained in advisory mode
  const wildcardReport = JavaCertificationEvaluator.evaluate({
    candidateId: 'repo-acme-wildcard',
    files: [
      {
        path: 'src/com/acme/OrderProcessor.java',
        packageName: 'com.acme',
        imports: ['java.util.*'],
        classes: [candClass],
        content: 'package com.acme;\nimport java.util.*;\npublic class OrderProcessor {}'
      }
    ],
    historicalClasses: [histClass],
    candidateClasses: [candClass],
    obligations: [obligation]
  });
  assert.strictEqual(wildcardReport.certificationOutcome, 'RETAINED_IN_ADVISORY');
  assert.strictEqual(wildcardReport.admittedProfileId, null);
  assert.strictEqual(wildcardReport.prerequisites.independentlyVerifiableResolution.satisfied, false);

  // 6c: Markdown Summary rendering
  const mdSummary = JavaCertificationEvaluator.renderMarkdownSummary(promotionReport);
  assert.ok(mdSummary.includes('# Sajimora Java Certification Audit Report (Phase J-7)'));
  assert.ok(mdSummary.includes('RETAINED_IN_ADVISORY'));
  assert.ok(mdSummary.includes('NONE (Advisory Only)'));

  console.log('✓ Test 6 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 7: Deterministic Replay & Order-Invariance
// --------------------------------------------------------------------------
console.log('Running Test 7: Deterministic Replay & Order-Invariance...');
{
  const obligation: JavaSemanticObligation = {
    schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
    obligationId: 'ob-det-1',
    sourceFqcn: 'com.acme.Consumer',
    targetFqcn: 'com.acme.Service',
    relationKind: 'METHOD_CALL',
    memberSignature: 'execute()',
    evidenceSnapshotRef: 'snapshot-git-tree-100'
  };

  const digest1 = computeJavaObligationDigest(obligation);
  const digest2 = computeJavaObligationDigest(obligation);
  assert.strictEqual(digest1, digest2, 'Obligation digests must be bit-for-bit identical');

  const hist = mkClass('com.acme.Service', [mkMethod('execute', mkPrimitive('void'), [])]);
  const cand = mkClass('com.acme.Service', [mkMethod('execute', mkPrimitive('void'), [])]);

  const p1 = JavaProofProducer.produceProof({ obligation, historicalClass: hist, candidateClass: cand });
  const p2 = JavaProofProducer.produceProof({ obligation, historicalClass: hist, candidateClass: cand });

  assert.strictEqual(
    JSON.stringify(p1.proof),
    JSON.stringify(p2.proof),
    'Repeated proof generation must be bit-for-bit identical'
  );

  console.log('✓ Test 7 passed cleanly');
}

// --------------------------------------------------------------------------
// TEST 8: Strict Isolation Verification
// --------------------------------------------------------------------------
console.log('Running Test 8: Strict Language Boundary Isolation...');
{
  // Verify Java certified profile does not touch VerdictAuthority or TypeScript rules
  assert.strictEqual(JavaRuleRegistry.ruleSetId, 'JAVA_F0_RULES_V1');
  assert.notStrictEqual(JavaRuleRegistry.ruleSetId, 'F0_RULES_V1'); // Different from TS rule set
  assert.strictEqual(JAVA_CERTIFIED_EVIDENCE_V1, 'JAVA_CERTIFIED_EVIDENCE_V1');

  // Verify registered rules are all Java-prefixed
  for (const rule of JavaRuleRegistry.registeredRules()) {
    assert.ok(rule.startsWith('JAVA.F0.'), `Rule '${rule}' must be Java-scoped`);
  }

  console.log('✓ Test 8 passed cleanly');
}

console.log('--- ALL JAVA PHASE J-7 CERTIFICATION TESTS PASSED ---');
