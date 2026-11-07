import { test } from 'node:test';
import * as assert from 'node:assert';
import { ProofProducer } from '../../../src/sajimora/certified/proof/ProofProducer';
import { ProofChecker } from '../../../src/sajimora/certified/proof/ProofChecker';
import { HistoricalObligationGenerator } from '../../../src/sajimora/certified/obligations/HistoricalObligationGenerator';
import { VerificationBudget } from '../../../src/sajimora/certified/proof/VerificationBudget';
import {
  INITIAL_RESOURCE_PROFILE,
  ArtifactDomain,
  SAJIMORA_CERTIFIED_EVIDENCE_V1
} from '../../../../core/src/sajimora/certified/protocol';
import { BlockerCode, ArtifactRef } from '../../../../core/src/sajimora/certified/blockers';
import { SemanticObligation, ProofNode } from '../../../../core/src/sajimora/certified/contracts';
import { CanonicalSet, computeDomainSeparatedHash } from '../../../../core/src/sajimora/certified/canonicalEncoding';

function createDummyObligation(source: any = { kind: 'primitive', name: 'string' }, target: any = { kind: 'primitive', name: 'string' }): SemanticObligation {
  const envRef: ArtifactRef = { domain: ArtifactDomain.MANIFEST, digest: '1'.repeat(64) };
  const targetRef: ArtifactRef = { domain: ArtifactDomain.SOURCE_BYTES, digest: '2'.repeat(64) };

  return {
    schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
    parentEnvironmentRef: envRef,
    candidateEnvironmentRef: envRef,
    targetIdentityEvidenceRef: targetRef,
    historicalOccurrenceAnchor: {
      projectId: 'p0',
      fileId: 'test.ts',
      utf16Start: 10,
      utf16End: 25,
      syntaxKind: 210
    },
    lifecycleEvidenceRef: targetRef,
    relevanceEvidenceRef: targetRef,
    contextKind: 'CALL_SITE',
    historicalEvidenceRefs: new CanonicalSet<ArtifactRef>([targetRef]),
    candidateEvidenceRefs: new CanonicalSet<ArtifactRef>([envRef]),
    parentValidityProofRef: targetRef,
    requiredRelations: new CanonicalSet<any>([
      {
        relationId: 'ARG_0',
        kind: 'PARAMETER_ACCEPTS_ARGUMENT',
        sourceTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef(source),
        targetTermRefOrNull: HistoricalObligationGenerator.termToArtifactRef(target),
        sourceTermValueOrNull: source,
        targetTermValueOrNull: target,
        position: '0',
        contextFactRefs: new CanonicalSet<any>([])
      }
    ])
  };
}

