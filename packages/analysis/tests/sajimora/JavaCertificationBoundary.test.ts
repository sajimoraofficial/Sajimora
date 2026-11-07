import * as assert from 'node:assert/strict';
import { JavaProofChecker, computeJavaObligationDigest, JavaSemanticObligation, JavaSemanticProof } from '../../src/sajimora/languages/java/certified/JavaProofChecker';
import { JAVA_CERTIFIED_EVIDENCE_V1, JavaRuleSetId } from '../../src/sajimora/languages/java/certified/JavaCertifiedProfile';
import { JavaCertificationEvaluator } from '../../src/sajimora/languages/java/certified/JavaCertificationEvaluator';
import { JavaF1ProofChecker } from '../../src/sajimora/languages/java/certified/JavaF1ProofChecker';
const ob: JavaSemanticObligation = { schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1, obligationId: 'arbitrary-obligation', sourceFqcn: 'example.A', targetFqcn: 'example.B', relationKind: 'SUBTYPE', evidenceSnapshotRef: 'snapshot' };
for (const [ruleId, conclusion] of [
  ['JAVA.F0.NOMINAL.SUBTYPE', { kind: 'NOMINAL_SUBTYPE', subFqcn: 'example.A', superFqcn: 'example.B', compatible: true }],
  ['JAVA.F0.NOMINAL.EQUAL', { kind: 'NOMINAL_EQUAL', sourceFqcn: 'unrelated.X', targetFqcn: 'unrelated.X', compatible: true }],
  ['JAVA.F0.NOMINAL.EQUAL', { kind: 'NOMINAL_EQUAL', sourceFqcn: 'unrelated.X', targetFqcn: 'unrelated.Y', compatible: false }]
] as const) {
  const proof: JavaSemanticProof = { schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1, ruleSetId: JavaRuleSetId.JAVA_F0_RULES_V1,
    obligationDigest: computeJavaObligationDigest(ob), nodes: [{ nodeId: 'root', ruleId, premises: [], conclusion }], rootNodeIds: ['root'], claimedConclusion: conclusion.compatible ? 'COMPATIBLE' : 'INCOMPATIBLE' };
  const checked = JavaProofChecker.verify(ob, proof);
  assert.equal(checked.valid, false, 'Neither forged positive nor forged negative proof may certify');
  assert.equal(checked.verifiedConclusion, undefined);
}
const report = JavaCertificationEvaluator.evaluate({ candidateId: 'arbitrary', files: [{ path: 'A.java', packageName: 'example', imports: [], content: 'package example; public class A {}' }] });
assert.equal(report.certificationOutcome, 'RETAINED_IN_ADVISORY');
for (const key of ['sealedEvidence', 'completeConsumerCoverage', 'deterministicReplay', 'explicitProofRules', 'adversarialTests', 'stableBenchmark'] as const) {
  assert.equal(report.prerequisites[key].satisfied, false, `Missing ${key} must not default to success`);
}
console.log('Java certification boundary: asserted inheritance, unrelated positive/negative roots and missing qualification evidence rejected.');
assert.equal(JavaF1ProofChecker.verifyF1Proof(ob, { schemaVersion: JAVA_CERTIFIED_EVIDENCE_V1,
  ruleSetId: JavaRuleSetId.JAVA_F1_RULES_V1, obligationDigest: computeJavaObligationDigest(ob),
  nodes: [], rootNodeIds: [], claimedConclusion: 'COMPATIBLE' }).valid, false, 'F1 cannot bypass source verification with an empty DAG');