test('ProofProducer & ProofChecker Test Suite', async (t) => {
  const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);

  await t.test('successfully verifies sound COMPATIBLE proof', () => {
    const obligation = createDummyObligation({ kind: 'literal', value: 'hello' }, { kind: 'primitive', name: 'string' });
    const proof = ProofProducer.produceProof(obligation, {
      sourceScalar: { kind: 'literal', value: 'hello' },
      targetScalar: { kind: 'primitive', name: 'string' }
    });

    assert.strictEqual(proof.claimedConclusion, 'COMPATIBLE');

    const result = ProofChecker.verify(obligation, proof, budget);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.verifiedConclusion, 'COMPATIBLE');
  });

  await t.test('successfully verifies sound INCOMPATIBLE proof with refutation witness', () => {
    const obligation = createDummyObligation({ kind: 'primitive', name: 'string' }, { kind: 'primitive', name: 'number' });
    // Incompatible: source is string, target is number -> string <= number is false!
    const proof = ProofProducer.produceProof(obligation, {
      sourceScalar: { kind: 'primitive', name: 'string' },
      targetScalar: { kind: 'primitive', name: 'number' }
    });

    assert.strictEqual(proof.claimedConclusion, 'INCOMPATIBLE');

    const result = ProofChecker.verify(obligation, proof, budget);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.verifiedConclusion, 'INCOMPATIBLE');
    assert.ok(result.witness, 'Must contain refutation witness');
  });

  await t.test('detects and rejects proof cycle with PROOF_CYCLE_DETECTED', () => {
    const obligation = createDummyObligation();
    const proof = ProofProducer.produceProof(obligation);

    // Inject a cycle: nodeA -> nodeB -> nodeA
    const nodeAId = 'cycleA';
    const nodeBId = 'cycleB';

    const nodeA: ProofNode = {
      nodeId: nodeAId,
      ruleId: 'F0.REL.SCALAR',
      premises: [nodeBId],
      conclusion: { source: { kind: 'never' }, target: { kind: 'never' }, compatible: true }
    };

    const nodeB: ProofNode = {
      nodeId: nodeBId,
      ruleId: 'F0.REL.SCALAR',
      premises: [nodeAId],
      conclusion: { source: { kind: 'never' }, target: { kind: 'never' }, compatible: true }
    };

    const cyclicProof = {
      ...proof,
      nodes: new CanonicalSet<ProofNode>([...Array.from(proof.nodes), nodeA, nodeB]),
      rootNodeIds: new CanonicalSet<string>([nodeAId])
    };

    const result = ProofChecker.verify(obligation, cyclicProof, budget);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.blockerCode, BlockerCode.PROOF_CYCLE_DETECTED);
  });

  await t.test('rejects unrecognized rule ID with INVALID_RULE_APPLICATION', () => {
    const obligation = createDummyObligation();
    const proof = ProofProducer.produceProof(obligation);

    const forgedNode: ProofNode = {
      nodeId: 'forged_rule_node',
      ruleId: 'F0.UNKNOWN_MAGIC_RULE',
      premises: [],
      conclusion: { status: 'COMPATIBLE' }
    };

    // Fix node ID calculation to match content
    const realNodeId = ProofProducer.computeNodeId(forgedNode.ruleId, forgedNode.premises, forgedNode.conclusion);
    forgedNode.nodeId = realNodeId;

    const tamperedProof = {
      ...proof,
      nodes: new CanonicalSet<ProofNode>([forgedNode]),
      rootNodeIds: new CanonicalSet<string>([realNodeId])
    };

    const result = ProofChecker.verify(obligation, tamperedProof, budget);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.blockerCode, BlockerCode.INVALID_RULE_APPLICATION);
  });

  await t.test('rejects conclusion tampering with PREMISE_NOT_SATISFIED', () => {
    const obligation = createDummyObligation({ kind: 'primitive', name: 'string' }, { kind: 'primitive', name: 'number' });
    // Refuted relation: string <= number
    const proof = ProofProducer.produceProof(obligation, {
      sourceScalar: { kind: 'primitive', name: 'string' },
      targetScalar: { kind: 'primitive', name: 'number' }
    });

    // Producer fraudulently claims COMPATIBLE on an incompatible relation
    const tamperedProof = {
      ...proof,
      claimedConclusion: 'COMPATIBLE' as const
    };

    const result = ProofChecker.verify(obligation, tamperedProof, budget);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.blockerCode, BlockerCode.PREMISE_NOT_SATISFIED);
  });

  await t.test('rejects forged obligationRef with HASH_MISMATCH', () => {
    const obligation = createDummyObligation();
    const proof = ProofProducer.produceProof(obligation);

    const tamperedProof = {
      ...proof,
      obligationRef: {
        domain: ArtifactDomain.OBLIGATION,
        digest: 'f'.repeat(64)
      }
    };

    const result = ProofChecker.verify(obligation, tamperedProof, budget);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.blockerCode, BlockerCode.HASH_MISMATCH);
  });

  await t.test('enforces budget exhaustion with RESOURCE_EXHAUSTED', () => {
    const obligation = createDummyObligation();
    const proof = ProofProducer.produceProof(obligation);

    // Create a strict budget with maxProofNodes: 1
    const strictBudget = new VerificationBudget({
      ...INITIAL_RESOURCE_PROFILE,
      maxProofNodes: 1
    });

    assert.throws(
      () => ProofChecker.verify(obligation, proof, strictBudget),
      (err: any) => err.detail?.code === BlockerCode.RESOURCE_EXHAUSTED
    );
  });
});
